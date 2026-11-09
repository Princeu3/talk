// The Talk client under talkline: the profile on disk, HTTP with the helper's
// token (or a Phase 0 session cookie), the socket, sealed messages and the events
// log. All crypto comes from the apps' own src/lib/crypto.ts.
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Socket } from 'socket.io-client'
import { openMessage, sealMessage, unb64 } from '../src/lib/crypto.ts'
import type { Message, MessageBody, ReactionBody } from '../shared/types.ts'

export const HOME = process.env.TALKLINE_HOME || path.join(homedir(), '.talkline')
export const CLI = fileURLToPath(new URL('cli.ts', import.meta.url))
export const file = (name: string) => path.join(HOME, name)
const PROFILE = file('profile.json')

export interface Profile {
  server: string // origin, from the link
  agent: { id: string; name: string; pubkey: string; passphrase: string; auth: string }
  token?: string // a helper's bearer token (Phase 1)
  cookie?: string // "talk_session=...", Phase 0 profiles only: a person account
  owner?: { id: string; name: string; pubkey: string } // pinned at pairing: the id and key from the link
  dm?: { id: string; key: string } // raw DM key, base64url
  cursor?: number // Stop-hook inbox: the last message id in the DM already handled
  loginFailedAt?: number // when signing in again last got 401 (the account is gone)
}
export type Paired = Profile & Required<Pick<Profile, 'owner' | 'dm'>>

export function home() {
  mkdirSync(file('sessions'), { recursive: true, mode: 0o700 })
  chmodSync(HOME, 0o700) // mkdir leaves an existing dir's mode alone
}

export const readProfile = (): Profile | null => (existsSync(PROFILE) ? JSON.parse(readFileSync(PROFILE, 'utf8')) : null)

export function paired(): Paired {
  const p = readProfile()
  if (!p?.owner || !p.dm) throw new Error('Not paired. Run pair first.')
  return p as Paired
}

