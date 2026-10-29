import express from 'express'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'
import { db, BLOB_DIR, setting, blocks, isMember, memberIds } from './db.ts'
import { authMatches, hashAuth, setSession, clearSession, userFromCookie, requireUser, throttled, recordFail } from './auth.ts'
import { vapidPublicKey, saveSubscription, notifyIfAway } from './push.ts'
import { callHandlers, callState } from './calls.ts'
import type { Conversation, Me, Message, SendPayload, User } from '../shared/types.ts'

const PORT = Number(process.env.PORT ?? 3000)
const MAX_FILE = 50 * 1024 * 1024
const SETUP_CODE = setting('SETUP_CODE', () => randomBytes(12).toString('base64url'))

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const B64 = /^[\w-]+$/
const isName = (v: unknown): v is string => typeof v === 'string' && /^[\p{L}\p{N} ._-]{1,32}$/u.test(v) && v.trim() === v
const isPubkey = (v: unknown): v is string => typeof v === 'string' && v.length === 43 && B64.test(v)
const isAuth = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const isSealed = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && B64.test(v)

const userCount = () => (db.prepare('select count(*) as n from users').get() as { n: number }).n
const userExists = (id: string) => !!db.prepare('select 1 from users where id = ? and deleted_at is null').get(id)
// Hides messages from people `?` blocked, in groups (DMs refuse them at send).
const NOT_BLOCKED = 'sender_id not in (select blocked_id from blocks where user_id = ?)'

const app = express()
const server = createServer(app)
const io = new Server(server, { maxHttpBufferSize: 256 * 1024 })

app.set('trust proxy', 1)
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "frame-ancestors 'none'",
  })
  next()
})
app.use('/api', express.json({ limit: '256kb' }))

app.get('/healthz', (_req, res) => void res.send('ok'))

// --- accounts ---

app.post('/api/register', (req, res) => {
  const { invite, name, pubkey, auth } = req.body ?? {}
  if (typeof invite !== 'string' || !isName(name) || !isPubkey(pubkey) || !isAuth(auth))
    return void res.status(400).json({ error: 'bad request' })
  const setup = userCount() === 0 && invite === SETUP_CODE
  const valid = setup || !!db.prepare('select 1 from invites where code = ? and expires_at > ?').get(invite, Date.now())
  if (!valid) return void res.status(403).json({ error: 'This invite is not valid or has expired.' })
  if (db.prepare('select 1 from users where name = ?').get(name))
    return void res.status(409).json({ error: 'That name is taken.' })
  const id = randomUUID()
  db.prepare('insert into users (id, name, pubkey, auth_hash, created_at) values (?, ?, ?, ?, ?)').run(
    id, name, pubkey, hashAuth(auth), Date.now(),
  )
  db.prepare('delete from invites where code = ?').run(invite)
  setSession(res, id)
  res.json({ id })
})

app.post('/api/login', (req, res) => {
  const { name, auth } = req.body ?? {}
  if (!isName(name) || !isAuth(auth)) return void res.status(400).json({ error: 'bad request' })
  if (throttled()) return void res.status(429).json({ error: 'Too many wrong tries. Wait a minute.' })
  const row = db.prepare('select id, auth_hash from users where name = ?').get(name) as
    | { id: string; auth_hash: string }
    | undefined
  if (!row || !authMatches(auth, row.auth_hash)) {
    recordFail()
    return void res.status(401).json({ error: 'Wrong name or passphrase.' })
  }
  setSession(res, row.id)
  res.json({ id: row.id })
})

app.post('/api/logout', (_req, res) => {
  clearSession(res)
  res.json({ ok: true })
})

app.use('/api', requireUser, (req, res, next) => (userExists(req.userId) ? next() : void res.status(401).json({ error: 'signed out' })))

app.get('/api/me', (req, res) => {
  const user = db.prepare('select id, name, pubkey from users where id = ?').get(req.userId) as unknown as User
  // Deleted accounts keep their public key: keys they sealed for others still open.
  const users = (
    db.prepare(`select id, case when deleted_at is null then name else 'Deleted account' end as name, pubkey, deleted_at as deleted from users order by name`).all() as unknown as User[]
  ).map(({ deleted, ...u }) => (deleted ? { ...u, deleted: true } : u))
  const blocked = (db.prepare('select blocked_id as id from blocks where user_id = ?').all(req.userId) as { id: string }[]).map((r) => r.id)
  const rows = db
    .prepare(
      `select c.id, c.kind, c.title, m.wrapped_key as wrappedKey, m.wrapped_by as wrappedBy,
         (select max(created_at) from messages where conv_id = c.id) as lastMessageAt,
         (select count(*) from messages where conv_id = c.id and id > m.last_read and sender_id != m.user_id and ${NOT_BLOCKED}) as unread
       from conversations c join members m on m.conv_id = c.id and m.user_id = ?
       order by coalesce(lastMessageAt, c.created_at) desc`,
    )
    .all(req.userId, req.userId) as unknown as Omit<Conversation, 'members' | 'lastMessage'>[]
  const last = db.prepare(
    `select id, conv_id as convId, sender_id as senderId, body, created_at as createdAt
     from messages where conv_id = ? and ${NOT_BLOCKED} order by id desc limit 1`,
  )
  const conversations = rows.map((c) => ({
    ...c,
    members: memberIds(c.id),
    lastMessage: (last.get(c.id, req.userId) as unknown as Message | undefined) ?? null,
  }))
  res.json({ user, users, conversations, blocked, vapidPublicKey } satisfies Me)
})

