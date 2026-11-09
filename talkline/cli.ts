#!/usr/bin/env node
// talkline: the Claude Code bridge to Talk (Phase 0). Commands below; see talkline/README.md.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { constants, hostname } from 'node:os'
import { text as readAll } from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import { b64, deriveIdentity, newConvKeyBytes, safetyCode, unwrapConvKey, wrapConvKey } from '../src/lib/crypto.ts'
import type { Me } from '../shared/types.ts'
import { ask, cancel } from './ask.ts'
import { hook, idleSeconds, ourHooks, readSettings, SETTINGS, setHooks } from './hooks.ts'
import { api, call, CLI, connect, dmKey, file, limits, log, paired, patchProfile, readProfile, request, saveProfile, send, type Paired } from './talk.ts'

const USAGE = `Usage: node ${CLI} <command>
  pair <invite link> --owner <name> [--name "Claude AI"]
  notify <text> [--quiet]
  ask <question> [--detail <text>] [--risk low|high] [--urgent] [--ring-after <seconds>] [--expires <minutes>]
      prints yes, no or expired, and exits 0, 1 or 2 (128 + the signal if stopped, 130 for Ctrl+C)
  hooks install [--approvals] [--settings <path>]
  hooks uninstall [--settings <path>]
  hook notification|stop|permission [--expires <minutes>]   (Claude Code runs these)
  doctor [--settings <path>]
  stats
  unpair --yes
Any error exits 3.`

// macOS pipes are asynchronous: exit only after the write is done.
const write = (to: NodeJS.WriteStream, text: string) => new Promise<void>((r) => to.write(text, () => r()))
const print = (text: string) => write(process.stdout, text + '\n')

// Ctrl+C, a closed terminal, or Claude Code ending a hook. An open ask first closes itself (hangs up,
// marks the question Cancelled), for up to 1 s. process.exit runs the exit listeners that free inbox.lock and .pending.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.on(sig, () => {
    process.exitCode = 128 + constants.signals[sig]
    if (!cancel) process.exit()
    cancel()
    setTimeout(() => process.exit(), 1000).unref()
  })

async function main(): Promise<number> {
  const { values: o, positionals: [cmd, ...args] } = parseArgs({
    allowPositionals: true,
    options: {
      owner: { type: 'string' }, name: { type: 'string' }, detail: { type: 'string' }, risk: { type: 'string' },
      'ring-after': { type: 'string' }, expires: { type: 'string' }, settings: { type: 'string' },
      quiet: { type: 'boolean' }, urgent: { type: 'boolean' }, approvals: { type: 'boolean' }, yes: { type: 'boolean' },
    },
  })
  const settings = o.settings ?? SETTINGS
  switch (cmd) {
    case 'pair':
      return pair(args[0], o.owner, o.name ?? 'Claude AI')
    case 'notify': {
      if (!args.length) break
      const p = paired()
      const s = await connect(p)
      await send(s, p, await dmKey(p), { from: p.agent.id, text: args.join(' ') }, { quiet: o.quiet })
      s.close()
      return 0
    }
    case 'ask': {
      const risk = o.risk ?? 'high'
      const ringAfter = Number(o['ring-after'] ?? 180)
      const expires = Number(o.expires ?? 10)
      if (!args.length || (risk !== 'low' && risk !== 'high') || !(ringAfter >= 0)) break
      if (!(expires > 0 && expires <= 14))
        throw new Error('--expires takes minutes, more than 0 and at most 14: closing the question edits it, and Talk allows edits for 15 minutes.')
      const verdict = await ask(paired(), { question: args.join(' '), detail: o.detail, risk, urgent: !!o.urgent, ringAfter, expires, source: 'cli' })
      if (verdict === 'cancelled') return Number(process.exitCode)
      await print(verdict)
      return verdict === 'yes' ? 0 : verdict === 'no' ? 1 : 2
    }
    case 'hooks':
      if (args[0] !== 'install' && args[0] !== 'uninstall') break
      await print(setHooks(settings, args[0] === 'install' ? !!o.approvals : null))
      return 0
    case 'hook': {
      const event = args[0]
      if (event !== 'notification' && event !== 'stop' && event !== 'permission') break
      // Never break the user's session: errors go to the events log, stdout stays empty, exit 0. Claude Code
      // waits for Notification and Stop, so they get 3 s per request and 5 s in all; what they miss, the next run picks up.
      if (event !== 'permission') {
        limits.ms = 3000
        setTimeout(() => process.exit(0), 5000).unref()
      }
      try {
        const raw = await readAll(process.stdin) // decodes UTF-8 across chunk boundaries
        const out = await hook(event, JSON.parse(raw.trim() || '{}'), o.expires === undefined ? undefined : Number(o.expires))
        if (out) await print(out)
      } catch (e) {
        log('error', { where: `hook ${event}`, message: (e as Error).message })
      }
      return 0
    }
    case 'doctor':
      return doctor(settings)
    case 'stats':
      return stats()
    case 'unpair': {
      if (!o.yes) throw new Error('unpair deletes the agent account on the server and the local profile. Run unpair --yes to do it.')
      const p = readProfile()
      if (!p) throw new Error('Not paired.')
      await api(p, 'DELETE', '/api/me', { auth: p.agent.auth })
      rmSync(file('profile.json'))
      await print(`Deleted ${p.agent.name} from ${p.server}. Run hooks uninstall to remove the hooks.`)
      return 0
    }
  }
  throw new Error(USAGE)
}

