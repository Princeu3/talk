// Claude Code hooks: away detection, the settings.json merge, the
// notification, stop and permission handlers, and the router every consumer shares.
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import type { Socket } from 'socket.io-client'
import type { Message, MessageBody } from '../shared/types.ts'
import { ask, asked, CHAT, PLAIN, record, typed } from './ask.ts'
import { fileSize } from '../src/lib/format.ts'
import { CLI, dmKey, file, gate, history, hhmm, home, log, lstart, markers, mcpMarker, noteSent, patchProfile, react, read, readProfile, RELAY, say, send, sessionId, type Marker, type Paired } from './talk.ts'

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
    // ioreg answers in milliseconds. A stuck one would block every timer in the hook, or the whole talkline mcp, so after 2 s it reads as unknown.
    const out = execFileSync('ioreg', ['-r', '-c', 'IOHIDSystem', '-d', '1', '-k', 'HIDIdleTime'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 })
    const ns = /"HIDIdleTime" = (\d+)/.exec(out)?.[1]
    return ns ? Number(ns) / 1e9 : null
  } catch {
    return null
  }
}

// Keyboard or mouse used since `t`, by one idle reading. Unknown idle never counts.
export const touchedSince = (t: number, idle = idleSeconds()) => (idle ?? Infinity) * 1000 <= Date.now() - t
// Why a permission prompt opened at `t0` stays at the Mac, or nothing once the owner has been away 2 minutes. Claude
// Code asks once, so this waits, looking every 2 s; touching the Mac first leaves the prompt to the terminal. Over SSH
// or off macOS, idle time can't see who sits at the terminal: the prompt stays there unless TALKLINE_AWAY=always.
export async function stays(t0: number) {
  let idle = idleSeconds()
  if (idle === null) return 'unknown idle'
  for (;;) {
    if (touchedSince(t0, idle)) return 'keyboard' // TALKLINE_AWAY=never: at once
    if ((idle ?? Infinity) >= 120) return
    await pause(2000)
    idle = idleSeconds()
  }
}
// A permission ask, the hook's or the relay's (4.6): the same form both ways.
export const PERMISSION = { risk: 'high', urgent: true, ringAfter: 180, source: 'permission', atMac: touchedSince } as const
// These need the terminal: an allow from Talk would skip the question or approve the plan unseen (4.7).
export const AT_MAC = ['AskUserQuestion', 'ExitPlanMode']

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
  scratchpad_dir?: string
  transcript_path?: string
}

const TEN_MINUTES = 600_000
const fresh = (at: string, ms: number) => {
  try {
    return Date.now() - statSync(at).mtimeMs < ms
  } catch {
    return false
  }
}
const alive = (pid: number) => {
  try {
    return process.kill(pid, 0)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // alive, another user's; ESRCH: dead
  }
}
const readOr = (at: string) => {
  try {
    return readFileSync(at, 'utf8')
  } catch {}
}
// sessions/<sid>.pending holds its writer's pid: it is live while that process lives, and for at most `ms`, as a pid can be reused.
const live = (at: string, ms: number) => fresh(at, ms) && alive(Number(readOr(at)))

const esc = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
// A value with a line break, VT and FF included, shows as a quoted JSON string, so it can't pass for another field or line.
// JSON.stringify leaves NEL, LS and PS raw, and the iPhone breaks lines on them.
export const json = (v: unknown) => JSON.stringify(v).replace(/[\u0085\u2028\u2029]/g, esc)
const BREAK = /\r\n?|[\n\u000b\u000c\u0085\u2028\u2029]/

// What an AskUserQuestion or a plan, saved by the permission hook, asks. Options get "- ", never numbers: a bare
// "1" sent back from the phone would reach whichever session stops next, as chat, while this one waits at its dialog.
type Question = { question: string; options: { label: string; description?: string }[] }
function prompted(label: string, { tool, ti }: { tool: string; ti: { plan?: string; questions?: Question[] } }) {
  if (tool === 'ExitPlanMode') return `${label} has a plan for you. Approve it at the Mac:\n${ti.plan!.slice(0, 600)}${ti.plan!.length > 600 ? '…' : ''}`
  const qs = ti.questions!.map((q) => [q.question, ...q.options.map((o) => `- ${o.label}${o.description ? `: ${o.description.slice(0, 60)}` : ''}`)].join('\n'))
  return `${label} has ${qs.length > 1 ? 'questions' : 'a question'} for you. Answer at the Mac:\n${qs.join('\n\n')}`
}

