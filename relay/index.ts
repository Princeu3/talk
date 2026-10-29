// Push relay for Talk's iPhone app. Talk servers are self-hosted, but the
// APNs key belongs to the app's developer, so servers ask this relay to push.
// It builds every payload itself from ids, so nobody can push text through it,
// and it stores nothing.
import { createServer } from 'node:http'
import { connect, type ClientHttp2Session } from 'node:http2'
import { createPrivateKey, sign } from 'node:crypto'

const { PORT = '3000', APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID: BUNDLE = 'dev.princeuniverse.talk' } = process.env
// Railway variables may hold the .p8 with literal \n.
const KEY = process.env.APNS_KEY ? createPrivateKey(process.env.APNS_KEY.replace(/\\n/g, '\n')) : null
// APNS_ORIGIN points both at a fake APNs in tests.
const ORIGIN: Record<string, string> = {
  sandbox: process.env.APNS_ORIGIN ?? 'https://api.sandbox.push.apple.com',
  production: process.env.APNS_ORIGIN ?? 'https://api.push.apple.com',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TOKEN = /^[0-9a-f]{64,200}$/
const PER_MINUTE = 30

// APNs wants a fresh provider token at least hourly and no more than every 20 minutes.
let jwt = { token: '', at: 0 }
function bearer() {
  if (Date.now() - jwt.at > 50 * 60_000) {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const head = `${part({ alg: 'ES256', kid: APNS_KEY_ID })}.${part({ iss: APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })}`
    const sig = sign('sha256', Buffer.from(head), { key: KEY!, dsaEncoding: 'ieee-p1363' }).toString('base64url')
    jwt = { token: `${head}.${sig}`, at: Date.now() }
  }
  return jwt.token
}

// One long-lived HTTP/2 connection per APNs host, as Apple asks.
const sessions = new Map<string, ClientHttp2Session>()
function session(origin: string) {
  let s = sessions.get(origin)
  if (!s || s.closed || s.destroyed) {
    const fresh = connect(origin)
    fresh.on('error', (e) => console.error('[apns]', e.message))
    const drop = () => sessions.get(origin) === fresh && sessions.delete(origin)
    fresh.on('goaway', drop).on('close', drop)
    sessions.set(origin, (s = fresh))
  }
  return s
}

function apns(origin: string, token: string, headers: Record<string, string>, body: object) {
  return new Promise<{ status: number; reason?: string }>((resolve, reject) => {
    const req = session(origin).request({ ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${bearer()}`, ...headers })
    let status = 0
    let data = ''
    req.setEncoding('utf8')
    req.setTimeout(10_000, () => req.close())
    req.on('response', (h) => void (status = Number(h[':status'])))
    req.on('data', (c: string) => void (data += c))
    req.on('end', () => resolve({ status, reason: data ? (JSON.parse(data) as { reason?: string }).reason : undefined }))
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

type Push = { token: string; env: string; type: string; convId: string; callId?: string; messageId?: number; kind?: string; from?: string }

// Returns APNs headers and payload, or null if the request is malformed.
function build(p: Push): [Record<string, string>, object] | null {
  if (!TOKEN.test(p.token) || !ORIGIN[p.env] || !UUID.test(p.convId)) return null
  const call = p.kind === 'video' ? 'video call' : 'voice call'
  const alert = (body: string, ids: object): [Record<string, string>, object] => [
    { 'apns-push-type': 'alert', 'apns-topic': BUNDLE, 'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400) },
    // The app's notification extension swaps in the sender and decrypted text.
    { aps: { alert: { title: 'Talk', body }, sound: 'default', 'mutable-content': 1, 'thread-id': p.convId }, convId: p.convId, ...ids },
  ]
  const callOk = typeof p.callId === 'string' && UUID.test(p.callId) && (p.kind === 'audio' || p.kind === 'video')
  switch (p.type) {
    case 'message':
      return Number.isSafeInteger(p.messageId) ? alert('New message', { messageId: p.messageId }) : null
    case 'missed':
      return callOk ? alert(`Missed ${call}`, { callId: p.callId }) : null
    case 'call':
      // A VoIP push is useless once the ring is over, so APNs must not hold it.
      return callOk && typeof p.from === 'string' && UUID.test(p.from)
        ? [{ 'apns-push-type': 'voip', 'apns-topic': `${BUNDLE}.voip`, 'apns-priority': '10', 'apns-expiration': '0' },
           { callId: p.callId, convId: p.convId, from: p.from, kind: p.kind }]
        : null
  }
  return null
}

// shortcut: fixed one-minute window in memory; fine for one instance.
const hits = new Map<string, number>()
setInterval(() => hits.clear(), 60_000).unref()

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>body{font:17px/1.55 system-ui,sans-serif;max-width:40rem;margin:2.5rem auto;padding:0 1rem;color:#2e3d28;background:#f4f4ee}h1{font-size:1.7rem}h2{font-size:1.15rem;margin-top:2rem}</style>` +
  `<h1>${title}</h1>${body}`

const PRIVACY = page('Talk privacy policy', `
<p>Updated October 29, 2026. Talk is made by Prince Upadhyay.</p>
<h2>Your server holds your account</h2>
<p>Talk connects to a server that you or someone in your group runs. The app's developer does not run that server and cannot see what is on it, except on the demo server used for App Review.</p>
<h2>What the server can see</h2>
<p>Messages, photos, files and voice messages are encrypted on your phone before they leave it. The server stores only the encrypted bytes, your display name, your public key, which conversations you are in, and when messages were sent. It cannot read your messages.</p>
<h2>Calls</h2>
<p>Calls go directly between the two phones, encrypted. When a direct path is not possible, the call is relayed through a TURN server your Talk server chooses (usually Cloudflare). The relay passes encrypted media and cannot listen.</p>
<h2>Notifications</h2>
<p>To wake your phone, your Talk server sends this push relay your device's push token and a few ids: the conversation, the message or call, and the caller's account id. The relay passes them to Apple and keeps nothing. Notification text is decrypted on your phone.</p>
<h2>What we don't do</h2>
<p>No ads, no analytics, no tracking, and nothing is sold or shared.</p>
<h2>Deleting your data</h2>
<p>In the app, open Settings and choose Delete account. That removes your account, devices and every message you sent from your server.</p>
<h2>Contact</h2>
<p>Questions: <a href="https://github.com/Princeu3/talk/issues">github.com/Princeu3/talk/issues</a>.</p>`)

const SUPPORT = page('Talk support', `
<p>Talk is a private messenger with voice and video calls for a small group, on a server you run.</p>
<h2>Getting started</h2>
<p>Ask a friend who uses Talk for an invite link, open it on your iPhone, and pick a name and passphrase. To run your own server, deploy it on Railway from <a href="https://github.com/Princeu3/talk">github.com/Princeu3/talk</a>.</p>
<h2>Calls don't ring</h2>
<p>Allow notifications for Talk, and check that Focus or Do Not Disturb isn't silencing it.</p>
<h2>Report a problem</h2>
<p>Open an issue at <a href="https://github.com/Princeu3/talk/issues">github.com/Princeu3/talk/issues</a>. To report a person, open the chat, tap their name and choose Report.</p>
<p><a href="/privacy">Privacy policy</a></p>`)

createServer(async (req, res) => {
  const send = (status: number, body: object) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  if (req.method === 'GET') {
    const html = { '/privacy': PRIVACY, '/support': SUPPORT, '/': SUPPORT }[req.url ?? '']
    if (req.url === '/healthz') return void res.end('ok')
    return void (html ? res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html) : send(404, { error: 'not found' }))
  }
  if (req.method !== 'POST' || req.url !== '/v1/push') return send(404, { error: 'not found' })
  if (!KEY) return send(503, { error: 'relay has no APNs key' })

  let raw = ''
  for await (const c of req) if ((raw += c).length > 4096) return send(413, { error: 'too large' })
  let p: Push
  try {
    p = JSON.parse(raw)
  } catch {
    return send(400, { error: 'bad json' })
  }
  const built = p && typeof p === 'object' && typeof p.token === 'string' ? build(p) : null
  if (!built) return send(400, { error: 'bad request' })
  const n = (hits.get(p.token) ?? 0) + 1
  hits.set(p.token, n)
  if (n > PER_MINUTE) return send(429, { error: 'slow down' })

  try {
    const r = await apns(ORIGIN[p.env], p.token, ...built)
    if (r.status === 200) return send(200, { ok: true })
    // Gone or wrong for this app: the server should forget the token.
    if (r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'DeviceTokenNotForTopic') return send(410, { error: r.reason })
    console.error('[apns]', r.status, r.reason)
    send(502, { error: r.reason ?? `APNs ${r.status}` })
  } catch (e) {
    console.error('[apns]', (e as Error).message)
    send(502, { error: 'APNs unreachable' })
  }
}).listen(Number(PORT), () => console.log(`push relay on :${PORT}${KEY ? '' : ' (no APNS_KEY: pushes refused)'}`))