// Deletes the account for good: sign-in, devices, memberships and every
// message it sent. Asks for the passphrase-derived auth again first.
app.delete('/api/me', (req, res) => {
  const { auth } = req.body ?? {}
  const row = db.prepare('select auth_hash from users where id = ?').get(req.userId) as { auth_hash: string }
  if (!isAuth(auth) || !authMatches(auth, row.auth_hash)) return void res.status(403).json({ error: 'Wrong passphrase.' })
  const convs = (db.prepare('select conv_id as id from members where user_id = ?').all(req.userId) as { id: string }[]).map((r) => r.id)
  const others = new Set(convs.flatMap(memberIds))
  db.exec('begin')
  try {
    for (const sql of [
      'delete from messages where sender_id = ?',
      'delete from members where user_id = ?',
      'delete from invites where created_by = ?',
      'delete from push_subs where user_id = ?',
      'delete from devices where user_id = ?',
      'delete from blocks where user_id = ?1 or blocked_id = ?1',
      'delete from reports where reporter_id = ?',
    ]) db.prepare(sql).run(req.userId)
    // shortcut: attachment blobs stay on disk (sealed, now unreachable); sweep orphans if storage matters.
    db.prepare(`update users set name = id, auth_hash = '', deleted_at = ? where id = ?`).run(Date.now(), req.userId)
    db.exec('commit')
  } catch (e) {
    db.exec('rollback')
    throw e
  }
  io.in(`user:${req.userId}`).disconnectSockets(true)
  sync([...others])
  clearSession(res)
  res.json({ ok: true })
})

app.post('/api/invites', (req, res) => {
  const code = randomBytes(12).toString('base64url')
  const expiresAt = Date.now() + 7 * 24 * 3600 * 1000
  db.prepare('insert into invites (code, created_by, expires_at) values (?, ?, ?)').run(code, req.userId, expiresAt)
  res.json({ code, expiresAt })
})

app.post('/api/push', (req, res) => {
  const sub = req.body?.subscription
  if (typeof sub?.endpoint !== 'string' || !sub.endpoint.startsWith('https://'))
    return void res.status(400).json({ error: 'bad subscription' })
  saveSubscription(req.userId, sub)
  res.json({ ok: true })
})

// iPhone push tokens (hex, from APNs). One phone has an alert token and a
// VoIP token; a token moves to whoever signs in on that phone last.
app.post('/api/devices', (req, res) => {
  const { token, kind, env } = req.body ?? {}
  if (typeof token !== 'string' || !/^[0-9a-f]{64,200}$/.test(token) || (kind !== 'alert' && kind !== 'voip') || (env !== 'sandbox' && env !== 'production'))
    return void res.status(400).json({ error: 'bad request' })
  db.prepare('insert or replace into devices (token, user_id, kind, env, created_at) values (?, ?, ?, ?, ?)').run(token, req.userId, kind, env, Date.now())
  res.json({ ok: true })
})

// Called on sign-out, so the phone stops getting this account's pushes.
app.delete('/api/devices/:token', (req, res) => {
  db.prepare('delete from devices where token = ? and user_id = ?').run(req.params.token, req.userId)
  res.json({ ok: true })
})

// Blocking hides someone's messages and calls from you; in a DM neither side
// can send or call until it's lifted.
app.put('/api/blocks/:userId', (req, res) => {
  if (req.params.userId === req.userId || !userExists(req.params.userId)) return void res.status(400).json({ error: 'bad request' })
  db.prepare('insert or ignore into blocks (user_id, blocked_id) values (?, ?)').run(req.userId, req.params.userId)
  sync([req.userId])
  res.json({ ok: true })
})

app.delete('/api/blocks/:userId', (req, res) => {
  db.prepare('delete from blocks where user_id = ? and blocked_id = ?').run(req.userId, req.params.userId)
  sync([req.userId])
  res.json({ ok: true })
})