export function saveProfile(p: Profile) {
  home()
  const tmp = `${PROFILE}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(tmp, PROFILE)
}

// shortcut: re-read, patch, write keeps the race between two hooks small, not closed; add a lock if they ever collide.
export function patchProfile(change: Partial<Profile>) {
  const p = readProfile()
  if (p) saveProfile({ ...p, ...change })
}

// One JSON line per event, never message text. A failed write never breaks a command.
export function log(ev: string, fields: Record<string, unknown> = {}) {
  try {
    home()
    appendFileSync(file('events.jsonl'), JSON.stringify({ t: new Date().toISOString(), ev, ...fields }) + '\n', { mode: 0o600 })
  } catch {}
}

export const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// A Claude Code session id, safe as a file name.
export const sessionId = (v: unknown) => String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '')
// What a session sent the owner, a message id a line, so the Stop inbox gives a swipe-reply to it back to that session.
export const noteSent = (sid: string, id: number) => (home(), appendFileSync(file(`sessions/${sid}.sent`), `${id}\n`, { mode: 0o600 }))

// When a process started, as ps prints it, or '' once it's gone. A reused pid has another start time.
export function lstart(pid: number) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

// mcp/<claudePid>.json: a running `talkline mcp`. `key` names its session files, `got` is when it last took
// a message from the owner, and `waiting` is true while an ask or wait_for_reply call waits.
export interface Marker {
  pid: number
  lstart: string
  key: string
  channel: boolean
  label: string
  started: number
  got?: number
  waiting?: boolean
}
// shortcut: dead markers stay in mcp/ until their CLAUDE_PID starts a new server; sweep them at start if the folder grows.
export function marker(name: string): Marker | undefined {
  try {
    const m: Marker = JSON.parse(readFileSync(file(`mcp/${name}`), 'utf8'))
    return m.lstart && lstart(m.pid) === m.lstart ? m : undefined
  } catch {}
}
export const markers = () => (existsSync(file('mcp')) ? readdirSync(file('mcp')) : []).filter((f) => f.endsWith('.json')).flatMap((f) => marker(f) ?? [])
// The key a hook or a CLI run files its session's .sent, .last and .held under: a live talkline mcp's
// for this Claude Code process, which keeps its key across /clear, else the session id.
export const sessionKey = (sid: string) => (Number(process.env.CLAUDE_PID) && marker(`${Number(process.env.CLAUDE_PID)}.json`)?.key) || sid

// --- HTTP ---

// Per request and per socket connect. The Stop and Notification hooks lower it, so a dead network can't hold up Claude Code.
export const limits = { ms: 15_000 }

export const authHeader = (p: Profile): Record<string, string> =>
  p.token ? { authorization: `Bearer ${p.token}` } : p.cookie ? { cookie: p.cookie } : {}

// A helper's token is never refreshed: 401 means its owner removed it (or denied it).
export const REMOVED = 'Removed in Talk. Run unpair --yes, then link a new helper.'

export async function call(server: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(server + url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(limits.ms),
  }).catch(() => {
    throw new Error(`Could not reach ${server}.`)
  })
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] }
}

// The login throttle is server-wide (10 wrong tries a minute block every login), so sign in again
// at most once per process, only after the server said signed out, and in no process for 10 minutes
// after a try got 401: every hook is a new process, and a gone account would fail at each one.
// Every 401 in the process waits for that one sign-in, and retries if it worked. Phase 0 cookies only.
let relogging: Promise<boolean> | undefined
const relogin = (p: Profile) =>
  (relogging ??= (async () => {
    if (p.token || Date.now() - (p.loginFailedAt ?? 0) < 600_000) return false
    const r = await call(p.server, 'POST', '/api/login', { name: p.agent.name, auth: p.agent.auth })
    if (r.status === 401) patchProfile({ loginFailedAt: (p.loginFailedAt = Date.now()) })
    if (r.status !== 200 || !r.cookie) return false
    p.cookie = r.cookie
    patchProfile({ cookie: r.cookie })
    return true
  })())

export async function request(p: Profile, method: string, url: string, body?: unknown) {
  const r = await call(p.server, method, url, body, authHeader(p))
  return r.status === 401 && (await relogin(p)) ? call(p.server, method, url, body, authHeader(p)) : r
}

export async function api<T = unknown>(p: Profile, method: string, url: string, body?: unknown): Promise<T> {
  const r = await request(p, method, url, body)
  if (r.status === 401 && p.token) throw new Error(REMOVED)
  if (r.status >= 300) throw new Error(`${method} ${url}: ${r.data?.error ?? r.status}`)
  return r.data
}

// --- the socket ---

// Resolves once connected. Calls to the agent, from anyone, are declined at once: talkline has no voice,
// and a ringing call would keep the agent's own ring from starting. `onDead` hears of a session Talk
// refuses or drops after the connect, which socket.io won't retry. socket.io-client loads here, so Stop runs skip it.
export async function connect(p: Profile, onDead?: (e: Error) => void): Promise<Socket> {
  const { io } = await import('socket.io-client')
  const s = io(p.server, { extraHeaders: authHeader(p), transports: ['websocket'], query: { v: '1' } })
  s.on('call:ring', (c: { id: string }) => s.emit('call:hangup', { id: c.id }))
  return new Promise((resolve, reject) => {
    const fail = (message: string) => (clearTimeout(timer), s.close(), reject(new Error(message)), onDead?.(new Error(message)))
    const timer = setTimeout(() => fail(`Could not reach ${p.server}.`), limits.ms)
    s.once('connect', () => (clearTimeout(timer), resolve(s)))
    // Remove (or Deny) drops a helper's sockets, as deleting drops an account's.
    s.on('disconnect', (why) => why === 'io server disconnect' && fail(p.token ? REMOVED : 'Talk ended the session.'))
    s.on('connect_error', async (e: Error) => {
      if (s.active) return // a network failure: socket.io keeps retrying on its own
      if (p.token) return fail(e.message === 'signed out' ? REMOVED : `Talk refused the session: ${e.message}`)
      const refused = s.io.opts.extraHeaders?.cookie // the sign-in is shared: a cookie this socket already tried won't do
      if (e.message !== 'signed out' || !(await relogin(p).catch(() => false)) || p.cookie === refused) return fail(`Talk refused the session: ${e.message}`)
      s.io.opts.extraHeaders = authHeader(p)
      s.connect()
    })
  })
}

// Socket send only, always with a cid, so a resend after a lost ack stores once. While the
// socket is down socket.io holds the emit and flushes it on reconnect; a timeout drops it and we resend.
export async function send(s: Socket, p: Paired, key: CryptoKey, body: Omit<MessageBody, 'from'>, opts: { quiet?: boolean; seen?: boolean; level?: 'time-sensitive' } = {}) {
  const payload = { convId: p.dm.id, body: await sealMessage(key, p.dm.id, { from: p.agent.id, ...body }), ...opts, cid: crypto.randomUUID() }
  for (let tries = 0; tries < 3; tries++) {
    const r = await s.timeout(10_000).emitWithAck('send', payload).catch(() => null)
    if (r?.error) throw new Error(r.error)
    if (r) return r.message as Message
  }
  throw new Error('Talk did not confirm the message.')
}

// Sealed bytes as an attachment, by POST: call() is JSON only. 120 s, for 50 MB on a slow link.
export async function upload(p: Paired, sealed: Uint8Array<ArrayBuffer>) {
  const r = await fetch(`${p.server}/api/conversations/${p.dm.id}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...authHeader(p) },
    body: sealed,
    signal: AbortSignal.timeout(120_000),
  }).catch(() => {
    throw new Error(`Could not reach ${p.server}.`)
  })
  const data = await r.json().catch(() => null)
  if (r.status === 401 && p.token) throw new Error(REMOVED)
  if (r.status >= 300) throw new Error(`Talk refused the file: ${data?.error ?? r.status}`)
  return data.id as string
}