async function pair(link: string | undefined, owner: string | undefined, name: string) {
  const url = URL.parse(link ?? '')
  const invite = url?.searchParams.get('invite')
  if (!url || !invite || !owner)
    throw new Error(`Usage: node ${CLI} pair <invite link> --owner <name> [--name "Claude AI"]\nMake the link in Talk: Settings > Create invite link.`)
  let p = readProfile()
  if (p?.owner) throw new Error(`Already paired as ${p.agent.name} with ${p.owner.name}. Run unpair first.`)
  // A profile without owner is an earlier run that registered, then failed: resume it (its invite is used up).
  const passphrase = p?.agent.passphrase ?? b64(crypto.getRandomValues(new Uint8Array(24)))
  const ident = await deriveIdentity(p?.agent.name ?? name, passphrase)
  if (!p) {
    const r = await call(url.origin, 'POST', '/api/register', { invite, name, pubkey: ident.publicKey, auth: ident.auth })
    if (r.status === 409) throw new Error(`The name ${name} is taken. Pick another with --name.`)
    if (r.status === 403) throw new Error('This invite is not valid or has expired.')
    if (r.status === 400) throw new Error(`Talk won't take the name "${name}": use 1 to 32 letters, digits, spaces, dots, dashes or underscores.`)
    if (r.status !== 200 || !r.cookie) throw new Error(`Could not register: ${r.data?.error ?? r.status}`)
    p = { server: url.origin, agent: { id: r.data.id, name, pubkey: ident.publicKey, passphrase, auth: ident.auth }, cookie: r.cookie }
    saveProfile(p)
  }
  const agentId = p.agent.id
  const named = (await api<Me>(p, 'GET', '/api/me')).users.filter((u) => !u.deleted && u.id !== agentId && u.name.toLowerCase() === owner.toLowerCase())
  // Talk folds only ASCII case, so "élodie" and "Élodie" can be two people: then only the exact name will do.
  const o = named.length > 1 ? named.find((u) => u.name === owner) : named[0]
  if (!o)
    throw new Error(named.length ? `${named.map((u) => u.name).join(', ')} all match ${owner}. Run pair again with the exact name.` : `No user named ${owner} on ${p.server}. Check the spelling and run pair again.`)

  // The creator wraps the DM key for both members, itself included. 409 means the DM exists: unwrap its key.
  const id = crypto.randomUUID()
  const raw = newConvKeyBytes()
  const members = await Promise.all([p.agent, o].map(async (u) => ({ userId: u.id, wrappedKey: await wrapConvKey(raw, ident.privateKey, u.pubkey, id, u.id) })))
  const r = await request(p, 'POST', '/api/conversations', { id, kind: 'dm', title: null, members })
  let dm: Paired['dm'] = { id, key: b64(raw) }
  if (r.status === 409 && r.data?.error === 'exists') {
    const me = await api<Me>(p, 'GET', '/api/me')
    const conv = me.conversations.find((c) => c.id === r.data.id)
    // One of us two made our DM and wrapped its key. Anyone else who wrapped it knows the key.
    const by = conv?.kind === 'dm' && conv.members.includes(o.id) ? [p.agent, o].find((u) => u.id === conv.wrappedBy) : undefined
    if (!conv || !by) throw new Error(`The server points at a chat with ${o.name} whose key neither of you made. Don't use this server.`)
    dm = { id: conv.id, key: b64((await unwrapConvKey(conv.wrappedKey, ident.privateKey, by.pubkey, conv.id, agentId)).raw) }
  } else if (r.status !== 200) throw new Error(`Could not open a chat with ${o.name}: ${r.data?.error ?? r.status}`)
  const full: Paired = { ...p, owner: { id: o.id, name: o.name, pubkey: o.pubkey }, dm }
  saveProfile(full)

  const s = await connect(full)
  const hello = await send(s, full, await dmKey(full), {
    from: agentId,
    text: `Hi, I'm ${full.agent.name} on ${hostname()}. I'll message you here when I need you. When I ask you something, reply yes or no with the code I send, like "yes kxqzm".`,
  })
  s.close()
  saveProfile({ ...full, cursor: hello.id })
  const w = Math.max(full.agent.name.length, o.name.length) + 3
  await print(`Paired with ${o.name} as "${full.agent.name}" on ${full.server}.

Before you rely on it, compare safety codes. In Talk, open Settings > Safety codes:
  ${full.agent.name.padEnd(w)}${await safetyCode(full.agent.pubkey)}
  ${o.name.padEnd(w)}${await safetyCode(o.pubkey)}
Both must match: the first with the ${full.agent.name} row, the second with your own row, marked (you).
If either differs, run unpair --yes and don't use this pairing.

Next: node ${CLI} hooks install`)
  log('pair')
  return 0
}

