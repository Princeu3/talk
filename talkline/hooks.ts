// Claude Code hooks: away detection, the settings.json merge, and the
// notification, stop and permission handlers.
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import type { Message, MessageBody } from '../shared/types.ts'
import { ask, asked, BARE, TYPED } from './ask.ts'
import { CLI, dmKey, file, gate, history, hhmm, home, log, paired, patchProfile, react, read, readProfile, say, type Paired } from './talk.ts'

export const SETTINGS = path.join(homedir(), '.claude', 'settings.json')
// Ours, also from an older checkout path.
const OURS = /talkline[\/\\]cli\.ts"? hook (notification|stop|permission)$/
// The Notification kinds that text the owner.
const KINDS = ['permission_prompt', 'idle_prompt', 'agent_needs_input', 'agent_completed']

interface Group {
  matcher?: string
  hooks?: { type: string; command?: string; timeout?: number }[]
}
interface Settings {
  hooks?: Record<string, Group[]>
}

// --- away ---

// Seconds without this Mac's keyboard or mouse; TALKLINE_AWAY=always or never overrides it. null when
// it can't tell: over SSH it can't see who sits at the terminal, and without ioreg it isn't a Mac.
export function idleSeconds() {
  const v = process.env.TALKLINE_AWAY
  if (v === 'always') return Infinity
  if (v === 'never') return 0
  if (process.env.SSH_CONNECTION) return null
  try {
    const out = execFileSync('ioreg', ['-r', '-c', 'IOHIDSystem', '-d', '1', '-k', 'HIDIdleTime'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const ns = /"HIDIdleTime" = (\d+)/.exec(out)?.[1]
    return ns ? Number(ns) / 1e9 : null
  } catch {
    return null
  }
}

// Keyboard or mouse used since `t`, by one idle reading. Unknown idle never counts.
const touchedSince = (t: number, idle = idleSeconds()) => (idle ?? Infinity) * 1000 <= Date.now() - t

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
    Notification: approvals === null ? null : { matcher: KINDS.join('|'), ...ours('notification', 30) },
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

const TEN_MINUTES = 600_000
const fresh = (at: string, ms: number) => {
  try {
    return Date.now() - statSync(at).mtimeMs < ms
  } catch {
    return false
  }
}
// The markers inbox.lock and sessions/<sid>.pending hold their writer's pid: one is live while that
// process lives, and for at most `ms`, as a pid can be reused.
const live = (at: string, ms: number) => {
  if (!fresh(at, ms)) return false
  try {
    return process.kill(Number(readFileSync(at, 'utf8')), 0)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // alive, another user's; ESRCH: dead
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
    if (kind === 'permission_prompt' && live(session('pending'), TEN_MINUTES)) return log('notification', { kind, sent: false, why: 'pending' })
    // Claude Code sends idle_prompt after 60 s without typing, so 60 s idle means the owner left before Claude finished. Unknown counts as away.
    const idle = idleSeconds()
    if (idle !== null && idle < (kind === 'idle_prompt' ? 60 : 120)) return log('notification', { kind, sent: false, why: 'keyboard' })
    let text = `${label}: ${input.message ?? ''}`
    // Cut on read too: an older talkline wrote up to 2,000 characters there.
    if ((kind === 'idle_prompt' || kind === 'agent_completed') && fresh(session('last'), TEN_MINUTES)) text += '\n' + readFileSync(session('last'), 'utf8').slice(0, 500)
    sent((await say(p, text, { quiet: kind === 'agent_completed' })).id)
    return log('notification', { kind, sent: true })
  }

  if (event === 'stop') {
    if (typeof input.last_assistant_message === 'string') writeFileSync(session('last'), input.last_assistant_message.slice(0, 500), { mode: 0o600 })
    const lock = file('inbox.lock')
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
    } catch {
      if (live(lock, 60_000)) return // another Stop is reading the inbox
      rmSync(lock, { force: true }) // free: the run holding it died
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
    }
    const release = () => rmSync(lock, { force: true })
    // The watchdog's and a signal's process.exit skip finally. Taking a dead run's lock isn't atomic: leave that to hard kills.
    process.once('exit', release)
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
  const t0 = Date.now()
  let idle = idleSeconds()
  // Over SSH or off macOS, idle time can't see who sits at the terminal: the prompt stays there unless TALKLINE_AWAY=always.
  if (idle === null) return skip('unknown idle')
  if (touchedSince(t0, idle)) return skip('keyboard') // TALKLINE_AWAY=never
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
  writeFileSync(session('pending'), String(process.pid))
  try {
    // Claude Code asks once, so wait here until 2 minutes without keyboard or mouse; touching the Mac first leaves it to the terminal.
    while ((idle ?? Infinity) < 120) {
      await pause(2000)
      if (touchedSince(t0, (idle = idleSeconds()))) return skip('keyboard')
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
    rmSync(session('pending'), { force: true }) // a signal's process.exit skips this; then the dead pid frees it
  }
}

const CAP = 9000 // Claude Code moves additionalContext over 10,000 chars to a file it doesn't ask Claude to read

// The line Claude gets for an owner message, or '' for one that isn't for Claude: an answer to an ask
// (its code typed, or a bare yes or no swiped at it, by the asks file), call logs and group events.
function shown(m: Message, b: MessageBody, asks: ReturnType<typeof asked>) {
  const text = String(b.text ?? '')
  const code = TYPED.exec(text)?.[2].toLowerCase()
  if (b.system || (code && asks.codes.has(code)) || (BARE.test(text) && asks.ids.has(Number(b.reply?.id)))) return ''
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
  // ✅ replaces the 👀 on what the last Stop handed over, while the new messages load. Talk unreachable: the rest wait for the next Stop.
  const handed = p.handed ?? []
  const [missed, news] = await Promise.all([
    Promise.all(handed.map((id) => react(p, key, id, '✅').then(() => [], () => [id]))).then((x) => x.flat()),
    taken === held.length ? history(p, p.cursor ?? 0) : [],
  ])
  if (handed.length) patchProfile({ handed: missed })
  if (missed.length) throw new Error(`Could not reach ${p.server}.`)

  const bodies = await Promise.all(news.map((m) => gate(p, key, m)))
  const asks = asked()
  // shortcut: a reply means reading every session's .sent file; prune old sessions if that ever shows.
  const sender = new Map<number, string>()
  if (bodies.some((b) => b?.reply))
    for (const f of readdirSync(file('sessions')))
      if (f.endsWith('.sent')) for (const id of readFileSync(file(`sessions/${f}`), 'utf8').split('\n')) if (id) sender.set(Number(id), f.slice(0, -5))
  const holds: { to: string; id: number; line: string }[] = []
  let cursor = p.cursor ?? 0
  for (const [i, m] of news.entries()) {
    const body = bodies[i]
    const line = body ? shown(m, body, asks) : ''
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