// Prints through `print` what Claude Code reads on stdout: Stop's context or the permission decision, or nothing.
export async function hook(event: string, input: Input, print: (out: string) => Promise<void>, expires?: number): Promise<void> {
  const profile = readProfile()
  if (!profile?.owner || !profile.dm) return
  const p = profile as Paired
  home()
  const sid = sessionId(input.session_id) || 'none'
  const session = (ext: string) => file(`sessions/${sid}.${ext}`) // this hook run's own: .prompt and .pending
  const m = mcpMarker() // this session's talkline mcp, if one runs: a channel or plain
  const self = m?.key || sid // .sent, .last and .held: a live talkline mcp's key, which outlives /clear
  const keyed = (ext: string) => file(`sessions/${self}.${ext}`)
  // The talkline mcp's label, which routing matches; input.cwd follows Claude's `cd`.
  const label = m?.label || path.basename(String(input.cwd ?? '')) || 'Claude Code'
  const sent = (id: number) => noteSent(self, id)

  if (event === 'notification') {
    const kind = String(input.notification_type)
    if (!KINDS.includes(kind)) return
    // A permission ask already waits on Talk: the hook's, under this run's session id, or the relay's, under the key.
    if (kind === 'permission_prompt' && [session('pending'), keyed('pending')].some((f) => live(f, TEN_MINUTES))) return log('notification', { kind, sent: false, why: 'pending' })
    // A channel session takes a Talk reply, so its text doesn't send the owner to the Mac; and one that wrote to him
    // in the last 3 minutes has said enough. Elsewhere a Talk reply can't reach a session waiting at the Mac.
    const chat = m?.channel && kind !== 'permission_prompt'
    if (chat && fresh(keyed('sent'), 180_000)) return log('notification', { kind, sent: false, why: 'answered' })
    // Claude Code sends idle_prompt after 60 s without typing, so 60 s idle means the owner left before Claude finished. Unknown counts as away.
    const idle = idleSeconds()
    if (idle !== null && idle < (kind === 'idle_prompt' ? 60 : 120)) return log('notification', { kind, sent: false, why: 'keyboard' })
    let text = `${label}${kind === 'agent_completed' || chat ? ':' : ' needs you at the Mac:'} ${input.message ?? ''}`
    if (kind === 'permission_prompt' && /AskUserQuestion|ExitPlanMode/.test(String(input.message)) && fresh(session('prompt'), TEN_MINUTES))
      try {
        text = prompted(label, JSON.parse(readFileSync(session('prompt'), 'utf8')))
      } catch {} // a shape we don't know keeps the plain text
    // Cut on read too, keeping the end: an older talkline wrote up to 2,000 characters there.
    if ((kind === 'idle_prompt' || kind === 'agent_completed' || chat) && fresh(keyed('last'), TEN_MINUTES)) text += '\n' + readFileSync(keyed('last'), 'utf8').slice(-501)
    sent((await say(p, text, { quiet: kind === 'agent_completed' })).id)
    return log('notification', { kind, sent: true })
  }

  if (event === 'stop') {
    // The end of the reply, where a closing question sits: its last 500 characters, from a word start.
    const t = input.last_assistant_message
    if (typeof t === 'string') writeFileSync(keyed('last'), t.length > 500 ? '…' + t.slice(-500).replace(/^\S*\s+/, '') : t, { mode: 0o600 })
    // The owner's messages since the last read, handed to Claude as context, oldest first. Route and take
    // share 2 s of waiting for inbox.lock, inside the 5 s Claude Code gives a Stop.
    const end = Date.now() + 2000
    // A channel hands its session the messages, but for what it delivered that no transcript shows (plan B). The
    // check goes on after .nochannel turns the process plain: lines under 10 s old then wait for a later Stop.
    // An empty .delivered, as each check leaves it, skips the lock.
    const unseen = !!input.transcript_path && !!statSync(keyed('delivered'), { throwIfNoEntry: false })?.size && (await lost(self, input.transcript_path, 2000))
    if (m?.channel && !unseen) return
    const key = await dmKey(p)
    await route(p, key, self, { wait: end - Date.now() })
    const answer = m ? 'use the send_message tool, or the ask tool for a yes or no' : `run node "${CLI}" notify "<text>", or ask "<question>?" for a yes or no`
    const head = `${p.owner.name} sent these messages on Talk, from ${p.owner.name}'s own account (end-to-end encrypted), while Claude Code session "${label}" worked. To answer on Talk, ${answer}. Other Claude Code sessions on this Mac share this inbox, so a message that isn't a reply may be meant for another session:`
    const got = await take(p, key, self, { cap: CAP - head.length, wait: end - Date.now() })
    if (!got) return
    log('inbox', { count: got.lines.length })
    await print(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: block(head, got.lines.map((l) => l.line)) } }))
    return got.done() // after the print: a Stop stopped before it leaves the lines for the next take
  }

  // permission
  const tool = String(input.tool_name)
  // Keep the input, so the permission_prompt text can show the question.
  if (AT_MAC.includes(tool)) return writeFileSync(session('prompt'), JSON.stringify({ tool, ti: input.tool_input ?? {} }), { mode: 0o600 })
  const skip = (why: string) => log('notification', { kind: 'permission', sent: false, why })
  // A channel session's talkline mcp relays this same prompt (4.6): one question, not two.
  if (m?.channel && RELAY) return skip('relay')
  const t0 = Date.now()
  // Claude Code 2.1.319 sets CLAUDE_CODE_SESSION_ATTENDED to "1" in interactive and desktop sessions, "0" in -p, background and daemon runs.
  // A channel session's expiry denies instead: Claude goes on, and can tell the owner on Talk what didn't run.
  const waits = !m?.channel && process.env.CLAUDE_CODE_SESSION_ATTENDED !== '0' // unset (older versions) counts as attended
  writeFileSync(session('pending'), String(process.pid), { mode: 0o600 })
  try {
    const stay = await stays(t0)
    if (stay) return skip(stay)
    const { verdict, note } = await ask(p, {
      ...describe(label, tool, input.tool_input ?? {}, String(input.cwd ?? ''), String(input.scratchpad_dir ?? '')),
      ...PERMISSION,
      expires: (expires ?? 8) - (Date.now() - t0) / 60_000, // settles, close-out included, before Claude Code's 600 s hook timeout
      waits,
      posted: sent,
    })
    if (verdict === 'keyboard' || verdict === 'cancelled' || (verdict === 'expired' && waits)) return // the terminal dialog takes it
    const decision =
      verdict === 'yes' ? { behavior: 'allow' }
      : verdict === 'no' ? { behavior: 'deny', message: note ? `Denied on Talk: ${note}` : 'Denied on Talk' }
      : m?.channel ? { behavior: 'deny', message: 'No answer on Talk' }
      : { behavior: 'deny', message: 'No answer on Talk', interrupt: true } // stops Claude: each new try would ask and ring again
    return await print(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }))
  } finally {
    rmSync(session('pending'), { force: true }) // a signal's process.exit skips this; then the dead pid frees it
  }
}

