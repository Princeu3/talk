// Boots the real server against a temp data dir and drives it like three
// clients would: register, DM, group, realtime send, attachments, access checks.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { io as connect, type Socket } from 'socket.io-client'
import * as c from '../src/lib/crypto.ts'
import { blocked, parseHead } from '../server/unfurl.ts'
import type { GroupCall, Me, Message, MessageBody, ReactionBody } from '../shared/types.ts'

const PORT = 4000 + Math.floor(Math.random() * 1000)
const BASE = `http://localhost:${PORT}`
const dataDir = mkdtempSync(path.join(tmpdir(), 'talk-test-'))
let server: ChildProcess
const sockets: Socket[] = []

// Stands in for the APNs push relay and records what the server asks it to send.
const relayed: Record<string, unknown>[] = []
const relay = createServer((req, res) => {
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => (relayed.push(JSON.parse(b)), res.end('{}')))
})
const pushed = async (match: (p: Record<string, unknown>) => boolean) => {
  for (let i = 0; i < 50; i++) {
    const p = relayed.find(match)
    if (p) return p
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.fail('no push reached the relay')
}

before(async () => {
  await new Promise<void>((r) => relay.listen(0, r))
  server = spawn(process.execPath, ['server/index.ts'], {
    // relative on purpose: production configs may pass one
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: path.relative(process.cwd(), dataDir), SETUP_CODE: 'setup-test',
      PUSH_RELAY_URL: `http://localhost:${(relay.address() as { port: number }).port}`,
    },
    stdio: 'inherit',
  })
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${BASE}/healthz`).then((r) => r.ok, () => false)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not start')
})

after(() => {
  for (const s of sockets) s.close()
  server.kill()
  relay.close()
  rmSync(dataDir, { recursive: true, force: true })
})

interface Client {
  id: string
  name: string
  ident: c.Identity
  cookie: string
  token?: string // helpers: a bearer token, never a cookie
}

const authHeader = (cl: Client): Record<string, string> => (cl.token ? { authorization: `Bearer ${cl.token}` } : { cookie: cl.cookie })

const api = async (cl: Client | null, method: string, url: string, body?: unknown, raw?: Uint8Array) => {
  const r = await fetch(BASE + url, {
    method,
    headers: {
      ...(cl ? authHeader(cl) : {}),
      'content-type': raw ? 'application/octet-stream' : 'application/json',
    },
    body: (raw as BodyInit | undefined) ?? (body ? JSON.stringify(body) : undefined),
  })
  return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0] ?? '', r }
}

async function register(name: string, invite: string): Promise<Client> {
  const ident = await c.deriveIdentity(name, `${name} correct horse battery`, 1000)
  const res = await api(null, 'POST', '/api/register', { invite, name, pubkey: ident.publicKey, auth: ident.auth })
  assert.equal(res.status, 200)
  const { id } = await res.r.json()
  return { id, name, ident, cookie: res.cookie }
}

const me = async (cl: Client) => (await (await api(cl, 'GET', '/api/me')).r.json()) as Me
const invite = async (cl: Client) => (await (await api(cl, 'POST', '/api/invites')).r.json()).code as string
const socket = (cl: Client, v = 1, auth?: Record<string, string>) =>
  new Promise<Socket>((resolve, reject) => {
    const s = connect(BASE, { extraHeaders: authHeader(cl), transports: ['websocket'], query: { v: String(v) }, auth })
    sockets.push(s)
    s.on('connect', () => resolve(s))
    s.on('connect_error', reject)
  })

async function convKey(cl: Client, convId: string) {
  const m = await me(cl)
  const conv = m.conversations.find((x) => x.id === convId)!
  const wrapper = m.users.find((u) => u.id === conv.wrappedBy)!
  return (await c.unwrapConvKey(conv.wrappedKey, cl.ident.privateKey, wrapper.pubkey, convId, cl.id)).key
}

async function createConv(owner: Client, kind: 'dm' | 'group', members: Client[], title?: string) {
  const id = crypto.randomUUID()
  const raw = c.newConvKeyBytes()
  const wrapped = await Promise.all(
    members.map(async (m) => ({ userId: m.id, wrappedKey: await c.wrapConvKey(raw, owner.ident.privateKey, m.ident.publicKey, id, m.id) })),
  )
  return { id, res: await api(owner, 'POST', '/api/conversations', { id, kind, title, members: wrapped }) }
}

test('three people: accounts, DM, group, realtime, attachments, access', async () => {
  assert.equal((await api(null, 'POST', '/api/register', { invite: 'nope', name: 'x', pubkey: 'a'.repeat(43), auth: 'a'.repeat(64) })).status, 403)

  const alice = await register('Alice', 'setup-test')
  assert.equal((await api(null, 'POST', '/api/register', { invite: 'setup-test', name: 'Eve', pubkey: alice.ident.publicKey, auth: alice.ident.auth })).status, 403, 'setup code is single use')
  const bob = await register('Bob', await invite(alice))
  const carol = await register('Carol', await invite(bob))

  // login: wrong passphrase rejected, right one accepted, case-insensitive name
  const wrong = await c.deriveIdentity('Bob', 'not it', 1000)
  assert.equal((await api(null, 'POST', '/api/login', { name: 'Bob', auth: wrong.auth })).status, 401)
  const again = await c.deriveIdentity('bob', 'Bob correct horse battery', 1000)
  assert.equal(again.publicKey, bob.ident.publicKey, 'same key on a new device')
  assert.equal((await api(null, 'POST', '/api/login', { name: 'bob', auth: again.auth })).status, 200)

  // DM, and no duplicate DM for the same pair
  const dm = await createConv(alice, 'dm', [alice, bob])
  assert.equal(dm.res.status, 200)
  const dup = await createConv(bob, 'dm', [bob, alice])
  assert.equal(dup.res.status, 409)
  assert.equal((await dup.res.r.json()).id, dm.id)

  const aKey = await convKey(alice, dm.id)
  const bKey = await convKey(bob, dm.id)

  // realtime: Alice sends, Bob receives and decrypts
  const [sa, sb] = await Promise.all([socket(alice), socket(bob)])
  const got = new Promise<Message>((r) => sb.once('message', r))
  const body = await c.sealMessage(aKey, dm.id, { from: alice.id, text: 'hi bob' } satisfies MessageBody)
  const ack = await sa.emitWithAck('send', { convId: dm.id, body })
  assert.ok(ack.message)
  const msg = await got
  assert.equal(msg.senderId, alice.id)
  assert.deepEqual(await c.openMessage(bKey, dm.id, msg.body), { from: alice.id, text: 'hi bob' })

  // ciphertext bound to its conversation
  await assert.rejects(c.openMessage(bKey, 'other-conv', msg.body))

  // unread count, then read receipt clears it
  assert.equal((await me(bob)).conversations.find((x) => x.id === dm.id)!.unread, 1)
  await api(bob, 'POST', `/api/conversations/${dm.id}/read`, { upTo: msg.id })
  assert.equal((await me(bob)).conversations.find((x) => x.id === dm.id)!.unread, 0)

  // attachments: encrypted upload, member download, outsider blocked
  const file = new TextEncoder().encode('photo bytes')
  const up = await api(alice, 'POST', `/api/conversations/${dm.id}/attachments`, undefined, await c.sealFile(aKey, dm.id, file))
  const { id: fileId } = await up.r.json()
  const down = await api(bob, 'GET', `/api/attachments/${fileId}`)
  assert.match(down.r.headers.get('cache-control')!, /immutable/)
  assert.deepEqual(await c.openFile(bKey, dm.id, new Uint8Array(await down.r.arrayBuffer())), file)
  assert.equal((await api(carol, 'GET', `/api/attachments/${fileId}`)).status, 404)
  assert.equal((await api(carol, 'GET', `/api/conversations/${dm.id}/messages`)).status, 404)
  const sc = await socket(carol)
  assert.equal((await sc.emitWithAck('send', { convId: dm.id, body })).error, 'bad request')

  // history
  const hist = (await (await api(bob, 'GET', `/api/conversations/${dm.id}/messages`)).r.json()) as Message[]
  assert.equal(hist.length, 1)

  // call logs: an answered call isn't unread (both were there), a missed one is
  const log = (ms: number) => c.sealMessage(aKey, dm.id, { from: alice.id, call: { kind: 'audio', ms } } satisfies MessageBody)
  await sa.emitWithAck('send', { convId: dm.id, body: await log(61_000), quiet: true, seen: true })
  assert.equal((await me(bob)).conversations.find((x) => x.id === dm.id)!.unread, 0, 'answered call')
  await sa.emitWithAck('send', { convId: dm.id, body: await log(0), quiet: true })
  assert.equal((await me(bob)).conversations.find((x) => x.id === dm.id)!.unread, 1, 'missed call')

  // outbox: a resend with the same client id stores one message, acks it twice, reaches Bob once
  const count = async () => ((await (await api(bob, 'GET', `/api/conversations/${dm.id}/messages`)).r.json()) as Message[]).length
  const before = await count()
  const echoes: Message[] = []
  const onEcho = (m: Message) => echoes.push(m)
  sb.on('message', onEcho)
  const cid = crypto.randomUUID()
  const first = await sa.emitWithAck('send', { convId: dm.id, body, cid })
  const resent = await sa.emitWithAck('send', { convId: dm.id, body, cid })
  assert.equal(resent.message.id, first.message.id)
  assert.equal(await count(), before + 1)
  sb.off('message', onEcho)
  assert.deepEqual(echoes.map((m) => m.id), [first.message.id])
  assert.equal((await sa.emitWithAck('send', { convId: dm.id, body, cid: 'not-a-uuid' })).error, 'bad request')

  // group of two, then Carol is added by Bob re-wrapping the key
  const group = await createConv(alice, 'group', [alice, bob], 'Crew')
  assert.equal(group.res.status, 200)
  const m = await me(bob)
  const conv = m.conversations.find((x) => x.id === group.id)!
  const { raw } = await c.unwrapConvKey(conv.wrappedKey, bob.ident.privateKey, alice.ident.publicKey, group.id, bob.id)
  const wrappedForCarol = await c.wrapConvKey(raw, bob.ident.privateKey, carol.ident.publicKey, group.id, carol.id)
  assert.equal((await api(bob, 'POST', `/api/conversations/${group.id}/members`, { userId: carol.id, wrappedKey: wrappedForCarol })).status, 200)
  const carolKey = await convKey(carol, group.id)
  const gBody = await c.sealMessage(await convKey(alice, group.id), group.id, { from: alice.id, text: 'hey all' })
  await sa.emitWithAck('send', { convId: group.id, body: gBody })
  const gHist = (await (await api(carol, 'GET', `/api/conversations/${group.id}/messages`)).r.json()) as Message[]
  assert.equal((await c.openMessage<MessageBody>(carolKey, group.id, gHist[0].body)).text, 'hey all')

  // calls: ring every device, the answering one wins, signals reach only it
  const ice = await (await api(alice, 'GET', '/api/ice')).r.json()
  assert.ok(Array.isArray(ice) && ice.length)
  assert.equal((await sc.emitWithAck('call:start', { convId: dm.id, kind: 'audio' })).error, 'bad request', 'outsider')
  const sb2 = await socket(bob)
  const VOIP = 'ab'.repeat(32)
  const ALERT = 'cd'.repeat(32)
  assert.equal((await api(bob, 'POST', '/api/devices', { token: 'nope', kind: 'voip', env: 'sandbox' })).status, 400)
  assert.equal((await api(bob, 'POST', '/api/devices', { token: VOIP, kind: 'voip', env: 'sandbox' })).status, 200)
  assert.equal((await api(bob, 'POST', '/api/devices', { token: ALERT, kind: 'alert', env: 'production' })).status, 200)
  const rings = [sb, sb2].map((s) => new Promise<{ id: string; from: string }>((r) => s.once('call:ring', r)))
  const { id: callId } = await sa.emitWithAck('call:start', { convId: dm.id, kind: 'video' })
  for (const r of await Promise.all(rings)) assert.deepEqual([r.id, r.from], [callId, alice.id])
  // the phone rings through a VoIP push even with the app open
  assert.deepEqual(await pushed((p) => p.callId === callId), { token: VOIP, env: 'sandbox', type: 'call', convId: dm.id, callId, kind: 'video', from: alice.id })
  assert.equal((await (await api(bob, 'GET', `/api/calls/${callId}`)).r.json()).state, 'ringing')
  assert.equal((await api(carol, 'GET', `/api/calls/${callId}`)).status, 404)
  const elsewhere = new Promise<{ reason: string }>((r) => sb2.once('call:end', r))
  const accepted = new Promise((r) => sa.once('call:accepted', r))
  assert.equal((await sb.emitWithAck('call:accept', { id: callId })).id, callId)
  await accepted
  assert.equal((await elsewhere).reason, 'elsewhere')
  assert.ok((await sb2.emitWithAck('call:accept', { id: callId })).error, 'answered once')
  const relayed = new Promise<{ data: unknown }>((r) => sb.once('call:signal', r))
  sa.emit('call:signal', { id: callId, data: { candidate: 'x' } })
  assert.deepEqual((await relayed).data, { candidate: 'x' })
  const ca = await createConv(carol, 'dm', [carol, alice])
  assert.match((await sc.emitWithAck('call:start', { convId: ca.id, kind: 'audio' })).error, /Alice is on another call/)
  const ended = new Promise<{ reason: string }>((r) => sa.once('call:end', r))
  sb.emit('call:hangup', { id: callId })
  assert.equal((await ended).reason, 'hangup')
  const { id: carolCall } = await sc.emitWithAck('call:start', { convId: ca.id, kind: 'audio' })
  assert.ok(carolCall, 'free again after hangup')
  const carolGone = new Promise((r) => sa.once('call:end', r))
  sc.emit('call:hangup', { id: carolCall })
  await carolGone

  // A phone woken by the call push connects while it still rings: that socket is rung again, and its hangup
  // declines. The iPhone app declines that way when the decline came before its socket was up.
  const late = connect(BASE, { extraHeaders: { cookie: bob.cookie }, transports: ['websocket'], query: { v: '2' }, autoConnect: false })
  sockets.push(late)
  const rungAgain = new Promise<{ id: string }>((r) => late.once('call:ring', r))
  const { id: lateCall } = await sa.emitWithAck('call:start', { convId: dm.id, kind: 'audio' })
  late.connect()
  assert.equal((await rungAgain).id, lateCall)
  const declined = new Promise((r) => sa.once('call:end', r))
  // The app keeps answering rings with its hangup till its own call:end shows the server has it.
  const confirmed = new Promise((r) => late.once('call:end', r))
  late.emit('call:hangup', { id: lateCall })
  assert.deepEqual(await declined, { id: lateCall, reason: 'declined' })
  assert.deepEqual(await confirmed, { id: lateCall, reason: 'declined' })
  late.disconnect()

  // an away phone gets an ids-only alert push for a new message
  sb.emit('active', false)
  sb2.emit('active', false)
  const { message: away } = await sa.emitWithAck('send', { convId: dm.id, body })
  assert.deepEqual(await pushed((p) => p.messageId === away.id), { token: ALERT, env: 'production', type: 'message', convId: dm.id, messageId: away.id })

  // block: the DM refuses both ways, their group messages disappear for me
  assert.equal((await api(bob, 'PUT', `/api/blocks/${alice.id}`)).status, 200)
  assert.deepEqual((await me(bob)).blocked, [alice.id])
  assert.match((await sa.emitWithAck('send', { convId: dm.id, body })).error, /isn’t taking messages/)
  assert.match((await sb.emitWithAck('send', { convId: dm.id, body })).error, /Unblock/)
  assert.match((await sa.emitWithAck('call:start', { convId: dm.id, kind: 'audio' })).error, /isn't taking calls/)
  const groupFor = async (cl: Client) => ((await (await api(cl, 'GET', `/api/conversations/${group.id}/messages`)).r.json()) as Message[]).length
  assert.equal(await groupFor(bob), 0)
  assert.equal(await groupFor(carol), 1)
  assert.equal((await api(bob, 'DELETE', `/api/blocks/${alice.id}`)).status, 200)
  assert.equal(await groupFor(bob), 1)

  // call stats: one object per call, logged
  assert.equal((await api(carol, 'POST', '/api/call-stats', { id: 'x', platform: 'web', peers: [] })).status, 200)
  assert.equal((await api(carol, 'POST', '/api/call-stats', [1])).status, 400)
  assert.equal((await api(carol, 'POST', '/api/call-stats', { big: 'x'.repeat(20_000) })).status, 400)
  assert.equal((await api(null, 'POST', '/api/call-stats', { id: 'x' })).status, 401)

  // report: stored, and blocks
  assert.equal((await api(carol, 'POST', '/api/reports', { userId: alice.id, convId: dm.id })).status, 400, 'not my chat')
  assert.equal((await api(carol, 'POST', '/api/reports', { userId: alice.id, convId: ca.id, note: 'spam' })).status, 200)
  assert.deepEqual((await me(carol)).blocked, [alice.id])

  // delete account: passphrase again, then gone; the public key stays for old keys
  assert.equal((await api(carol, 'DELETE', '/api/me', { auth: alice.ident.auth })).status, 403)
  const gone = new Promise((r) => sc.once('disconnect', r))
  assert.equal((await api(carol, 'DELETE', '/api/me', { auth: carol.ident.auth })).status, 200)
  await gone
  assert.equal((await api(carol, 'GET', '/api/me')).status, 401)
  assert.equal((await api(null, 'POST', '/api/login', { name: 'Carol', auth: carol.ident.auth })).status, 401)
  const after = await me(alice)
  assert.deepEqual(after.users.find((u) => u.id === carol.id), { id: carol.id, name: 'Deleted account', pubkey: carol.ident.publicKey, deleted: true })
  assert.deepEqual(after.conversations.find((x) => x.id === ca.id)!.members, [alice.id])
  assert.match((await sa.emitWithAck('call:start', { convId: ca.id, kind: 'audio' })).error, /deleted/)
  assert.equal((await register('Carol', await invite(alice))).name, 'Carol', 'name is free again')
})

const next = <T>(s: Socket, event: string, match: (x: T) => boolean = () => true) =>
  new Promise<T>((resolve) => {
    const on = (x: T) => match(x) && (s.off(event, on), resolve(x))
    s.on(event, on)
  })
const none = async (s: Socket, event: string, ms = 300) => {
  let heard = false
  const on = () => (heard = true)
  s.on(event, on)
  await new Promise((r) => setTimeout(r, ms))
  s.off(event, on)
  assert.equal(heard, false, `unexpected ${event}`)
}

async function login(name: string): Promise<Client> {
  const ident = await c.deriveIdentity(name, `${name} correct horse battery`, 1000)
  const res = await api(null, 'POST', '/api/login', { name, auth: ident.auth })
  assert.equal(res.status, 200)
  return { id: (await res.r.json()).id, name, ident, cookie: res.cookie }
}

const seal = async (cl: Client, convId: string, body: unknown) => c.sealMessage(await convKey(cl, convId), convId, body)
const history = async (cl: Client, convId: string) => (await (await api(cl, 'GET', `/api/conversations/${convId}/messages`)).r.json()) as Message[]
const convOf = async (cl: Client, convId: string) => (await me(cl)).conversations.find((x) => x.id === convId)

test('chat actions: reactions, edits, unsend, receipts, typing, mute, pin, group admin', async () => {
  const alice = await login('Alice')
  const dan = await register('Dan', await invite(alice))
  const erin = await register('Erin', await invite(alice))
  const frank = await register('Frank', await invite(alice))
  const dm = await createConv(dan, 'dm', [dan, erin])
  const [sd, se] = await Promise.all([socket(dan, 2), socket(erin, 2)])
  const { message: hi } = await sd.emitWithAck('send', { convId: dm.id, body: await seal(dan, dm.id, { from: dan.id, text: 'hi' }) })

  // reactions: one per person, sealed, replaced, removed, live to the chat
  const react = (emoji: string) => seal(erin, dm.id, { from: erin.id, to: hi.id, emoji } satisfies ReactionBody)
  const live = next<{ messageId: number; userId: string; body: string | null }>(sd, 'reaction')
  assert.equal((await api(erin, 'PUT', `/api/messages/${hi.id}/reaction`, { body: await react('👍') })).status, 200)
  assert.deepEqual([(await live).messageId, (await live).userId], [hi.id, erin.id])
  assert.equal((await api(erin, 'PUT', `/api/messages/${hi.id}/reaction`, { body: await react('❤️') })).status, 200)
  const [withReaction] = await history(dan, dm.id)
  assert.equal(withReaction.reactions!.length, 1)
  assert.equal((await c.openMessage<ReactionBody>(await convKey(dan, dm.id), dm.id, withReaction.reactions![0].body)).emoji, '❤️')
  assert.equal((await api(frank, 'PUT', `/api/messages/${hi.id}/reaction`, { body: await react('👍') })).status, 404, 'outsider')
  const removed = next<{ body: string | null }>(sd, 'reaction')
  assert.equal((await api(erin, 'DELETE', `/api/messages/${hi.id}/reaction`)).status, 200)
  assert.equal((await removed).body, null)
  assert.equal((await history(dan, dm.id))[0].reactions, undefined)

  // edit: sender only, live, marked; the broadcast leaves reactions to each viewer
  await api(erin, 'PUT', `/api/messages/${hi.id}/reaction`, { body: await react('👍') })
  const edited = next<Message>(se, 'edit')
  const newBody = await seal(dan, dm.id, { from: dan.id, text: 'hi there' })
  assert.equal((await api(erin, 'PATCH', `/api/messages/${hi.id}`, { body: newBody })).status, 404, 'not mine')
  assert.equal((await api(dan, 'PATCH', `/api/messages/${hi.id}`, { body: newBody })).status, 200)
  assert.equal((await edited).body, newBody)
  assert.equal((await edited).reactions, undefined)
  const [afterEdit] = await history(erin, dm.id)
  assert.ok(afterEdit.editedAt)
  assert.equal(afterEdit.reactions!.length, 1)
  assert.equal((await c.openMessage<MessageBody>(await convKey(erin, dm.id), dm.id, afterEdit.body)).text, 'hi there')

  // read receipt: Erin reads, Dan hears it and sees it in /api/me
  const read = next<{ userId: string; upTo: number }>(sd, 'read')
  await api(erin, 'POST', `/api/conversations/${dm.id}/read`, { upTo: hi.id })
  assert.deepEqual(await read, { convId: dm.id, userId: erin.id, upTo: hi.id })
  const again = none(sd, 'read')
  await api(erin, 'POST', `/api/conversations/${dm.id}/read`, { upTo: hi.id })
  await again // nothing moved, nothing sent
  assert.equal((await convOf(dan, dm.id))!.reads![erin.id], hi.id)
  assert.equal((await api(frank, 'POST', `/api/conversations/${dm.id}/read`, { upTo: 1 })).status, 404)

  // typing: relayed to the others, never back to me, not from outsiders
  const typing = next<{ convId: string; userId: string }>(se, 'typing')
  sd.emit('typing', { convId: dm.id })
  assert.deepEqual(await typing, { convId: dm.id, userId: dan.id })
  const sf = await socket(frank, 2)
  sf.emit('typing', { convId: dm.id })
  await none(se, 'typing')

  // once Dan blocks Erin, his edits stop reaching her too, not just new messages
  await api(dan, 'PUT', `/api/blocks/${erin.id}`)
  const hidden = none(se, 'edit')
  assert.equal((await api(dan, 'PATCH', `/api/messages/${hi.id}`, { body: newBody })).status, 200)
  await hidden
  assert.equal((await convOf(erin, dm.id))!.reads![dan.id], undefined, 'no receipts across a block')
  await api(dan, 'DELETE', `/api/blocks/${erin.id}`)
  assert.equal(typeof (await convOf(erin, dm.id))!.reads![dan.id], 'number')

  // unsend: gone for everyone, reactions with it
  await api(erin, 'PUT', `/api/messages/${hi.id}/reaction`, { body: await react('😂') })
  const gone = next<{ id: number }>(se, 'unsend')
  assert.equal((await api(erin, 'DELETE', `/api/messages/${hi.id}`)).status, 404, 'not mine')
  assert.equal((await api(dan, 'DELETE', `/api/messages/${hi.id}`)).status, 200)
  assert.equal((await gone).id, hi.id)
  assert.equal((await history(erin, dm.id)).length, 0)

  // mute and pin are mine alone; a muted chat sends no push
  assert.equal((await api(erin, 'PATCH', `/api/conversations/${dm.id}/me`, { muted: 'yes' })).status, 400)
  assert.equal((await api(erin, 'PATCH', `/api/conversations/${dm.id}/me`, { muted: true, pinned: true })).status, 200)
  assert.deepEqual([(await convOf(erin, dm.id))!.muted, (await convOf(erin, dm.id))!.pinned], [true, true])
  assert.equal((await convOf(dan, dm.id))!.muted, undefined)
  const TOKEN = 'ef'.repeat(32)
  await api(erin, 'POST', '/api/devices', { token: TOKEN, kind: 'alert', env: 'sandbox', v: 2 })
  se.emit('active', false)
  await new Promise((r) => setTimeout(r, 50))
  const { message: quiet } = await sd.emitWithAck('send', { convId: dm.id, body: await seal(dan, dm.id, { from: dan.id, text: 'shh' }) })
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(!relayed.some((p) => p.messageId === quiet.id), 'muted: no push')
  await api(erin, 'PATCH', `/api/conversations/${dm.id}/me`, { muted: false })
  const { message: loud } = await sd.emitWithAck('send', { convId: dm.id, body: await seal(dan, dm.id, { from: dan.id, text: 'hey' }) })
  await pushed((p) => p.messageId === loud.id)
  assert.equal((await convOf(erin, dm.id))!.pinned, true, 'pin kept')

  // group admin: rename, remove, leave; DMs refuse all three
  const group = await createConv(dan, 'group', [dan, erin, frank], 'Hikers')
  assert.equal((await api(dan, 'PATCH', `/api/conversations/${group.id}`, { title: 'Hike club' })).status, 200)
  assert.equal((await convOf(frank, group.id))!.title, 'Hike club')
  assert.equal((await api(dan, 'PATCH', `/api/conversations/${dm.id}`, { title: 'x' })).status, 400)
  assert.equal((await api(dan, 'DELETE', `/api/conversations/${dm.id}/members/${erin.id}`)).status, 400)
  assert.equal((await api(alice, 'DELETE', `/api/conversations/${group.id}/members/${erin.id}`)).status, 404, 'outsider')
  assert.equal((await api(dan, 'DELETE', `/api/conversations/${group.id}/members/${erin.id}`)).status, 200)
  assert.equal(await convOf(erin, group.id), undefined)
  assert.equal((await api(erin, 'GET', `/api/conversations/${group.id}/messages`)).status, 404)
  assert.equal((await api(frank, 'DELETE', `/api/conversations/${group.id}/members/${frank.id}`)).status, 200, 'leave')
  assert.deepEqual((await convOf(dan, group.id))!.members, [dan.id])
})

test('group calls: ring, join, mesh signaling, leave, rejoin', async () => {
  const alice = await login('Alice')
  const [gina, hal, ivy, old] = await Promise.all(['Gina', 'Hal', 'Ivy', 'Olaf'].map(async (n) => register(n, await invite(alice))))
  const group = await createConv(gina, 'group', [gina, hal, ivy, old], 'Call crew')
  const [sg, sh, si] = await Promise.all([socket(gina, 2), socket(hal, 2), socket(ivy, 2)])
  const so = await socket(old) // an older app: no group rings
  const VOIP2 = '12'.repeat(32)
  const VOIP1 = '34'.repeat(32)
  await api(hal, 'POST', '/api/devices', { token: VOIP2, kind: 'voip', env: 'sandbox', v: 2 })
  await api(old, 'POST', '/api/devices', { token: VOIP1, kind: 'voip', env: 'sandbox' })

  const rings = [sh, si].map((s) => next<{ id: string; from: string; group?: true }>(s, 'call:ring'))
  const live = next<{ convId: string; call: GroupCall | null }>(so, 'call:update')
  const { id } = await sg.emitWithAck('call:start', { convId: group.id, kind: 'video' })
  for (const r of await Promise.all(rings)) assert.deepEqual([r.id, r.from, r.group], [id, gina.id, true])
  const { ringing, ...call } = (await live).call!
  assert.deepEqual(call, { id, kind: 'video', from: gina.id, peers: [gina.id] })
  assert.deepEqual(ringing!.sort(), [hal.id, ivy.id, old.id].sort())
  await pushed((p) => p.callId === id && p.token === VOIP2)
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(!relayed.some((p) => p.callId === id && p.token === VOIP1), 'old phones aren’t rung')
  assert.equal((await convOf(old, group.id))!.call!.id, id, 'old app still sees the call in /api/me')
  assert.equal((await (await api(hal, 'GET', `/api/calls/${id}`)).r.json()).state, 'ringing')
  assert.match((await sh.emitWithAck('call:start', { convId: group.id, kind: 'audio' })).error, /Join it/)

  // Hal joins: Gina hears call:joined, Hal gets the peer list; signals route by user
  const joined = next<{ user: string }>(sg, 'call:joined')
  assert.deepEqual(await sh.emitWithAck('call:join', { id }), { id, peers: [gina.id] })
  assert.equal((await joined).user, hal.id)
  const sig = next<{ from: string; data: unknown }>(sh, 'call:signal')
  sg.emit('call:signal', { id, to: hal.id, data: { candidate: 'g' } })
  assert.deepEqual(await sig, { id, from: gina.id, data: { candidate: 'g' } })
  si.emit('call:signal', { id, to: hal.id, data: { candidate: 'not in it' } })
  await none(sh, 'call:signal')

  // Ivy declines: only her ring stops; then she joins anyway from the banner
  const declined = next<{ reason: string }>(si, 'call:end')
  si.emit('call:hangup', { id })
  assert.equal((await declined).reason, 'declined')
  assert.equal((await convOf(ivy, group.id))!.call!.peers.length, 2)
  assert.deepEqual((await si.emitWithAck('call:join', { id })).peers!.sort(), [gina.id, hal.id].sort())

  // Hal's socket drops and comes back: rejoin keeps him in
  sh.disconnect()
  const sh2 = await socket(hal, 2)
  assert.deepEqual((await sh2.emitWithAck('call:rejoin', { id })).peers!.sort(), [gina.id, ivy.id].sort())

  // Gina (the starter) leaves: the call goes on for two
  const left = next<{ user: string }>(sh2, 'call:left')
  sg.emit('call:hangup', { id })
  assert.equal((await left).user, gina.id)
  assert.deepEqual((await convOf(gina, group.id))!.call!.peers.sort(), [hal.id, ivy.id].sort())

  // Ivy leaves: one left, so it ends for everyone and the chat hears it's over
  const ended = next<{ id: string; reason: string }>(sh2, 'call:end', (e) => e.id === id)
  const over = next<{ call: GroupCall | null }>(so, 'call:update', (u) => u.call === null)
  si.emit('call:hangup', { id })
  assert.equal((await ended).reason, 'hangup')
  await over
  assert.equal((await convOf(gina, group.id))!.call, undefined)
  assert.equal((await sh2.emitWithAck('call:join', { id })).error, 'This call has ended.')

  // a starter who gives up before anyone joins cancels it
  const ring2 = next<{ id: string }>(si, 'call:ring')
  const { id: id2 } = await sg.emitWithAck('call:start', { convId: group.id, kind: 'audio' })
  await ring2
  const cancelled = next<{ id: string; reason: string }>(si, 'call:end', (e) => e.id === id2)
  sg.emit('call:hangup', { id: id2 })
  assert.equal((await cancelled).reason, 'cancelled')

  // removed from the group mid-call: out of the call too
  const { id: id3 } = await sg.emitWithAck('call:start', { convId: group.id, kind: 'audio' })
  await sh2.emitWithAck('call:join', { id: id3 })
  await si.emitWithAck('call:join', { id: id3 })
  const dropped = next<{ user: string }>(sh2, 'call:left', (e) => e.user === ivy.id)
  const kicked = next<{ id: string }>(si, 'call:end', (e) => e.id === id3)
  assert.equal((await api(gina, 'DELETE', `/api/conversations/${group.id}/members/${ivy.id}`)).status, 200)
  await Promise.all([dropped, kicked])
  assert.deepEqual((await convOf(gina, group.id))!.call!.peers.sort(), [gina.id, hal.id].sort())
})

test('group calls: add people mid-call, blocks keep people apart', async () => {
  const alice = await login('Alice')
  const [jo, kai, lee, max, ned] = await Promise.all(['Jo', 'Kai', 'Lee', 'Max', 'Ned'].map(async (n) => register(n, await invite(alice))))
  const group = await createConv(jo, 'group', [jo, kai, lee, max, ned], 'Add crew')
  const [sj, sk, sl, sm, sn] = await Promise.all([jo, kai, lee, max, ned].map((u) => socket(u, 2)))
  await api(max, 'PUT', `/api/blocks/${jo.id}`) // Max blocked Jo
  await api(jo, 'PUT', `/api/blocks/${ned.id}`) // Jo blocked Ned

  // Jo starts: neither Max nor Ned is rung
  const first = next<{ call: GroupCall | null }>(sk, 'call:update')
  const { id } = await sj.emitWithAck('call:start', { convId: group.id, kind: 'audio' })
  assert.deepEqual((await first).call!.ringing!.sort(), [kai.id, lee.id].sort())
  await sk.emitWithAck('call:join', { id })

  // Lee declines, then Kai rings her again from the call; she joins
  const cleared = next<{ call: GroupCall | null }>(sk, 'call:update', (u) => !u.call?.ringing?.length)
  sl.emit('call:hangup', { id })
  await cleared
  const again = next<{ id: string; group?: true }>(sl, 'call:ring')
  const ringingLee = next<{ call: GroupCall | null }>(sj, 'call:update', (u) => !!u.call?.ringing?.includes(lee.id))
  assert.deepEqual(await sk.emitWithAck('call:add', { id, users: [lee.id] }), {})
  assert.deepEqual(await again, { id, convId: group.id, from: jo.id, kind: 'audio', group: true })
  await ringingLee
  assert.equal((await sl.emitWithAck('call:join', { id })).peers!.length, 2)
  assert.deepEqual((await convOf(jo, group.id))!.call!.ringing, [])

  // blocks: neither can join, and nobody can ring them in
  assert.equal((await sm.emitWithAck('call:join', { id })).error, 'Unblock Jo to join this call.')
  assert.equal((await sn.emitWithAck('call:join', { id })).error, "You can't join this call.")
  assert.equal((await sk.emitWithAck('call:add', { id, users: [max.id, ned.id] })).error, "They can't be rung right now.")
  await none(sm, 'call:ring')
  // only people in the call can ring others
  assert.equal((await sm.emitWithAck('call:add', { id, users: [ned.id] })).error, 'This call has ended.')
})

test('history pages and link preview guards', async () => {
  const alice = await login('Alice')
  const [pat] = await Promise.all(['Pat'].map(async (n) => register(n, await invite(alice))))
  const dm = await createConv(alice, 'dm', [alice, pat])
  const sa = await socket(alice)
  for (const text of ['one', 'two', 'three']) await sa.emitWithAck('send', { convId: dm.id, body: await seal(alice, dm.id, { from: alice.id, text }) })
  assert.equal((await (await api(pat, 'GET', `/api/conversations/${dm.id}/messages?limit=2`)).r.json()).length, 2)
  assert.equal((await (await api(pat, 'GET', `/api/conversations/${dm.id}/messages?limit=junk`)).r.json()).length, 3)

  // the server won't fetch its own network for a preview, and stops at 20 a minute
  for (const url of ['http://127.0.0.1/', `http://localhost:${PORT}/api/me`, 'http://[::1]/', 'http://169.254.169.254/', 'file:///etc/passwd', 'not a url'])
    assert.equal((await api(pat, 'POST', '/api/unfurl', { url })).status, 400, url)
  let last = 0
  for (let i = 0; i < 15; i++) last = (await api(pat, 'POST', '/api/unfurl', { url: 'http://10.0.0.1/' })).status
  assert.equal(last, 429)

  assert.ok(['127.0.0.1', '10.2.3.4', '100.64.0.1', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', '::', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', 'nonsense'].every(blocked))
  assert.ok(!['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'].some(blocked))
  const head = parseHead(
    `<title>Fallback</title><meta content='A &amp; B' property="og:title"><meta name=description content="Desc &#x2014; here"><meta property="og:image" content="/img/a.png"><meta property="og:site_name" content="Site">`,
    new URL('https://example.com/post/1'),
  )
  assert.deepEqual(head, { url: 'https://example.com/post/1', title: 'A & B', description: 'Desc — here', site: 'Site', image: 'https://example.com/img/a.png' })
})