// One text on a socket of its own: notify, the pair hello, the notification hook.
export async function say(p: Paired, text: string, opts?: { quiet?: boolean }) {
  const s = await connect(p)
  try {
    return await send(s, p, await dmKey(p), { text }, opts)
  } finally {
    s.close()
  }
}

// --- messages ---

export const dmKey = (p: Paired) => crypto.subtle.importKey('raw', unb64(p.dm.key), 'AES-GCM', false, ['encrypt', 'decrypt'])

export const edit = async (p: Paired, key: CryptoKey, id: number, text: string) =>
  api(p, 'PATCH', `/api/messages/${id}`, { body: await sealMessage(key, p.dm.id, { from: p.agent.id, text } satisfies MessageBody) })

// Resolves to the HTTP status (403: the owner blocked the agent); rejects only when Talk can't be reached.
export const react = async (p: Paired, key: CryptoKey, id: number, emoji: string) =>
  (await request(p, 'PUT', `/api/messages/${id}/reaction`, { body: await sealMessage(key, p.dm.id, { from: p.agent.id, to: id, emoji } satisfies ReactionBody) })).status

export const read = (p: Paired, upTo: number) => api(p, 'POST', `/api/conversations/${p.dm.id}/read`, { upTo })

// Every message after `cursor`, oldest first. The API has no `after`: page back from the newest,
// 10 first (most reads want a few), then 500, the server's most. A short page holds the oldest.
export async function history(p: Paired, cursor: number) {
  const page = (limit: number, before?: number) =>
    api<Message[]>(p, 'GET', `/api/conversations/${p.dm.id}/messages?limit=${limit}${before ? `&before=${before}` : ''}`)
  let all: Message[] = []
  for (let limit = 10; ; limit = 500) {
    const last = await page(limit, all[0]?.id)
    all = [...last, ...all]
    if (last.length < limit || last[0].id <= cursor) return all.filter((m) => m.id > cursor)
  }
}

// The first message id each body of the owner's came under, by the body's IV: lines of "<iv> <id>".
// Read by byte offset: a process that lives for hours sees what other processes recorded since.
// shortcut: the seen file grows forever (about 25 bytes per owner message) and each run reads it whole; pair can reset it if it gets big.
// shortcut: ask's catch-up gates outside inbox.lock, so two processes could each take one replayed body in a narrow window; codes never repeat, so a replay can't answer an ask.
const ivs = new Map<string, number>()
let seenTo = 0
function seen() {
  const size = statSync(file('seen'), { throwIfNoEntry: false })?.size ?? 0
  if (size < seenTo) seenTo = 0 // the file was reset
  if (size > seenTo) {
    const fd = openSync(file('seen'), 'r')
    const buf = Buffer.alloc(size - seenTo)
    try {
      readSync(fd, buf, 0, buf.length, seenTo)
    } finally {
      closeSync(fd)
    }
    const end = buf.lastIndexOf(10) + 1 // a half-written line waits for the next read
    for (const l of buf.subarray(0, end).toString().split('\n')) {
      const [iv, id] = l.split(' ')
      if (id && !ivs.has(iv)) ivs.set(iv, Number(id))
    }
    seenTo += end
  }
  return ivs
}

// The owner gate: our DM, sent by the owner's account, opens with the DM key, its body says `from` the owner,
// and it's no replay.
export async function gate(p: Paired, key: CryptoKey, m: Message) {
  if (m.convId !== p.dm.id || m.senderId !== p.owner.id) return null
  const body = await openMessage<MessageBody>(key, m.convId, m.body).catch(() => null)
  if (body?.from !== p.owner.id) return null
  // The seal doesn't bind a message id: the server could send an old message of the owner's again under a new id.
  // A seal starts with its random 12-byte IV, so a body's first 16 chars name it. An edit keeps its id, so it passes.
  // No await from here to the set, so parallel gates can't both let one body through.
  const iv = m.body.slice(0, 16)
  const first = seen().get(iv)
  if (first !== undefined && first !== m.id) return null
  if (first === undefined) (seen().set(iv, m.id), appendFileSync(file('seen'), `${iv} ${m.id}\n`, { mode: 0o600 }))
  return body
}