// The whole request, so a yes approves only what the owner saw: past 6,000 chars, its start and end.
// 6,000 fits Talk's 64 KB message limit even when every char escapes to 6 bytes of JSON.
export const cut = (t: string) =>
  t.length <= 6000 ? t : `${t.slice(0, 3000)}\n… ${t.length - 6000} more characters not shown. If unsure, reply no and check at the Mac …\n${t.slice(-3000)}`
// Text-direction controls show as escapes, so a command can't read one way on Talk and run another.
export const bare = (t: string) => t.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, esc)

// The file send_file sends, by the rules its permission ask names it with. Absolute only: the permission hook's
// folder follows Claude's cd, so a relative path could name another file there.
export function sendable(f: string) {
  if (!path.isAbsolute(f)) throw new Error('Give an absolute path.')
  const st = statSync(f, { throwIfNoEntry: false }) // follows links
  if (!st) throw new Error(`No file at ${f}`)
  if (!st.isFile()) throw new Error(`${f} is not a plain file`)
  return { name: path.basename(realpathSync(f)), size: st.size } // a link sends under its target's name
}

// What a permission ask shows for a tool call, from the PermissionRequest hook's input or the relay's preview.
// Display only: a yes approves the raw input, cut as before at 6,000 characters. /tmp/…/scratchpad is this
// session's scratchpad, and ~ your home, each only at the start of a path. ~ shows only in the question line:
// in a command or file content a quoted ~ stays a literal ~, so '~/x' would read as a harmless folder.
export function describe(label: string, tool: string, ti: Record<string, unknown>, dir: string, pad: string) {
  const target = String(ti.file_path ?? ti.notebook_path ?? '')
  const at = (prefix: string) => new RegExp(`(?<=^|[\\s'"=:(])${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/|[\\s'";|&)]|$)`, 'g')
  const scratch = (t: string) => (pad ? t.replace(at(pad), '/tmp/…/scratchpad') : t)
  const tidy = (t: string) => scratch(t).replace(at(homedir()), '~')
  const one = (s: string) => (BREAK.test(s) ? json(s) : s)
  const where = one(dir && target.startsWith(dir + '/') ? target.slice(dir.length + 1) : tidy(target))
  const mark = (s: unknown, m: string) => String(s ?? '').split(BREAK).map((l) => m + l).join('\n') // a mark on every shown line
  const fields = () => Object.entries(ti).map(([k, v]) => `${one(k)}: ${typeof v === 'string' ? one(v) : json(v)}`).join('\n')
  // send_file's file, as the tool would send it: the real file's name, and its size.
  const sending = () => {
    const f = String(ti.path ?? '')
    try {
      const { name, size } = sendable(f)
      return `${one(name)} (${fileSize(size)})`
    } catch {} // relative, missing, or a path it can't read: the tool refuses those too
    return `${one(path.basename(f))} (not a file)`
  }
  const [action, detail] =
    tool === 'Bash' ? [`run this command${ti.run_in_background ? ' in the background' : ''}${ti.dangerouslyDisableSandbox ? ' outside the sandbox' : ''}`, one(String(ti.command ?? ''))]
    : tool === 'Edit' ? [`edit ${where}`, `${mark(ti.old_string, '- ')}\n${mark(ti.new_string, '+ ')}${ti.replace_all ? '\n(every match)' : ''}`]
    : tool === 'Write' ? [`write ${where}`, String(ti.content ?? '')]
    : tool === 'MultiEdit' || tool === 'NotebookEdit' ? [`edit ${where}`, fields()]
    : tool === 'WebFetch' ? [`fetch ${one(String(ti.url))}`, '']
    : tool === 'mcp__talkline__send_file' ? [`send ${sending()} to Talk`, fields()]
    : [`use ${tool.replace(/^mcp__(.+?)__/, '$1 ')}`, fields()]
  // Only Bash's description is Claude's reason. An MCP tool's description field is content, shown with the fields.
  const why = tool === 'Bash' ? String(ti.description ?? '').replace(/[\s\u0085]+/g, ' ').trim().slice(0, 120) : '' // \s misses NEL
  return { question: bare(`${label}: ${action}?${why ? `\nClaude says: ${tidy(why)}` : ''}`), detail: cut(bare(scratch(detail))) }
}