// Messages are end-to-end encrypted, so a report carries what the reporter
// chose to quote. It also blocks. The server's owner reads reports in the logs.
app.post('/api/reports', (req, res) => {
  const { userId, convId, note } = req.body ?? {}
  if (typeof userId !== 'string' || userId === req.userId || !userExists(userId) ||
      (convId != null && (typeof convId !== 'string' || !isMember(convId, req.userId))) ||
      (note != null && (typeof note !== 'string' || note.length > 2000)))
    return void res.status(400).json({ error: 'bad request' })
  db.prepare('insert into reports (reporter_id, user_id, conv_id, note, created_at) values (?, ?, ?, ?, ?)').run(req.userId, userId, convId ?? null, note ?? null, Date.now())
  db.prepare('insert or ignore into blocks (user_id, blocked_id) values (?, ?)').run(req.userId, userId)
  console.log(`[report] ${req.userId} reported ${userId}${convId ? ` in ${convId}` : ''}: ${JSON.stringify(note ?? '')}`)
  sync([req.userId])
  res.json({ ok: true })
})

app.get('/api/calls/:id', (req, res) => {
  const call = callState(req.params.id, req.userId)
  if (!call) return void res.status(404).json({ error: 'This call has ended.' })
  res.set('Cache-Control', 'no-store').json(call)
})

// Cloudflare TURN relays calls that can't connect directly (cellular, strict
// NATs). One 24h credential is shared and refreshed every 12h, so each one
// handed out still has 12h left.
type IceServer = { urls: string | string[]; username?: string; credential?: string }
let ice: { servers: IceServer[]; until: number } | undefined
app.get('/api/ice', async (_req, res) => {
  const { CF_TURN_KEY_ID: key, CF_TURN_API_TOKEN: token } = process.env
  if (!key || !token) return void res.json([{ urls: 'stun:stun.cloudflare.com:3478' }])
  if (!ice || ice.until < Date.now()) {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${key}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    })
    if (!r.ok) throw new Error(`TURN credentials: HTTP ${r.status}`)
    const { iceServers } = (await r.json()) as { iceServers: IceServer[] }
    // Browsers block port 53, so those URLs only ever time out.
    const servers = iceServers.map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => !/:53\b/.test(u)) }))
    ice = { servers, until: Date.now() + 12 * 3600 * 1000 }
  }
  res.set('Cache-Control', 'no-store').json(ice.servers)
})

// --- conversations ---

const sync = (userIds: string[]) => io.to(userIds.map((u) => `user:${u}`)).emit('sync')

app.post('/api/conversations', (req, res) => {
  const { id, kind, title, members } = req.body ?? {}
  const list = Array.isArray(members) ? (members as { userId: unknown; wrappedKey: unknown }[]) : []
  const ids = list.map((m) => m.userId)
  const ok =
    typeof id === 'string' && UUID.test(id) &&
    (kind === 'dm' ? list.length === 2 && title == null : kind === 'group' && list.length >= 2 && isName(title)) &&
    new Set(ids).size === ids.length && ids.includes(req.userId) &&
    list.every((m) => typeof m.userId === 'string' && userExists(m.userId) && isSealed(m.wrappedKey, 200))
  if (!ok) return void res.status(400).json({ error: 'bad request' })

  if (kind === 'dm') {
    const other = ids.find((u) => u !== req.userId) as string
    const existing = db
      .prepare(
        `select c.id from conversations c
         join members a on a.conv_id = c.id and a.user_id = ?
         join members b on b.conv_id = c.id and b.user_id = ?
         where c.kind = 'dm'`,
      )
      .get(req.userId, other) as { id: string } | undefined
    if (existing) return void res.status(409).json({ error: 'exists', id: existing.id })
  }

  db.exec('begin')
  try {
    db.prepare('insert into conversations (id, kind, title, created_at) values (?, ?, ?, ?)').run(id, kind, title ?? null, Date.now())
    const add = db.prepare('insert into members (conv_id, user_id, wrapped_key, wrapped_by) values (?, ?, ?, ?)')
    for (const m of list) add.run(id, m.userId as string, m.wrappedKey as string, req.userId)
    db.exec('commit')
  } catch (e) {
    db.exec('rollback')
    throw e
  }
  sync(ids as string[])
  res.json({ id })
})

app.post('/api/conversations/:id/members', (req, res) => {
  const convId = req.params.id
  const { userId, wrappedKey } = req.body ?? {}
  const conv = db.prepare('select kind from conversations where id = ?').get(convId) as { kind: string } | undefined
  if (!conv || !isMember(convId, req.userId)) return void res.status(404).json({ error: 'not found' })
  if (conv.kind !== 'group' || typeof userId !== 'string' || !userExists(userId) || isMember(convId, userId) || !isSealed(wrappedKey, 200))
    return void res.status(400).json({ error: 'bad request' })
  db.prepare('insert into members (conv_id, user_id, wrapped_key, wrapped_by) values (?, ?, ?, ?)').run(convId, userId, wrappedKey, req.userId)
  sync(memberIds(convId))
  res.json({ ok: true })
})

