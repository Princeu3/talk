// End-to-end encryption, WebCrypto only (works in browsers and Node).
//
// identity:  PBKDF2(passphrase, name) -> 64 bytes
//            [0..32)  X25519 private key (never leaves the device)
//            [32..64) login key (server stores its SHA-256)
// conv key:  random AES-256 key per conversation, sealed for each member with
//            AES-GCM under HKDF(X25519(sealer, member)).
// messages and files: AES-GCM under the conv key, random 96-bit IV, AAD binds
//            the ciphertext to its conversation (and recipient, for key wraps).

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
type Bytes = Uint8Array<ArrayBuffer>
const dec = new TextDecoder()

export const b64 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// PKCS#8 header for a raw 32-byte X25519 private key (RFC 8410).
const PKCS8_X25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20])

export interface Identity {
  privateKey: CryptoKey
  publicKey: string
  auth: string
}

export async function deriveIdentity(name: string, passphrase: string, iterations = 600_000): Promise<Identity> {
  const base = await subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'])
  const salt = enc.encode(`talk:v1:${name.toLowerCase()}`)
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 512))
  const pkcs8 = new Uint8Array([...PKCS8_X25519, ...bits.subarray(0, 32)])
  // Import once extractable only to read the public half, then keep a non-extractable copy.
  const tmp = await subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, true, ['deriveBits'])
  const { x } = await subtle.exportKey('jwk', tmp)
  const privateKey = await subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, ['deriveBits'])
  return { privateKey, publicKey: x!, auth: hex(bits.subarray(32)) }
}

async function pairKey(privateKey: CryptoKey, theirPub: string): Promise<CryptoKey> {
  const pub = await subtle.importKey('raw', unb64(theirPub), { name: 'X25519' }, false, [])
  const shared = await subtle.deriveBits({ name: 'X25519', public: pub }, privateKey, 256)
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('talk:wrap:v1') },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function seal(key: CryptoKey, data: Bytes, aad: string): Promise<Bytes> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, data)
  return new Uint8Array([...iv, ...new Uint8Array(ct)])
}

async function open(key: CryptoKey, data: Bytes, aad: string): Promise<Bytes> {
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: enc.encode(aad) },
    key,
    data.subarray(12),
  )
  return new Uint8Array(pt)
}

// --- conversation keys ---

export const newConvKeyBytes = () => globalThis.crypto.getRandomValues(new Uint8Array(32))

export async function wrapConvKey(raw: Bytes, myKey: CryptoKey, theirPub: string, convId: string, theirId: string) {
  return b64(await seal(await pairKey(myKey, theirPub), raw, `key:${convId}:${theirId}`))
}

// Returns the conversation key; the raw bytes stay available for re-wrapping
// when someone is added to a group.
export async function unwrapConvKey(wrapped: string, myKey: CryptoKey, wrapperPub: string, convId: string, myId: string) {
  const raw = await open(await pairKey(myKey, wrapperPub), unb64(wrapped), `key:${convId}:${myId}`)
  return { raw, key: await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) }
}

// --- messages and files ---

export const sealMessage = async (convKey: CryptoKey, convId: string, body: unknown) =>
  b64(await seal(convKey, enc.encode(JSON.stringify(body)), `msg:${convId}`))

export const openMessage = async <T>(convKey: CryptoKey, convId: string, sealed: string): Promise<T> =>
  JSON.parse(dec.decode(await open(convKey, unb64(sealed), `msg:${convId}`)))

export const sealFile = (convKey: CryptoKey, convId: string, bytes: Bytes) => seal(convKey, bytes, `file:${convId}`)
export const openFile = (convKey: CryptoKey, convId: string, bytes: Bytes) => open(convKey, bytes, `file:${convId}`)

// Short code two people can compare out loud to confirm the server did not
// swap a public key.
export async function safetyCode(pubkey: string) {
  const h = new Uint8Array(await subtle.digest('SHA-256', unb64(pubkey)))
  return Array.from(h.subarray(0, 6), (b) => String(b % 100).padStart(2, '0')).join(' ')
}