// --- the router: route() files each owner message in one session's .held, take() hands a session its lines ---

export const CAP = 9000 // Claude Code moves additionalContext over 10,000 chars to a file it doesn't ask Claude to read
// The first line always goes, cut to `room` if it must be.
export const clip = (line: string, room: number) => (line.length <= room ? line : `${line.slice(0, room - 40)} [${line.length - room + 40} more characters not shown]`)
// A header, then the lines, the first cut to fit under CAP: what a Stop or a read hands Claude.
export const block = (head: string, [first, ...rest]: string[]) => [head, clip(first, CAP - head.length - 1), ...rest].join('\n')

// One message for a session, a JSON line in sessions/<key>.held. Phase 1 wrote and reads only `id` and `line`.
export interface Held {
  id: number
  line: string // as the Stop hook shows it: [time], the marks, the quote and the text, continuation lines indented
  text?: string // the message without the quote, marked when forwarded
  at?: string // the display time, with the age past 6 h
  ts?: number // createdAt, ms
  reply_to?: number // the message he swiped
  quote?: string // its preview
  forwarded?: boolean
}

// A file of JSON lines, such as .held. A line a crash cut short is skipped, and so is the empty last line.
const jsonLines = <T>(at: string) =>
  (readOr(at) ?? '').split('\n').flatMap((l): T[] => {
    try {
      return [JSON.parse(l)]
    } catch {
      return []
    }
  })