app.get('/api/conversations/:id/messages', (req, res) => {
  const convId = req.params.id
  if (!isMember(convId, req.userId)) return void res.status(404).json({ error: 'not found' })
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER
  const rows = db
    .prepare(
      `select id, conv_id as convId, sender_id as senderId, body, created_at as createdAt
        from messages where conv_id = ? and id < ? and ${NOT_BLOCKED} order by id desc limit 50`,
    )
    .all(convId, before, req.userId) as unknown as Message[]
  res.json(rows.reverse())
})

app.post('/api/conversations/:id/read', (req, res) => {
  const upTo = Number(req.body?.upTo)
  if (!Number.isSafeInteger(upTo)) return void res.status(400).json({ error: 'bad request' })
  db.prepare('update members set last_read = max(last_read, ?) where conv_id = ? and user_id = ?').run(upTo, req.params.id, req.userId)
  res.json({ ok: true })
})

// --- attachments: encrypted bytes only ---

app.post(
  '/api/conversations/:id/attachments',
  express.raw({ type: () => true, limit: MAX_FILE + 1024 }),
  (req, res) => {
    const convId = req.params.id
    if (!isMember(convId, req.userId)) return void res.status(404).json({ error: 'not found' })
    if (!Buffer.isBuffer(req.body) || !req.body.length) return void res.status(400).json({ error: 'empty file' })
    const id = randomUUID()
    writeFileSync(path.join(BLOB_DIR, id), req.body)
    db.prepare('insert into attachments (id, conv_id, size, created_at) values (?, ?, ?, ?)').run(id, convId, req.body.length, Date.now())
    res.json({ id })
  },
)

app.get('/api/attachments/:id', (req, res) => {
  const row = db.prepare('select conv_id from attachments where id = ?').get(req.params.id) as { conv_id: string } | undefined
  if (!row || !isMember(row.conv_id, req.userId)) return void res.status(404).json({ error: 'not found' })
  // Headers via options so they only apply when the file is actually served;
  // a cached error would otherwise stick for a year.
  res.sendFile(path.join(BLOB_DIR, req.params.id), {
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' },
  })
})

// --- realtime ---

io.use((socket, next) => {
  const id = userFromCookie(socket.handshake.headers.cookie)
  if (!id || !userExists(id)) return next(new Error('signed out'))
  socket.data.userId = id
  socket.data.active = true
  next()
})

const calls = callHandlers(io)

io.on('connection', (socket) => {
  const me = socket.data.userId as string
  socket.join(`user:${me}`)

  // Client reports page visibility; a user with no visible tab gets a push.
  socket.on('active', (v: unknown) => void (socket.data.active = !!v))

  socket.on('send', (p: SendPayload, ack: (r: { message?: Message; error?: string }) => void) => {
    if (typeof ack !== 'function') return
    if (typeof p?.convId !== 'string' || !isSealed(p.body, 64 * 1024) || !isMember(p.convId, me))
      return ack({ error: 'bad request' })
    const members = memberIds(p.convId)
    const dm = (db.prepare('select kind from conversations where id = ?').get(p.convId) as { kind: string }).kind === 'dm'
    const other = dm ? members.find((u) => u !== me) : undefined
    if (other && blocks(me, other)) return ack({ error: 'Unblock this person to message them.' })
    if (other && blocks(other, me)) return ack({ error: 'This person isn’t taking messages from you.' })
    const createdAt = Date.now()
    const { lastInsertRowid } = db
      .prepare('insert into messages (conv_id, sender_id, body, created_at) values (?, ?, ?, ?)')
      .run(p.convId, me, p.body, createdAt)
    const message: Message = { id: Number(lastInsertRowid), convId: p.convId, senderId: me, body: p.body, createdAt }
    const to = members.filter((u) => !blocks(u, me))
    io.to(to.map((u) => `user:${u}`)).emit('message', message)
    ack({ message })

    if (p.quiet) return
    const sender = (db.prepare('select name from users where id = ?').get(me) as { name: string }).name
    for (const u of to) if (u !== me)
      notifyIfAway(io, u, { title: sender, body: 'New message', convId: p.convId }, { apns: { type: 'message', convId: p.convId, messageId: message.id } })
  })

  calls(socket)
})

// --- SPA ---

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
app.use(express.static(dist))
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')))

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  res.set('Cache-Control', 'no-store')
  res.status((err as { status?: number }).status ?? 500).json({ error: 'server error' })
})

server.listen(PORT, () => {
  console.log(`talk on :${PORT}`)
  if (userCount() === 0) console.log(`No accounts yet. Create the first one at /?invite=${SETUP_CODE}`)
})
