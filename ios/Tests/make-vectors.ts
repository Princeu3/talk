// Writes vectors.json with values made by the web crypto, for the Swift
// interop test. Run from the repo root: node ios/Tests/make-vectors.ts
import { writeFileSync } from 'node:fs'
import * as c from '../../src/lib/crypto.ts'

const ITER = 1000
// The ligature checks NFKC; the capital checks the lower-cased salt.
const alice = { name: 'Alice', passphrase: 'ﬁve correct horses' }
const bob = { name: 'Bob', passphrase: 'battery staple ✓' }
const a = await c.deriveIdentity(alice.name, alice.passphrase, ITER)
const b = await c.deriveIdentity(bob.name, bob.passphrase, ITER)

const convId = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const bobId = '0a1b2c3d-4e5f-4061-8273-94a5b6c7d8e9'
const raw = c.newConvKeyBytes()
const wrapped = await c.wrapConvKey(raw, a.privateKey, b.publicKey, convId, bobId)
const { key } = await c.unwrapConvKey(wrapped, b.privateKey, a.publicKey, convId, bobId)
const body = { from: 'alice-id', text: 'héllo from the web 👋' }
const file = new TextEncoder().encode('photo bytes')

writeFileSync(new URL('vectors.json', import.meta.url), JSON.stringify({
  iterations: ITER,
  alice: { ...alice, publicKey: a.publicKey, auth: a.auth, safetyCode: await c.safetyCode(a.publicKey) },
  bob: { ...bob, id: bobId, publicKey: b.publicKey, auth: b.auth },
  convId,
  convKey: c.b64(raw),
  wrapped,
  message: { body, sealed: await c.sealMessage(key, convId, body) },
  file: { plain: c.b64(file), sealed: c.b64(await c.sealFile(key, convId, file)) },
}, null, 2) + '\n')