// Records as JSON lines, as jsonLines() reads them.
const jsonl = (xs: object[]) => xs.map((x) => JSON.stringify(x) + '\n').join('')
// Appends lines to session `key`'s .held.
const hold = (key: string, hs: Held[]) => appendFileSync(file(`sessions/${key}.held`), jsonl(hs), { mode: 0o600 })

const FORWARDED = '(forwarded; written by someone else) '
function held(m: Message, b: MessageBody): Held {
  const said = String(b.text ?? '') || '(sent a file, not shown)'
  const age = (Date.now() - m.createdAt) / 3_600_000 // hours
  const at = `${hhmm(m.createdAt)}${age > 6 ? `, ${Math.round(age)} h ago` : ''}`
  const reply = b.reply && { reply_to: Number(b.reply.id), quote: String(b.reply.preview ?? '') }
  // JSON-quoted, so a preview holding `") …` can't end the quote and pass its tail off as his words.
  const quote = reply ? `(reply to message ${reply.reply_to}, quoted: ${json(reply.quote.replace(/\s+/g, ' '))}) ` : ''
  // Indented continuation lines can't pass for messages of their own.
  const line = `[${at}] ${b.forwarded ? FORWARDED : ''}${quote}${said}`.split(BREAK).join('\n  ')
  return { id: m.id, line, text: (b.forwarded ? FORWARDED : '') + said, at, ts: m.createdAt, ...reply, ...(b.forwarded && { forwarded: true }) }
}