test('safety code is stable and short', async () => {
  const id = await c.deriveIdentity('x', 'y', 1000)
  const code = await c.safetyCode(id.publicKey)
  assert.match(code, /^\d\d( \d\d){5}$/)
  assert.equal(code, await c.safetyCode(id.publicKey))
})

// --- helpers (talkline): owner-only accounts with a bearer token ---

// Ring hours are 08:00–22:00 where the owner is. A day zone's hour is in [9, 21) and a night zone's in [23, 7);
// these zones sit at most 6 h apart (5.5 in northern winter), so both exist at any time, an hour or more from either edge.
const hourIn = (tz: string) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(Date.now()))
const ZONES = ['Pacific/Kiritimati', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/London', 'America/New_York']
const DAY = ZONES.find((z) => hourIn(z) >= 9 && hourIn(z) < 21)!
const NIGHT = ZONES.find((z) => hourIn(z) >= 23 || hourIn(z) < 7)!

const proofFor = (secret: Uint8Array, pubkey: string) => createHmac('sha256', secret).update(`talk-pair-v1:${pubkey}`).digest('base64url')

// Pairs a helper as talkline does: its owner's link, a key of its own, a proof that it holds the link's secret.
async function helper(owner: Client, name: string, tz = DAY): Promise<Client> {
  const link = await api(owner, 'POST', '/api/invites', { agent: true, tz })
  assert.equal(link.status, 200)
  const { code } = await link.r.json()
  const ident = await c.deriveIdentity(name, `${name} ${crypto.randomUUID()}`, 1000)
  const res = await api(null, 'POST', '/api/agents', { code, name, pubkey: ident.publicKey, proof: proofFor(randomBytes(32), ident.publicKey), where: 'test-mac' })
  assert.equal(res.status, 200)
  const { id, token } = await res.r.json()
  return { id, name, ident, cookie: '', token }
}

// Allow: the owner opens a DM with the helper.
async function allow(owner: Client, h: Client) {
  const dm = await createConv(owner, 'dm', [owner, h])
  assert.equal(dm.res.status, 200)
  return dm.id
}

// A text from the helper, with a cid as talkline sends it. Its id names an ask for a ring.
const ask = async (h: Client, s: Socket, convId: string) =>
  ((await s.emitWithAck('send', { convId, body: await seal(h, convId, { from: h.id, text: 'Deploy?' }), cid: crypto.randomUUID() })).message as Message).id
const ring = (s: Socket, convId: string, ask?: number): Promise<{ id?: string; error?: string }> => s.emitWithAck('call:start', { convId, kind: 'audio', ask })
const refused = async (res: { status: number; r: Response }, error: string, status = 403) =>
  assert.deepEqual([res.status, (await res.r.json()).error], [status, error])

test('helper link: 10 minutes, one use, never a person invite', async () => {
  const alice = await login('Alice')
  const [owen, mallory] = await Promise.all(['Owen', 'Mallory'].map(async (n) => register(n, await invite(alice))))
  await refused(await api(owen, 'POST', '/api/invites', { agent: true, tz: 'Mars/Olympus' }), 'bad request', 400)
  const link = await (await api(owen, 'POST', '/api/invites', { agent: true, tz: DAY })).r.json()
  const left = link.expiresAt - Date.now()
  assert.ok(left > 9 * 60_000 && left <= 10 * 60_000, `${left} ms`)

  const ident = await c.deriveIdentity('Claude AI', 'helper passphrase', 1000)
  assert.equal((await api(null, 'POST', '/api/register', { invite: link.code, name: 'Sneaky', pubkey: ident.publicKey, auth: ident.auth })).status, 403)
  const proof = proofFor(randomBytes(32), ident.publicKey)
  const pair = (name: string) => api(null, 'POST', '/api/agents', { code: link.code, name, pubkey: ident.publicKey, proof, where: 'studio.local' })
  await refused(await api(null, 'POST', '/api/agents', {}), 'bad request', 400)
  await refused(await pair('Claude'), 'Helper names end in “AI”, like “Claude AI”.', 400)
  const paired = await pair('Claude AI')
  assert.equal(paired.status, 200, 'the link still works after a refused name')
  const { id, token } = await paired.r.json()
  assert.match(token, /^[\w-]{43}$/)
  await refused(await pair('Claude AI'), 'This link is not valid or has expired.')

  // pending: its owner sees it under agents, nobody lists it as a user, and it sees only itself
  const owners = await me(owen)
  assert.deepEqual(owners.agents, [{ id, name: 'Claude AI', pubkey: ident.publicKey, where: 'studio.local', proof, invite: link.code, activeAt: null }])
  assert.ok(!owners.users.some((u) => u.id === id))
  const strangers = await me(mallory)
  assert.ok(!strangers.users.some((u) => u.id === id))
  assert.deepEqual(strangers.agents, [])
  const its = await me({ id, name: 'Claude AI', ident, cookie: '', token })
  assert.deepEqual(its.users, [{ id, name: 'Claude AI', pubkey: ident.publicKey, owner: owen.id }])
  assert.equal(its.agents, undefined)
})

test('helper token: HTTP and socket, a bad one is signed out', async () => {
  const paula = await register('Paula', await invite(await login('Alice')))
  const h = await helper(paula, 'Penny AI')
  assert.equal((await api(h, 'GET', '/api/me')).status, 200)
  const bad = { ...h, token: randomBytes(32).toString('base64url') }
  await refused(await api(bad, 'GET', '/api/me'), 'signed out', 401)
  await assert.rejects(socket(bad), /signed out/)
  assert.ok((await socket(h)).connected)
})

test('reach: only the owner, one to one', async () => {
  const alice = await login('Alice')
  const mallory = await login('Mallory')
  const rita = await register('Rita', await invite(alice))
  const h = await helper(rita, 'Robin AI')
  const ONLY = 'Helpers chat only with their owner.'
  const ONE_TO_ONE = 'A helper chats only with its owner, one to one.'

  // the helper starts nothing: no chats, invites, pushes, TURN or link previews
  await refused((await createConv(h, 'dm', [h, rita])).res, ONLY)
  for (const [method, url] of [['POST', '/api/invites'], ['POST', '/api/push'], ['POST', '/api/devices'], ['GET', '/api/ice'], ['POST', '/api/unfurl']])
    await refused(await api(h, method, url), ONLY)
  // nobody else chats with it, and its owner only one to one
  await refused((await createConv(mallory, 'dm', [mallory, h])).res, ONE_TO_ONE)
  await refused((await createConv(rita, 'group', [rita, mallory, h], 'Crew')).res, ONE_TO_ONE)
  const group = await createConv(rita, 'group', [rita, mallory], 'Crew')
  assert.equal(group.res.status, 200)
  await refused(await api(rita, 'POST', `/api/conversations/${group.id}/members`, { userId: h.id, wrappedKey: 'A'.repeat(80) }), 'Helpers can’t join group chats.')

  // the owner's DM is the approval, and still nobody else lists the helper
  const dm = await allow(rita, h)
  assert.equal((await api(h, 'GET', `/api/conversations/${dm}/messages`)).status, 200, 'the gate takes exact paths')
  assert.equal((await api(h, 'POST', `/api/conversations/${dm}/read`, { upTo: 0 })).status, 200)
  assert.ok(!(await me(mallory)).users.some((u) => u.id === h.id))
  assert.equal((await me(rita)).users.find((u) => u.id === h.id)?.owner, rita.id)
  assert.deepEqual((await me(h)).users.map((u) => u.id).sort(), [h.id, rita.id].sort())
})

test('remove: locks out in under a second, keeps the chat', async () => {
  const alice = await login('Alice')
  const mallory = await login('Mallory')
  const nora = await register('Nora', await invite(alice))
  const h = await helper(nora, 'Nimbus AI')
  const dm = await allow(nora, h)
  await refused(await api(mallory, 'DELETE', `/api/agents/${h.id}`), 'not found', 404)

  // a live ring ends and the helper's socket drops, both within a second of Remove
  const [so, sh] = await Promise.all([socket(nora), socket(h)])
  const said = await ask(h, sh, dm)
  const rung = next(so, 'call:ring')
  const { id: callId } = await ring(sh, dm, said)
  assert.ok(callId)
  await rung
  const sent = Date.now()
  const dropped = next(sh, 'disconnect').then(() => Date.now() - sent)
  const ended = next<{ id: string; reason: string }>(so, 'call:end').then((e) => (assert.deepEqual(e, { id: callId, reason: 'cancelled' }), Date.now() - sent))
  assert.equal((await api(nora, 'DELETE', `/api/agents/${h.id}`)).status, 200)
  for (const ms of await Promise.all([dropped, ended])) assert.ok(ms < 1000, `${ms} ms`)
  await refused(await api(h, 'GET', '/api/me'), 'signed out', 401)

  // the chat stays: its messages, and the helper as a deleted account that still carries its owner
  assert.ok((await history(nora, dm)).some((m) => m.id === said))
  const after = await me(nora)
  assert.deepEqual(after.users.find((u) => u.id === h.id), { id: h.id, name: 'Deleted account', pubkey: h.ident.publicKey, deleted: true, owner: nora.id })
  assert.deepEqual(after.agents, [])
  assert.equal((await ring(so, dm)).error, 'This account was deleted.')

  // its name is free again, and a helper can remove itself (talkline's unpair)
  const again = await helper(nora, 'Nimbus AI')
  assert.equal((await api(again, 'DELETE', '/api/me')).status, 200)
  assert.equal((await api(again, 'GET', '/api/me')).status, 401)
  assert.deepEqual((await me(nora)).agents, [])

  // deleting an owner's account removes their helpers
  const olive = await register('Olive', await invite(alice))
  const h2 = await helper(olive, 'Orbit AI')
  await allow(olive, h2)
  const s2 = await socket(h2)
  const gone = next(s2, 'disconnect')
  assert.equal((await api(olive, 'DELETE', '/api/me', { auth: olive.ident.auth })).status, 200)
  await gone
  assert.equal((await api(h2, 'GET', '/api/me')).status, 401)
})

test('pause and push budgets', async () => {
  const alice = await login('Alice')
  const ruth = await register('Ruth', await invite(alice))
  const h = await helper(ruth, 'Ranger AI')
  const dm = await allow(ruth, h)
  const token = randomBytes(32).toString('hex') // fresh: a token moves to whoever registers it last
  assert.equal((await api(ruth, 'POST', '/api/devices', { token, kind: 'alert', env: 'sandbox' })).status, 200)
  const sh = await socket(h)
  const body = await seal(h, dm, { from: h.id, text: 'Build done' })
  const send = (s: Socket, convId: string, b: string, extra = {}): Promise<{ message?: Message; error?: string }> =>
    s.emitWithAck('send', { convId, body: b, cid: crypto.randomUUID(), ...extra })
  const pushesFor = (ids: number[]) => relayed.filter((p) => ids.includes(p.messageId as number))

  // Pause: the owner mutes the chat. No push, no ring.
  assert.equal((await api(ruth, 'PATCH', `/api/conversations/${dm}/me`, { muted: true })).status, 200)
  const paused = (await send(sh, dm, body)).message!
  assert.equal((await ring(sh, dm, paused.id)).error, 'Paused in Talk: no rings.')

  // Resume: 7 sends in a minute buzz 6 times (the paused one didn't count), and the first goes time-sensitive
  assert.equal((await api(ruth, 'PATCH', `/api/conversations/${dm}/me`, { muted: false })).status, 200)
  const ids = [(await send(sh, dm, body, { level: 'time-sensitive' })).message!.id]
  for (let i = 0; i < 6; i++) ids.push((await send(sh, dm, body)).message!.id)
  assert.deepEqual(await pushed((p) => p.messageId === ids[0]), { token, env: 'sandbox', type: 'message', convId: dm, messageId: ids[0], level: 'time-sensitive' })
  for (let i = 0; i < 50 && pushesFor(ids).length < 6; i++) await new Promise((r) => setTimeout(r, 20))
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(pushesFor(ids).length, 6)
  assert.equal(pushesFor([paused.id]).length, 0, 'paused: no push')

  assert.equal((await send(sh, dm, body, { level: 'loud' })).error, 'bad request')
  assert.equal((await sh.emitWithAck('send', { convId: dm, body })).error, 'bad request', 'a helper always sends a cid')

  // at night where the owner is, time-sensitive is a plain push
  const tess = await register('Tess', await invite(alice))
  const owl = await helper(tess, 'Owl AI', NIGHT)
  const dm2 = await allow(tess, owl)
  const token2 = randomBytes(32).toString('hex')
  assert.equal((await api(tess, 'POST', '/api/devices', { token: token2, kind: 'alert', env: 'sandbox' })).status, 200)
  const late = (await send(await socket(owl), dm2, await seal(owl, dm2, { from: owl.id, text: 'Done' }), { level: 'time-sensitive' })).message!
  assert.deepEqual(await pushed((p) => p.messageId === late.id), { token: token2, env: 'sandbox', type: 'message', convId: dm2, messageId: late.id })

  // a helper sends at most 60 a minute
  const chatty = await helper(tess, 'Chatty AI')
  const dm3 = await allow(tess, chatty)
  const sc = await socket(chatty)
  const tick = await seal(chatty, dm3, { from: chatty.id, text: 'tick' })
  for (let i = 0; i < 60; i++) assert.ok((await send(sc, dm3, tick, { quiet: true })).message)
  assert.equal((await send(sc, dm3, tick, { quiet: true })).error, 'Slow down: a helper can send 60 messages a minute.')
})

test('ring rules', async () => {
  const alice = await login('Alice')
  const uma = await register('Uma', await invite(alice))
  const h = await helper(uma, 'Umber AI')
  const dm = await allow(uma, h)
  const [so, sh] = await Promise.all([socket(uma), socket(h)])

  assert.equal((await ring(sh, dm)).error, 'Say which ask this ring is for.')
  const first = await ask(h, sh, dm)
  const rung = next<{ id: string }>(so, 'call:ring')
  const { id } = await ring(sh, dm, first)
  assert.equal((await rung).id, id)
  const declined = next<{ reason: string }>(sh, 'call:end')
  so.emit('call:hangup', { id })
  assert.equal((await declined).reason, 'declined')

  assert.equal((await ring(sh, dm, first)).error, 'This ask already rang.')
  assert.equal((await ring(sh, dm, await ask(h, sh, dm))).error, 'Your owner didn’t take the last ring. No more until they write to you.')
  await so.emitWithAck('send', { convId: dm, body: await seal(uma, dm, { from: uma.id, text: 'What is it?' }), cid: crypto.randomUUID() })
  assert.equal((await ring(sh, dm, await ask(h, sh, dm))).error, 'A helper rang your owner less than 10 minutes ago.')

  // the gap is the owner's, across all their helpers
  const h2 = await helper(uma, 'Umbra AI')
  const dm2 = await allow(uma, h2)
  const sh2 = await socket(h2)
  assert.equal((await ring(sh2, dm2, await ask(h2, sh2, dm2))).error, 'A helper rang your owner less than 10 minutes ago.')

  // the owner's web app connects from a night zone, and ring hours follow it
  await socket(uma, 1, { tz: NIGHT })
  assert.equal((await ring(sh2, dm2, await ask(h2, sh2, dm2))).error, 'Outside ring hours: 08:00–22:00 where your owner is.')
})

test('a ring stops at 45 s and an unanswered one counts as not taken', { timeout: 60_000 }, async () => {
  const alice = await login('Alice')
  const vic = await register('Vic', await invite(alice))
  const h = await helper(vic, 'Vesper AI')
  const dm = await allow(vic, h)
  const [so, sh] = await Promise.all([socket(vic), socket(h)])
  const first = await ask(h, sh, dm)
  const started = Date.now()
  const missed = next<{ id: string; reason: string }>(so, 'call:end').then((e) => ({ ...e, ms: Date.now() - started }))
  const { id } = await ring(sh, dm, first)
  await new Promise((r) => setTimeout(r, 30_000))
  assert.equal((await sh.emitWithAck('call:rejoin', { id })).id, id, 'the caller is back mid-ring')
  const end = await missed
  assert.deepEqual([end.id, end.reason], [id, 'missed'])
  assert.ok(end.ms < 46_000, `${end.ms} ms`)
  assert.equal((await ring(sh, dm, await ask(h, sh, dm))).error, 'Your owner didn’t take the last ring. No more until they write to you.')
})
