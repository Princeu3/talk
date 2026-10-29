// Boots the real server against a temp data dir and drives it like three
// clients would: register, DM, group, realtime send, attachments, access checks.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { io as connect, type Socket } from 'socket.io-client'
import * as c from '../src/lib/crypto.ts'
import type { Me, Message, MessageBody } from '../shared/types.ts'

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
}

const api = async (cl: Client | null, method: string, url: string, body?: unknown, raw?: Uint8Array) => {
  const r = await fetch(BASE + url, {
    method,
    headers: {
      ...(cl ? { cookie: cl.cookie } : {}),
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
const socket = (cl: Client) =>
  new Promise<Socket>((resolve, reject) => {
    const s = connect(BASE, { extraHeaders: { cookie: cl.cookie }, transports: ['websocket'] })
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
  assert.equal((await sa.emitWithAck('call:start', { convId: group.id, kind: 'audio' })).error, 'bad request', 'groups have no calls')
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
  sc.emit('call:hangup', { id: carolCall })

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

test('safety code is stable and short', async () => {
  const id = await c.deriveIdentity('x', 'y', 1000)
  const code = await c.safetyCode(id.publicKey)
  assert.match(code, /^\d\d( \d\d){5}$/)
  assert.equal(code, await c.safetyCode(id.publicKey))
})