// inbox.lock holds "<pid> <lstart>", written with 'wx': live while that pid runs with that start time. A bare
// pid (Phase 1's) counts as dead. A dead holder's lock is stolen inside mkdir(inbox.lock.steal), so two
// stealers can't both take it; a .steal left by a crash goes after 10 s.
const LOCK = file('inbox.lock')
let lockLine: string | undefined
function grab(me: string) {
  try {
    writeFileSync(LOCK, me, { flag: 'wx', mode: 0o600 })
    return true
  } catch {}
  const was = readOr(LOCK)
  const [pid, ...start] = (was ?? '').split(' ')
  // Gone a moment ago, ours, still being written, or held: wait.
  if (was === undefined || was === me || (!was && fresh(LOCK, 10_000)) || (start.length && lstart(Number(pid)) === start.join(' '))) return false
  const steal = `${LOCK}.steal`
  try {
    mkdirSync(steal)
  } catch {
    if (!fresh(steal, 10_000)) rmSync(steal, { recursive: true, force: true })
    return false
  }
  try {
    if (readOr(LOCK) !== was) return false // another stealer was first
    rmSync(LOCK)
    writeFileSync(LOCK, me, { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  } finally {
    rmSync(steal, { recursive: true, force: true })
  }
}
// Runs f holding inbox.lock, once it is free within `wait` ms; undefined if it never was.
async function locked<T>(wait: number, f: () => Promise<T>) {
  const me = (lockLine ??= `${process.pid} ${lstart(process.pid)}`)
  for (const end = Date.now() + wait; !grab(me); await pause(100)) if (Date.now() >= end) return
  const release = () => void (readOr(LOCK) === me && rmSync(LOCK, { force: true }))
  process.once('exit', release) // a watchdog's or a signal's process.exit skips finally
  try {
    return await f()
  } finally {
    release()
    process.off('exit', release)
  }
}

// Receivers, the one the owner last traded messages with first: the newer of its .sent mtime (it wrote to him) and
// its `got` (he wrote to it). One with neither ranks last, the newest start first. Ties go to `self`, then the higher pid.
function ranked(rs: Marker[], self: string) {
  const at = new Map(rs.map((r) => [r, Math.max(statSync(file(`sessions/${r.key}.sent`), { throwIfNoEntry: false })?.mtimeMs ?? 0, r.got ?? 0)]))
  return rs.sort((a, b) => at.get(b)! - at.get(a)! || (at.get(a) ? 0 : b.started - a.started) || Number(b.key === self) - Number(a.key === self) || b.pid - a.pid)
}

// The owner's new messages since the cursor, each appended to exactly one session's .held by the rules below,
// then the cursor moves, all under inbox.lock. `self` is the caller's key; `after` skips the read when the
// cursor is already past the message that triggered it. Reactions, and with a socket the routing replies, follow.
// shortcut: a Stop hook routes with no socket, so it skips the Went to, Too late, ended and two-sessions replies; Prince still sees 👀 and the answering label.
export async function route(p: Paired, key: CryptoKey, self: string, o: { sock?: Socket; after?: number; wait?: number } = {}) {
  const marks: [number, string][] = []
  const replies: [Message, MessageBody, string][] = []
  const tell = (m: Message, b: MessageBody, text: string) => void (o.sock && replies.push([m, b, text]))
  await locked(o.wait ?? 10_000, async () => {
    const cursor = readProfile()?.cursor ?? 0 // another process may just have moved it
    if (o.after !== undefined && cursor >= o.after) return
    const news = await history(p, cursor)
    const bodies = await Promise.all(news.map((m) => gate(p, key, m)))
    // No await from here to the cursor: a Stop's watchdog can't land between the .held lines and the move.
    // Only the owner's messages route: with none, the asks file and the markers stay unread.
    if (!bodies.some(Boolean)) return void (news.length && patchProfile({ cursor: news.at(-1)!.id }))
    const asks = asked()
    // shortcut: a reply or a known code means reading every session's .sent file; prune old sessions if that ever shows.
    const sender = new Map<number, string>()
    if (bodies.some((b) => b?.reply || asks.codes.has(typed(String(b?.text ?? ''))?.code ?? '')))
      for (const f of readdirSync(file('sessions')))
        if (f.endsWith('.sent')) for (const id of readFileSync(file(`sessions/${f}`), 'utf8').split('\n')) if (id) sender.set(Number(id), f.slice(0, -5))
    const live = markers()
    const receivers = ranked(live.filter((r) => r.channel || r.waiting), self)

    // The key this message goes to, or undefined for none. The first rule that matches wins.
    const to = (m: Message, b: MessageBody): string | undefined => {
      const text = String(b.text ?? '')
      if (b.system || (!text && !b.files?.length)) return // group events and call logs
      // 1. Answers never route. A forwarded body is never an answer: it routes as a message.
      const t = b.forwarded ? undefined : typed(text)
      const ids = t && asks.codes.get(t.code)
      if (t && ids) {
        if (asks.ids.has(m.id)) return // the answer its ask took
        // 2. A note on a known code goes to the session that asked, whatever it replies to.
        // shortcut: a route that reads a note the moment before its open ask takes it holds it too: Claude gets it twice, and 👀 replaces the ❌.
        if (t.note && !asks.relay.has(t.code)) {
          const asker = ids.map((id) => sender.get(id)).find(Boolean)
          if (!asker) marks.push([m.id, '❓']) // no session asked it: a CLI ask run outside Claude Code
          return asker
        }
        if (!ids.includes(-1)) return
        // Its ask had closed, so this did nothing: ⏳, and once per code, a reply that says so.
        marks.push([m.id, '⏳'])
        if (o.sock && !ids.includes(-2)) {
          ids.push(-2)
          record(-2, t.code)
          tell(m, b, `Too late: ${t.code} already closed, so this did nothing. The question shows what happened.`)
        }
        return
      }
      // A plain yes or no swiped at an ask or its reminder is its answer. Unswiped it answers nothing (❓), unless it's chat here.
      if (!b.forwarded && PLAIN.test(text) && (b.reply ? asks.ids.has(Number(b.reply.id)) : !CHAT)) {
        if (!b.reply) marks.push([m.id, '❓'])
        return
      }
      // 3. A swipe-reply goes to the session that sent the quoted message. An mcp- key never comes back once its process ends.
      // shortcut: a hook-only session that quit keeps its .held lines; check its CLAUDE_PID if Prince misses replies.
      const swiped = b.reply && sender.get(Number(b.reply.id))
      if (swiped && (!swiped.startsWith('mcp-') || live.some((r) => r.key === swiped))) {
        const ended = readOr(file(`sessions/${swiped}.ended`))
        if (ended !== undefined) {
          marks.push([m.id, '❓'])
          tell(m, b, `${ended || 'That session'} has ended, so nothing reads this until you resume it. Send it again without a swipe to reach another session.`)
        }
        return swiped
      }
      // 4. A live receiver's label and a colon pick it.
      const named = receivers.filter((r) => r.label && text.trimStart().toLowerCase().startsWith(`${r.label.toLowerCase()}:`))
      if (named.length > 1) {
        marks.push([m.id, '❓'])
        tell(m, b, `Two sessions are called ${named[0].label}. Swipe-reply to the one you mean.`)
        return
      }
      if (named.length) return named[0].key
      // 5. The receiver he last traded messages with. 6. With none, the caller: Phase 1's next session to end a turn.
      const [top, ...others] = receivers
      if (!top) return self
      if (others.length && o.sock && !fresh(file('wentto'), TEN_MINUTES)) {
        writeFileSync(file('wentto'), '')
        tell(m, b, `Went to ${top.label}. To pick a session, start with its name and a colon, like ${others.find((r) => r.label)?.label ?? top.label}: …`)
      }
      return top.key
    }

    for (const [i, m] of news.entries()) {
      const b = bodies[i]
      const k = b && to(m, b)
      if (k) hold(k, [held(m, b)])
    }
    // Past the agent's own messages too: the DM has two members, and ids only grow.
    if (news.length) patchProfile({ cursor: news.at(-1)!.id })
  })
  await Promise.all([
    ...marks.map(([id, emoji]) => react(p, key, id, emoji).catch(() => {})),
    ...replies.map(([m, b, text]) => send(o.sock!, p, key, { text, reply: { id: m.id, from: p.owner.id, preview: String(b.text ?? '').slice(0, 200) } }, { quiet: true }).catch(() => {})),
  ])
}

// Hands session `self` its held lines, oldest first: under inbox.lock they move to .taking.<pid>, as many as fit
// in `cap` characters (the first always goes) and `limit` lines; then 👀 goes on the first. The caller delivers
// them, then calls done(), or back() if it can't. A process that dies before either leaves them for the next take with that key.
// shortcut: a .taking file is adopted once its pid is dead, so a reused pid holds it until that process exits; add the lstart to the name if lines ever stall.
export async function take(p: Paired, key: CryptoKey, self: string, o: { cap?: number; limit?: number; wait?: number } = {}) {
  const at = (f: string) => file(`sessions/${f}`)
  const mine = at(`${self}.taking.${process.pid}`)
  // Whole files: a tmp file, then rename. A key never starts with a dot.
  const put = (to: string, hs: Held[]) => {
    if (!hs.length) return rmSync(to, { force: true })
    writeFileSync(at(`.${process.pid}.tmp`), jsonl(hs), { mode: 0o600 })
    renameSync(at(`.${process.pid}.tmp`), to)
  }
  const got = await locked(o.wait ?? 10_000, async () => {
    const adopted = readdirSync(file('sessions')).filter((f) => {
      const pid = Number(f.slice(self.length + 8))
      return f.startsWith(`${self}.taking.`) && (pid === process.pid || !alive(pid))
    })
    const all = [...adopted, `${self}.held`]
      .flatMap((f) => jsonLines<Held>(at(f)))
      .sort((a, b) => a.id - b.id)
      .filter((h, i, a) => !i || h.id !== a[i - 1].id) // a kill mid-take can leave a line in two files
    let n = 0
    for (let size = 0; n < all.length && n < (o.limit ?? Infinity) && (!n || size + 1 + all[n].line.length <= (o.cap ?? Infinity)); n++) size += 1 + all[n].line.length
    put(mine, all.slice(0, n))
    put(at(`${self}.held`), all.slice(n))
    for (const f of adopted) if (at(f) !== mine) rmSync(at(f), { force: true })
    return { lines: all.slice(0, n), cursor: readProfile()?.cursor ?? 0 }
  })
  if (!got?.lines.length) return
  // The first 👀 alone, before delivery: 403 means the owner blocked the agent, so nothing more reaches Claude.
  // 404 means he unsent it: it goes, and the next line takes its place.
  let status: number
  while ((status = await react(p, key, got.lines[0].id, '👀').catch(() => 0)) === 404) {
    log('inbox', { count: 0, why: 'unsent', id: got.lines.shift()!.id })
    put(mine, got.lines)
    if (!got.lines.length) return
  }
  if (status === 403) return void (rmSync(mine, { force: true }), log('inbox', { count: 0, why: 'blocked' }))
  // Talk out of reach, or a caller that couldn't deliver them: the lines go back to .held for any later take, a
  // Stop's too, since no other process adopts a live one's .taking. Without the lock in time they stay in .taking,
  // for this process's next take.
  const back = () => locked(o.wait ?? 10_000, async () => (hold(self, got.lines), rmSync(mine, { force: true })))
  if (status < 200 || status >= 300) return void (await back())
  return {
    lines: got.lines,
    back,
    // Delete first: a kill after delivery and before this delivers them twice, the only duplicate. Then the rest's 👀, and read.
    async done() {
      rmSync(mine, { force: true })
      await Promise.all([...got.lines.slice(1).map((l) => react(p, key, l.id, '👀').catch(() => {})), read(p, got.cursor).catch(() => {})])
    },
  }
}

// Plan B (4.1): Claude Code never says it registered a channel, but each event it takes lands in the session's
// transcript within milliseconds, JSON-escaped as message_id=\"<id>\". So a channel process notes what it delivered
// in .delivered, and the Stop hook looks for each line delivered over 10 s ago. A missing one was lost: it goes back
// to .held for that Stop, and .nochannel turns the process plain. Both run under the lock: Stop rewrites the file.
// shortcut: Stop checks delivery by searching the transcript for message_id; drop this if Claude Code ever confirms registration.
type Delivered = Held & { t: number } // t: when it went out
export const delivered = (key: string, hs: Held[]) =>
  locked(10_000, async () => appendFileSync(file(`sessions/${key}.delivered`), jsonl(hs.map((h) => ({ ...h, t: Date.now() }))), { mode: 0o600 }))

// True when some line never reached the transcript. /clear starts a new transcript file in the same folder, so the
// files there written since the oldest line count too. Checked lines leave .delivered.
const lost = async (key: string, transcript: string, wait: number) =>
  !!(await locked(wait, async () => {
    const at = (ext: string) => file(`sessions/${key}.${ext}`)
    const now = Date.now()
    const all = jsonLines<Delivered>(at('delivered'))
    const old = all.filter((d) => now - d.t > 10_000)
    if (!old.length) return false
    const dir = path.dirname(transcript)
    const since = Math.min(...old.map((d) => d.t))
    const files = readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => f.endsWith('.jsonl') && statSync(f).mtimeMs >= since)
    // Its own transcript first, read as bytes: it usually shows every line, and then no other file is read.
    let gone = old
    for (const f of files.sort((a, b) => Number(b === transcript) - Number(a === transcript))) {
      if (!gone.length) break
      const bytes = readFileSync(f)
      gone = gone.filter((d) => !bytes.includes(`message_id=\\"${d.id}\\"`))
    }
    writeFileSync(at('delivered'), jsonl(all.filter((d) => now - d.t <= 10_000)), { mode: 0o600 })
    if (!gone.length) return false
    hold(key, gone.map(({ t, ...h }) => h))
    writeFileSync(at('nochannel'), '', { mode: 0o600 })
    log('inbox', { count: gone.length, why: 'unseen' })
    return true
  }))