async function doctor(settings: string) {
  let failed = 0
  const check = async (name: string, f: () => unknown) => {
    try {
      const said = await f()
      await print(`ok   ${name}${said ? `: ${said}` : ''}`)
    } catch (e) {
      failed++
      await print(`FAIL ${name}: ${(e as Error).message}`)
    }
  }
  const p = readProfile()
  await check('profile', () => {
    if (!p) throw new Error(`none at ${file('profile.json')}; run pair`)
    const mode = statSync(file('profile.json')).mode & 0o777
    if (mode !== 0o600) throw new Error(`${file('profile.json')} has mode ${mode.toString(8)}, want 600`)
    if (!p.owner || !p.dm) throw new Error('pairing did not finish; run pair again')
    return file('profile.json')
  })
  if (p?.owner && p.dm) {
    const owner = p.owner
    const dm = p.dm
    await check('server', async () => {
      const r = await call(p.server, 'GET', '/healthz')
      if (r.status !== 200) throw new Error(`${p.server} answered ${r.status}`)
      return p.server
    })
    // After a sign-in failed, hooks don't try again for 10 minutes. doctor tries at once.
    if (p.loginFailedAt) patchProfile({ loginFailedAt: (p.loginFailedAt = undefined) })
    const me = await api<Me>(p, 'GET', '/api/me').catch((e: Error) => e)
    await check('session', () => {
      if (me instanceof Error) throw me
      return `signed in as ${me.user.name}`
    })
    if (!(me instanceof Error)) {
      await check('owner', () => {
        const u = me.users.find((x) => x.id === owner.id)
        if (!u || u.deleted) throw new Error(`${owner.name} is no longer on ${p.server}`)
        if (u.pubkey !== owner.pubkey) throw new Error(`${owner.name}'s key changed since pairing; don't trust it until you compare safety codes`)
        return owner.name
      })
      await check('chat', () => {
        if (!me.conversations.some((c) => c.id === dm.id)) throw new Error(`the chat with ${owner.name} is gone`)
      })
    }
    await check('safety codes', async () => `${p.agent.name} ${await safetyCode(p.agent.pubkey)}, ${owner.name} ${await safetyCode(owner.pubkey)}`)
  }
  await check('idle', () => {
    const idle = idleSeconds()
    return idle === null ? 'unknown: notifications count you as away, permission prompts stay in the terminal' : `${Math.round(idle)} s`
  })
  await check('hooks', () => {
    const events = [...new Set(ourHooks(readSettings(settings)).map((h) => h.event))]
    if (!events.length) throw new Error(`none in ${settings}; run hooks install`)
    return `${events.join(', ')} in ${settings}`
  })
  await check('hook paths', () => {
    const paths = [...new Set(ourHooks(readSettings(settings)).flatMap((h) => [...h.command.matchAll(/"([^"]+)"/g)].map((m) => m[1])))]
    const gone = paths.find((x) => !existsSync(x))
    if (gone) throw new Error(`${gone} is gone; run hooks install again`)
    return paths.join(', ')
  })
  return failed ? 3 : 0
}

// The Phase 0 demand log: last 7 days of events, counted by kind and outcome.
async function stats() {
  const at = file('events.jsonl')
  const since = Date.now() - 7 * 86_400_000
  const counts = new Map<string, number>()
  for (const line of existsSync(at) ? readFileSync(at, 'utf8').split('\n') : []) {
    if (!line) continue
    const e = JSON.parse(line)
    if (Date.parse(e.t) < since) continue
    const outcome = e.ev === 'notification' ? [e.sent ? 'sent' : e.why] : e.ev === 'answer' ? [e.verdict, e.via] : [e.result ?? e.source ?? e.where]
    const key = [e.ev, ...new Set(outcome)].filter(Boolean).join(' ')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  await print(rows.length ? rows.map(([k, n]) => `${String(n).padStart(5)}  ${k}`).join('\n') : 'No events in the last 7 days.')
  return 0
}

main().then(
  (code) => process.exit(code),
  async (e: Error) => {
    await write(process.stderr, `${e.message}\n`)
    process.exit(3)
  },
)
