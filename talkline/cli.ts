#!/usr/bin/env node
// talkline: the Claude Code bridge to Talk (Phase 1). Commands below; see talkline/README.md.
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { constants, hostname } from 'node:os'
import path from 'node:path'
import { text as readAll } from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import { b64, deriveIdentity, safetyCode, unwrapConvKey } from '../src/lib/crypto.ts'
import type { Me } from '../shared/types.ts'
import { ask, cancels } from './ask.ts'
import { hook, idleSeconds, ourHooks, readSettings, SETTINGS, setHooks } from './hooks.ts'
import { api, call, CLI, connect, file, limits, log, noteSent, paired, patchProfile, readProfile, REMOVED, saveProfile, say, sessionId, sessionKey, type Paired } from './talk.ts'

const PAIR = `pair '<agent link>' [--name "Claude AI"]   (make the link in Talk: Settings > Agents)`
const USAGE = `Usage: node ${CLI} <command>
  ${PAIR}
  notify <text> [--quiet]
  ask <question> [--detail <text>] [--risk low|high] [--urgent] [--ring-after <seconds>] [--expires <minutes>]
      prints yes, no or expired, and exits 0, 1 or 2 (128 + the signal if stopped, 130 for Ctrl+C)
  hooks install [--approvals] [--settings <path>]
  hooks uninstall [--settings <path>]
  hook notification|stop|permission [--expires <minutes>]   (Claude Code runs these)
  mcp [--channel]   (Claude Code runs this: Talk tools for the session, over stdio)
  doctor [--settings <path>]
  stats
  unpair --yes
Any error exits 3.`

// macOS pipes are asynchronous: exit only after the write is done.
const write = (to: NodeJS.WriteStream, text: string) => new Promise<void>((r) => to.write(text, () => r()))
const print = (text: string) => write(process.stdout, text + '\n')

// Ctrl+C, a closed terminal, or Claude Code ending a hook. An open ask first closes itself (hangs up,
// marks the question Cancelled), for up to 1 s. process.exit runs the exit listener that frees inbox.lock;
// .pending holds this pid, so the exit frees it too.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.on(sig, () => {
    process.exitCode = 128 + constants.signals[sig]
    if (!cancels.size) process.exit()
    for (const c of cancels) c()
    setTimeout(() => process.exit(), 1000).unref()
  })

// Run from Claude Code, whose Bash sets CLAUDE_CODE_SESSION_ID (the hooks' session_id): name the session, and send a swipe-reply back to it.
const sid = sessionId(process.env.CLAUDE_CODE_SESSION_ID)
const label = sid ? `${path.basename(process.cwd())}: ` : ''
const sent = (id: number) => void (sid && noteSent(sessionKey(sid), id))

async function main(): Promise<number> {
  const { values: o, positionals: [cmd, ...args] } = parseArgs({
    allowPositionals: true,
    options: {
      // owner: unused since Phase 1, kept so an old pair command reaches the link hint, not "Unknown option".
      owner: { type: 'string' }, name: { type: 'string' }, detail: { type: 'string' }, risk: { type: 'string' },
      'ring-after': { type: 'string' }, expires: { type: 'string' }, settings: { type: 'string' },
      quiet: { type: 'boolean' }, urgent: { type: 'boolean' }, approvals: { type: 'boolean' }, yes: { type: 'boolean' }, channel: { type: 'boolean' },
    },
  })
  const settings = o.settings ?? SETTINGS
  switch (cmd) {
    case 'pair':
      return pair(args[0], o.name ?? 'Claude AI')
    case 'notify':
      if (!args.length) break
      sent((await say(paired(), label + args.join(' '), { quiet: o.quiet })).id)
      return 0
    case 'ask': {
      const risk = o.risk ?? 'high'
      const ringAfter = Number(o['ring-after'] ?? 180)
      const expires = Number(o.expires ?? 10)
      if (!args.length || (risk !== 'low' && risk !== 'high') || !(ringAfter >= 0)) break
      if (!(expires > 0 && expires <= 14))
        throw new Error('--expires takes minutes, more than 0 and at most 14: closing the question edits it, and Talk allows edits for 15 minutes.')
      const { verdict, note } = await ask(paired(), { question: label + args.join(' '), detail: o.detail, risk, urgent: !!o.urgent, ringAfter, expires, source: 'cli', posted: sent })
      if (verdict === 'cancelled') return Number(process.exitCode)
      await print(note ? `${verdict}\n${note}` : verdict) // only a no carries a note
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
        const out = await hook(event, JSON.parse(raw.trim() || '{}'), print, o.expires === undefined ? undefined : Number(o.expires))
        if (out) await print(out)
      } catch (e) {
        log('error', { where: `hook ${event}`, message: (e as Error).message })
      }
      return 0
    }
    case 'mcp':
      return (await import('./mcp.ts')).mcp(!!o.channel)
    case 'doctor':
      return doctor(settings)
    case 'stats':
      return stats()
    case 'unpair': {
      if (!o.yes) throw new Error('unpair deletes the agent account on the server and the local profile. Run unpair --yes to do it.')
      const p = readProfile()
      if (!p) throw new Error('Not paired.')
      // REMOVED: the owner removed it already.
      await api(p, 'DELETE', '/api/me', p.token ? undefined : { auth: p.agent.auth }).catch((e: Error) => {
        if (e.message !== REMOVED) throw e
      })
      rmSync(file('profile.json'))
      await print(`${p.token ? 'Removed' : 'Deleted'} ${p.agent.name} from ${p.server}. Run hooks uninstall to remove the hooks.`)
      return 0
    }
  }
  throw new Error(USAGE)
}

