// Runs the push relay against a fake APNs (plain HTTP/2) and checks what
// Apple would receive: the signed provider token, headers and payloads.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingHttpHeaders } from 'node:http2'
import { generateKeyPairSync, verify } from 'node:crypto'

const PORT = 5000 + Math.floor(Math.random() * 1000)
const RELAY = `http://localhost:${PORT}`
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const TOKEN = 'ab'.repeat(32)
const GONE = 'cd'.repeat(32)
const id = () => crypto.randomUUID()

const got: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = []
const apple = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    got.push({ headers: req.headers, body: JSON.parse(body) })
    if (req.headers[':path'] === `/3/device/${GONE}`) return void res.writeHead(410).end(JSON.stringify({ reason: 'Unregistered' }))
    res.writeHead(200).end()
  })
})
let relay: ChildProcess

before(async () => {
  await new Promise<void>((r) => apple.listen(0, r))
  const { port } = apple.address() as { port: number }
  relay = spawn(process.execPath, ['relay/index.ts'], {
    env: {
      ...process.env, PORT: String(PORT), APNS_ORIGIN: `http://localhost:${port}`,
      APNS_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n'),
      APNS_KEY_ID: 'KEY123', APNS_TEAM_ID: 'TEAM456', APNS_BUNDLE_ID: 'test.talk',
    },
    stdio: 'inherit',
  })
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${RELAY}/healthz`).then((r) => r.ok, () => false)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('relay did not start')
})

after(() => {
  relay.kill()
  apple.close()
})

const push = (body: object) =>
  fetch(`${RELAY}/v1/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('relay signs and shapes pushes, refuses anything else', async () => {
  const convId = id()
  const callId = id()
  const from = id()

  assert.equal((await push({ token: TOKEN, env: 'sandbox', type: 'call', convId, callId, kind: 'video', from })).status, 200)
  const call = got.at(-1)!
  assert.equal(call.headers[':path'], `/3/device/${TOKEN}`)
  assert.equal(call.headers['apns-push-type'], 'voip')
  assert.equal(call.headers['apns-topic'], 'test.talk.voip')
  assert.equal(call.headers['apns-expiration'], '0')
  assert.deepEqual(call.body, { callId, convId, from, kind: 'video' })

  // ES256 provider token that verifies with the key's public half
  const [head, claims, sig] = String(call.headers.authorization).replace('bearer ', '').split('.')
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), { alg: 'ES256', kid: 'KEY123' })
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url').toString()).iss, 'TEAM456')
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')))

  assert.equal((await push({ token: TOKEN, env: 'production', type: 'message', convId, messageId: 7 })).status, 200)
  const msg = got.at(-1)!
  assert.equal(msg.headers['apns-push-type'], 'alert')
  assert.equal(msg.headers['apns-topic'], 'test.talk')
  assert.deepEqual(msg.body, { aps: { alert: { title: 'Talk', body: 'New message' }, sound: 'default', 'mutable-content': 1, 'thread-id': convId }, convId, messageId: 7 })

  assert.equal((await push({ token: TOKEN, env: 'sandbox', type: 'missed', convId, callId, kind: 'audio' })).status, 200)
  assert.equal((got.at(-1)!.body.aps as { alert: { body: string } }).alert.body, 'Missed voice call')

  // a dead token tells the server to forget it
  assert.equal((await push({ token: GONE, env: 'sandbox', type: 'message', convId, messageId: 1 })).status, 410)

  // no free text, no bad ids, no unknown types
  const before = got.length
  for (const bad of [
    { token: TOKEN, env: 'sandbox', type: 'message', convId, messageId: 'hi there' },
    { token: TOKEN, env: 'sandbox', type: 'call', convId, callId, kind: 'audio', from: 'Mallory says hi' },
    { token: 'nothex', env: 'sandbox', type: 'message', convId, messageId: 1 },
    { token: TOKEN, env: 'staging', type: 'message', convId, messageId: 1 },
    { token: TOKEN, env: 'sandbox', type: 'alert', convId },
  ]) assert.equal((await push(bad)).status, 400, JSON.stringify(bad))
  assert.equal(got.length, before)

  // per-token rate limit
  const codes = []
  for (let i = 0; i < 30; i++) codes.push((await push({ token: TOKEN, env: 'sandbox', type: 'message', convId, messageId: i })).status)
  assert.ok(codes.includes(429))

  assert.match(await (await fetch(`${RELAY}/privacy`)).text(), /end-to-end|encrypted/)
  assert.match(await (await fetch(`${RELAY}/terms`)).text(), /zero tolerance.*24 hours/is)
})
