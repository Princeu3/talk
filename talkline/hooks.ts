// Claude Code hooks: away detection, the settings.json merge, and the
// notification, stop and permission handlers.
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { openMessage } from '../src/lib/crypto.ts'
import type { Message, MessageBody, ReactionBody } from '../shared/types.ts'
import { ask, ASKED, BARE } from './ask.ts'
import { CLI, connect, dmKey, file, gate, history, hhmm, home, log, paired, patchProfile, react, read, readProfile, send, type Paired } from './talk.ts'

export const SETTINGS = path.join(homedir(), '.claude', 'settings.json')
// Ours, also from an older checkout path.
const OURS = /talkline[\/\\]cli\.ts"? hook (notification|stop|permission)$/

interface Group {
  matcher?: string
  hooks?: { type: string; command?: string; timeout?: number }[]
}
interface Settings {
  hooks?: Record<string, Group[]>
}

// --- away ---

export function idleSeconds() {
  try {
    const out = execFileSync('ioreg', ['-r', '-c', 'IOHIDSystem', '-d', '1', '-k', 'HIDIdleTime'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const ns = /"HIDIdleTime" = (\d+)/.exec(out)?.[1]
    return ns ? Number(ns) / 1e9 : null
  } catch {
    return null // no ioreg: not a Mac
  }
}

// TALKLINE_AWAY=always|never, else this many seconds without keyboard or mouse. Unknown counts as away.
export function away(seconds = 120) {
  const v = process.env.TALKLINE_AWAY
  if (v === 'always' || v === 'never') return v === 'always'
  const idle = idleSeconds()
  return idle === null || idle >= seconds
}

// Keyboard or mouse used since `t`. Unknown idle never counts, nor does TALKLINE_AWAY=always.
const touchedSince = (t: number) => process.env.TALKLINE_AWAY !== 'always' && (idleSeconds() ?? Infinity) * 1000 < Date.now() - t

// --- settings.json ---

export function readSettings(at: string): Settings {
  if (!existsSync(at)) return {}
  try {
    return JSON.parse(readFileSync(at, 'utf8'))
  } catch {
    throw new Error(`${at} is not valid JSON. Nothing changed.`)
  }
}

// The first `node` on PATH that is this same binary, such as Homebrew's /opt/homebrew/bin/node:
// it outlives a node upgrade, which deletes the versioned path in process.execPath.
function stableNode() {
  const me = realpathSync(process.execPath)
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    try {
      if (path.isAbsolute(dir) && realpathSync(path.join(dir, 'node')) === me) return path.join(dir, 'node')
    } catch {}
  }
  return process.execPath
}

export const ourHooks = (s: Settings) =>
  Object.entries(s.hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap((g) => g.hooks ?? []).flatMap((h) => (OURS.test(h.command ?? '') ? [{ event, command: h.command! }] : [])),
  )

// approvals true or false installs, null uninstalls. Everything else in the file stays as it was, key order too.
export function setHooks(at: string, approvals: boolean | null) {
  const before = readSettings(at)
  const next: Settings = structuredClone(before)
  const node = stableNode()
  const ours = (event: string, timeout: number) => ({ hooks: [{ type: 'command', command: `"${node}" "${CLI}" hook ${event}`, timeout }] })
  // Never onFailure: on PermissionRequest it would turn any failure into a deny.
  const want: Record<string, Group | null> = {
    Notification: approvals === null ? null : { matcher: 'permission_prompt|idle_prompt|agent_needs_input|agent_completed', ...ours('notification', 30) },
    Stop: approvals === null ? null : ours('stop', 30),
    PermissionRequest: approvals ? ours('permission', 600) : null,
  }
  const hooks = next.hooks ?? {}
  for (const [event, mine] of Object.entries(want)) {
    const groups: Group[] = []
    for (const g of hooks[event] ?? []) {
      const rest = g.hooks?.filter((h) => !OURS.test(h.command ?? ''))
      if (!rest || rest.length === g.hooks!.length) groups.push(g)
      else if (rest.length) groups.push({ ...g, hooks: rest })
    }
    if (mine) groups.push(mine)
    if (groups.length) hooks[event] = groups
    else delete hooks[event]
  }
  if (Object.keys(hooks).length) next.hooks = hooks
  else delete next.hooks
  if (JSON.stringify(next) === JSON.stringify(before)) return 'Hooks already up to date.'

  let backup = ''
  if (existsSync(at)) {
    const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString() // local time, ISO shape
    backup = `${at}.talkline-backup-${local.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`
    try {
      copyFileSync(at, backup, constants.COPYFILE_EXCL)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e // EEXIST: one from this same second holds the older file
    }
  }
  const mode = existsSync(at) ? statSync(at).mode & 0o777 : 0o644
  const real = existsSync(at) ? realpathSync(at) : at // a symlink into dotfiles stays a symlink: write its target
  mkdirSync(path.dirname(real), { recursive: true })
  const tmp = `${real}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode })
  chmodSync(tmp, mode) // the umask may have narrowed it
  renameSync(tmp, real)
  const events = [...new Set(ourHooks(next).map((h) => h.event))]
  return `${events.length ? `Installed hooks for ${events.join(', ')} in` : 'Removed the talkline hooks from'} ${at}.${backup ? ` Backup: ${backup}` : ''}`
}

// --- handlers ---

interface Input {
  session_id?: string
  cwd?: string
  notification_type?: string
  message?: string
  last_assistant_message?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
}

const KINDS = ['permission_prompt', 'idle_prompt', 'agent_needs_input', 'agent_completed']
const TEN_MINUTES = 600_000
const fresh = (at: string, ms: number) => {
  try {
    return Date.now() - statSync(at).mtimeMs < ms
  } catch {
    return false
  }
}

// Returns what to print on stdout: nothing, or the decision JSON.
export async function hook(event: string, input: Input, expires?: number): Promise<string | void> {
  const profile = readProfile()
  if (!profile?.owner || !profile.dm) return
  const p = profile as Paired
  home()
  const sid = String(input.session_id ?? '').replace(/[^A-Za-z0-9_-]/g, '') || 'none'
  const session = (ext: string) => file(`sessions/${sid}.${ext}`)
  const label = path.basename(String(input.cwd ?? '')) || 'Claude Code'
  // What this session sent the owner, so the Stop inbox gives a swipe-reply to it back to this session.
  const sent = (id: number) => appendFileSync(session('sent'), `${id}\n`, { mode: 0o600 })

  if (event === 'notification') {
    const kind = String(input.notification_type)
    if (!KINDS.includes(kind)) return
    if (kind === 'permission_prompt' && fresh(session('pending'), TEN_MINUTES)) return log('notification', { kind, sent: false, why: 'pending' })
    // Claude Code sends idle_prompt after 60 s without typing, so 60 s idle means the owner left before Claude finished.
    if (!away(kind === 'idle_prompt' ? 60 : 120)) return log('notification', { kind, sent: false, why: 'keyboard' })
    let text = `${label}: ${input.message ?? ''}`
    if ((kind === 'idle_prompt' || kind === 'agent_completed') && fresh(session('last'), TEN_MINUTES))
      text += '\n' + String(JSON.parse(readFileSync(session('last'), 'utf8')).text).slice(0, 500)
    const s = await connect(p)
    sent((await send(s, p, await dmKey(p), { from: p.agent.id, text }, { quiet: kind === 'agent_completed' })).id)
    s.close()
    return log('notification', { kind, sent: true })
  }

  if (event === 'stop') {
    if (typeof input.last_assistant_message === 'string')
      writeFileSync(session('last'), JSON.stringify({ t: Date.now(), text: input.last_assistant_message.slice(0, 2000) }), { mode: 0o600 })
    const lock = file('inbox.lock')
    try {
      writeFileSync(lock, '', { flag: 'wx' })
    } catch {
      if (fresh(lock, 60_000)) return // another Stop is reading the inbox
      rmSync(lock, { force: true }) // stale: a run died holding it
      writeFileSync(lock, '', { flag: 'wx' })
    }
    const release = () => rmSync(lock, { force: true })
    process.once('exit', release) // the watchdog's and a signal's process.exit skip finally
    try {
      return await inbox(paired(), sid, label) // read the cursor under the lock: another Stop may just have moved it
    } finally {
      release()
      process.off('exit', release)
    }
  }

  // permission
  const tool = String(input.tool_name)
  if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') return // these need the terminal
  const skip = (why: string) => log('notification', { kind: 'permission', sent: false, why })
  if (process.env.TALKLINE_AWAY === 'never') return skip('keyboard')
  // Over SSH or off macOS, idle time can't see who sits at the terminal: the prompt stays there unless TALKLINE_AWAY=always.
  if (process.env.TALKLINE_AWAY !== 'always' && (process.env.SSH_CONNECTION || idleSeconds() === null)) return skip('unknown idle')
  const ti = input.tool_input ?? {}
  const target = String(ti.file_path ?? ti.notebook_path ?? '')
  // The whole request, so a yes approves only what the owner saw: past 6,000 chars, its start and end.
  // 6,000 fits Talk's 64 KB message limit even when every char escapes to 6 bytes of JSON.
  const cut = (t: string) =>
    t.length <= 6000 ? t : `${t.slice(0, 3000)}\n… ${t.length - 6000} more characters not shown. If unsure, reply no and check at the Mac …\n${t.slice(-3000)}`
  const [action, detail] =
    tool === 'Bash' ? ['run a command', cut(String(ti.command ?? ''))]
    : ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) ? [`edit ${input.cwd ? path.relative(input.cwd, target) : target}`, cut(JSON.stringify(ti))]
    : tool === 'WebFetch' ? [`fetch ${ti.url}`]
    : [`use ${tool}`, cut(JSON.stringify(ti))]
  writeFileSync(session('pending'), '')
  const clear = () => rmSync(session('pending'), { force: true })
  process.once('exit', clear) // a signal's process.exit skips finally
  try {
    // Claude Code asks once, so wait here until 2 minutes without keyboard or mouse; touching the Mac first leaves it to the terminal.
    const t0 = Date.now()
    while (!away()) {
      await pause(2000)
      if (touchedSince(t0)) return skip('keyboard')
    }
    const verdict = await ask(p, {
      question: `${label}: Claude wants to ${action}`,
      detail,
      risk: 'high',
      urgent: true,
      ringAfter: 180,
      expires: (expires ?? 8) - (Date.now() - t0) / 60_000, // settles, close-out included, before Claude Code's 600 s hook timeout
      source: 'permission',
      atMac: touchedSince,
      posted: sent,
    })
    if (verdict === 'keyboard' || verdict === 'cancelled') return // the terminal dialog takes it
    const decision =
      verdict === 'yes' ? { behavior: 'allow' }
      : verdict === 'no' ? { behavior: 'deny', message: 'Denied on Talk' }
      : { behavior: 'deny', message: 'No answer on Talk', interrupt: true } // stops Claude: each new try would ask and ring again
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
  } finally {
    clear()
    process.off('exit', clear)
  }
}

const CAP = 9000 // Claude Code moves additionalContext over 10,000 chars to a file it doesn't ask Claude to read

// The line Claude gets for an owner message, or '' for one that isn't for Claude: an answer an ask
// took (its ✅ or ❌ is on it), a bare yes or no swiped at an ask, call logs and group events.
// shortcut: an answer the inbox reads before its ask reacts (a ~100 ms window) is handed over; keep the open codes on disk if that bites.
async function shown(p: Paired, key: CryptoKey, m: Message, b: MessageBody) {
  const text = String(b.text ?? '')
  if (b.call || b.system || (BARE.test(text) && b.reply?.from === p.agent.id && ASKED.test(b.reply.preview))) return ''
  for (const r of m.reactions ?? []) {
    const rb = r.userId === p.agent.id && (await openMessage<ReactionBody>(key, m.convId, r.body).catch(() => null))
    if (rb && (rb.emoji === '✅' || rb.emoji === '❌')) return '' // above the cursor, only asks react
  }
  const said = text || (b.files?.length ? '(sent a file, not shown)' : '')
  if (!said) return ''
  const quote = b.reply ? `(reply to "${String(b.reply.preview ?? '').replace(/\s+/g, ' ')}") ` : ''
  // Indented continuation lines can't pass for messages of their own.
  return `[${hhmm(m.createdAt)}] ${b.forwarded ? '(forwarded; written by someone else) ' : ''}${quote}${said}`.replaceAll('\n', '\n  ')
}

// The Stop hook's inbox: the owner's messages since the cursor, handed to Claude as context, oldest
// first. A reply to a message another session sent waits in that session's .held file for its Stop.
async function inbox(p: Paired, sid: string, label: string) {
  const key = await dmKey(p)
  // ✅ replaces the 👀 on what the last Stop handed over. Talk unreachable: the rest wait for the next Stop.
  const handed = p.handed ?? []
  const missed = (await Promise.all(handed.map((id) => react(p, key, id, '✅').then(() => [], () => [id])))).flat()
  if (handed.length) patchProfile({ handed: missed })
  if (missed.length) throw new Error(`Could not reach ${p.server}.`)

  const head = `${p.owner.name} sent these messages on Talk, from ${p.owner.name}'s own account (end-to-end encrypted), while Claude Code session "${label}" worked. Other Claude Code sessions on this Mac share this inbox, so a message that isn't a reply may be meant for another session:`
  const lines: { id: number; line: string }[] = []
  let size = head.length
  // Takes the line if it fits under CAP. The first always does, cut if it must be; the rest wait for the next Stop.
  const fit = (id: number, line: string) => {
    if (lines.length && size + 1 + line.length > CAP) return false
    const room = CAP - size - 1
    if (line.length > room) line = `${line.slice(0, room - 40)} [${line.length - room + 40} more characters not shown]`
    lines.push({ id, line })
    size += 1 + line.length
    return true
  }
  const heldAt = file(`sessions/${sid}.held`)
  const held: { id: number; line: string }[] = existsSync(heldAt) ? readFileSync(heldAt, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  let taken = 0
  while (taken < held.length && fit(held[taken].id, held[taken].line)) taken++
  // shortcut: every session's .sent file is read at each Stop; prune old sessions if that ever shows.
  const sender = new Map<number, string>()
  for (const f of readdirSync(file('sessions')))
    if (f.endsWith('.sent')) for (const id of readFileSync(file(`sessions/${f}`), 'utf8').split('\n')) if (id) sender.set(Number(id), f.slice(0, -5))
  const holds: { to: string; id: number; line: string }[] = []
  let cursor = p.cursor ?? 0
  if (taken === held.length)
    for (const m of await history(p, cursor)) {
      const body = await gate(p, key, m)
      const line = body ? await shown(p, key, m, body) : ''
      const to = body?.reply && sender.get(body.reply.id)
      if (line && to && to !== sid) holds.push({ to, id: m.id, line })
      else if (line && !fit(m.id, line)) break
      cursor = m.id // past the agent's own messages too: the DM has two members, and ids only grow
    }

  if (lines.length) {
    // The first 👀 alone, before anything is saved: 403 means the owner blocked the agent, so nothing more reaches Claude.
    const status = await react(p, key, lines[0].id, '👀')
    if (status === 403) {
      rmSync(heldAt, { force: true })
      patchProfile({ cursor })
      return log('inbox', { count: 0, why: 'blocked' })
    }
    if (status >= 300) throw new Error(`PUT reaction: ${status}`)
    await Promise.all(lines.slice(1).map((l) => react(p, key, l.id, '👀').catch(() => {})))
    await read(p, cursor).catch(() => {})
  }
  for (const h of holds) appendFileSync(file(`sessions/${h.to}.held`), JSON.stringify({ id: h.id, line: h.line }) + '\n', { mode: 0o600 })
  if (taken < held.length) writeFileSync(heldAt, held.slice(taken).map((h) => JSON.stringify(h) + '\n').join(''), { mode: 0o600 })
  else rmSync(heldAt, { force: true })
  patchProfile({ cursor, handed: lines.map((l) => l.id) })
  if (!lines.length) return
  log('inbox', { count: lines.length })
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: [head, ...lines.map((l) => l.line)].join('\n') } })
}