// Pairing v1. The link (made in Talk: Settings > Agents) pins the owner's id and key, and holds a secret
// this Mac proves it has. The owner's browser checks that proof, then opens the DM: that is the Allow.
async function pair(link: string | undefined, name: string) {
  const url = URL.parse(link ?? '')
  if (url?.searchParams.has('invite'))
    throw new Error('That link invites a person. In Talk, open Settings > Agents > Link a helper, then pair with that link.')
  const code = url?.searchParams.get('agent')
  const [o, k, s] = ['o', 'k', 's'].map((x) => new URLSearchParams(url?.hash.slice(1)).get(x) ?? '')
  // k (the owner's key) and s (the secret) are 32 bytes each; a link cut short, by a missing quote say, fails here.
  if (!url || !code || !o || !/^[\w-]{43}$/.test(k) || !/^[\w-]{43}$/.test(s)) throw new Error(`Usage: node ${CLI} ${PAIR}`)
  let p = readProfile()
  if (p?.dm) throw new Error(`Already paired as ${p.agent.name} with ${p.owner?.name}. Run unpair first.`)
  if (p && !p.token) throw new Error(`${p.agent.name} is a Phase 0 pairing that never finished. Run unpair --yes first.`)
  // A profile with a token and no dm registered, then stopped before the Allow: wait again, with the owner it pinned.
  const passphrase = p?.agent.passphrase ?? b64(crypto.getRandomValues(new Uint8Array(24)))
  const ident = await deriveIdentity(p?.agent.name ?? name, passphrase)
  if (!p) {
    const proof = createHmac('sha256', Buffer.from(s, 'base64url')).update(`talk-pair-v1:${ident.publicKey}`).digest('base64url')
    const r = await call(url.origin, 'POST', '/api/agents', { code, name, pubkey: ident.publicKey, proof, where: hostname().slice(0, 64) })
    if (r.status === 403)
      throw new Error("This link was used already or has expired. If Talk lists a helper waiting for Allow that this Mac didn't pair, Deny it. Then make a new link.")
    if (r.status === 409) throw new Error(`The name ${name} is taken. Pick another with --name.`)
    if (r.status === 400) throw new Error(r.data?.error) // names the " AI" rule
    if (r.status !== 200) throw new Error(`Could not register: ${r.data?.error ?? r.status}`)
    p = { server: url.origin, agent: { id: r.data.id, name, pubkey: ident.publicKey, passphrase, auth: ident.auth }, token: r.data.token, owner: { id: o, name: '', pubkey: k } }
    saveProfile(p)
  }
  const helper = p
  const pin = helper.owner! // saved with the token
  try {
    // Waits for Allow, Deny or Ctrl+C, with no timeout: the same command waits again.
    let allowed!: (dm: Paired['dm'], ownerName: string) => void
    let died!: (e: Error) => void
    const waited = new Promise<Paired>((resolve, reject) => {
      allowed = (dm, ownerName) => resolve({ ...helper, owner: { ...pin, name: ownerName }, dm })
      died = reject
    })
    waited.catch(() => {}) // Deny can come before anything awaits it
    const sock = await connect(helper, died) // Deny drops the socket: REMOVED
    await print(`Waiting for you to tap Allow in Talk (Settings > Agents). The safety code there must read: ${await safetyCode(helper.agent.pubkey)}`)
    const look = async () => {
      const me = await api<Me>(helper, 'GET', '/api/me')
      const conv = me.conversations.find((c) => c.kind === 'dm' && c.members.includes(pin.id))
      if (!conv) return
      // Only the pinned key opens a key it sealed, so a chat the server made, or sealed with a key of its own, fails here.
      const key = await unwrapConvKey(conv.wrappedKey, ident.privateKey, pin.pubkey, conv.id, helper.agent.id).catch(() => null)
      if (!key) throw new Error("The chat wasn't sealed by the key in your link. Don't use this server.")
      allowed({ id: conv.id, key: b64(key.raw) }, me.users.find((u) => u.id === pin.id)?.name ?? '')
    }
    const check = () => void look().catch(died)
    sock.on('sync', check)
    sock.on('connect', check) // a reconnect may have missed a sync
    check()
    const full = await waited.finally(() => sock.close())
    // Saved only once the hello is through: a refused hello (the owner blocked this helper) leaves dm unset, so pair resumes.
    const hello = await say(
      full,
      `Hi, I'm ${full.agent.name} on ${hostname().replace(/\.local$/, '')}. Claude Code on this Mac texts you here when it needs you. Answer a question with its code, like "yes kxqzm" or "no kxqzm". To answer one session, swipe-reply to its message.`,
    )
    saveProfile({ ...full, cursor: hello.id })
    await print(`Paired with ${full.owner.name} as "${full.agent.name}" on ${full.server}.\n\nNext: node ${CLI} hooks install`)
    log('pair')
    return 0
  } catch (e) {
    if ((e as Error).message !== REMOVED) throw e
    rmSync(file('profile.json'), { force: true })
    throw new Error('Denied in Talk. Make a new link to try again.')
  }
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
  // A Phase 0 profile still works, through its cookie, as a person account. A note, not a failure.
  if (p?.cookie) await check('pairing', () => `Phase 0, so everyone on ${p.server} can see and message this helper; run unpair --yes, then link a new one.`)
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
    const v = process.env.TALKLINE_AWAY
    if (v === 'always' || v === 'never') return `TALKLINE_AWAY=${v}`
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
    const key = [e.ev, ...outcome].filter(Boolean).join(' ')
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
