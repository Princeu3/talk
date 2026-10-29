import express from 'express'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'
import { db, BLOB_DIR, setting, isMember, memberIds } from './db.ts'
import { authMatches, hashAuth, setSession, clearSession, userFromCookie, requireUser, throttled, recordFail } from './auth.ts'
import { vapidPublicKey, saveSubscription, notifyIfAway } from './push.ts'
import { callHandlers } from './calls.ts'
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
const userExists = (id: string) => !!db.prepare('select 1 from users where id = ?').get(id)

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

app.use('/api', requireUser)

app.get('/api/me', (req, res) => {
  const user = db.prepare('select id, name, pubkey from users where id = ?').get(req.userId) as User | undefined
  if (!user) return void res.status(401).json({ error: 'signed out' })
  const users = db.prepare('select id, name, pubkey from users order by name').all() as unknown as User[]
  const rows = db
    .prepare(
      `select c.id, c.kind, c.title, m.wrapped_key as wrappedKey, m.wrapped_by as wrappedBy,
         (select max(created_at) from messages where conv_id = c.id) as lastMessageAt,
         (select count(*) from messages where conv_id = c.id and id > m.last_read and sender_id != m.user_id) as unread
       from conversations c join members m on m.conv_id = c.id and m.user_id = ?
       order by coalesce(lastMessageAt, c.created_at) desc`,
    )
    .all(req.userId) as unknown as Omit<Conversation, 'members' | 'lastMessage'>[]
  const last = db.prepare(
    `select id, conv_id as convId, sender_id as senderId, body, created_at as createdAt
     from messages where conv_id = ? order by id desc limit 1`,
  )
  const conversations = rows.map((c) => ({
    ...c,
    members: memberIds(c.id),
    lastMessage: (last.get(c.id) as unknown as Message | undefined) ?? null,
  }))
  res.json({ user, users, conversations, vapidPublicKey } satisfies Me)
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
       from messages where conv_id = ? and id < ? order by id desc limit 50`,
    )
    .all(convId, before) as unknown as Message[]
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
    const createdAt = Date.now()
    const { lastInsertRowid } = db
      .prepare('insert into messages (conv_id, sender_id, body, created_at) values (?, ?, ?, ?)')
      .run(p.convId, me, p.body, createdAt)
    const message: Message = { id: Number(lastInsertRowid), convId: p.convId, senderId: me, body: p.body, createdAt }
    const members = memberIds(p.convId)
    io.to(members.map((u) => `user:${u}`)).emit('message', message)
    ack({ message })

    if (p.quiet) return
    const sender = (db.prepare('select name from users where id = ?').get(me) as { name: string }).name
    for (const u of members) if (u !== me) notifyIfAway(io, u, { title: sender, body: 'New message', convId: p.convId })
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
