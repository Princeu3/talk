import CommonCrypto
import CryptoKit
import Foundation

// Byte-for-byte the web scheme in src/lib/crypto.ts, so the phone and the
// browser open each other's messages. Tests/CryptoTests.swift checks it
// against vectors made by the web code.
nonisolated enum Crypto {
  struct Identity: Sendable {
    let privateKey: Curve25519.KeyAgreement.PrivateKey
    let publicKey: String // base64url, what the server stores
    let auth: String // hex login key; the server stores its SHA-256
  }

  // PBKDF2(passphrase, name) -> 64 bytes: X25519 private key, then login key.
  static func deriveIdentity(name: String, passphrase: String, iterations: Int = 600_000) -> Identity {
    let pass = passphrase.precomposedStringWithCompatibilityMapping // NFKC
    let salt = Array("talk:v1:\(name.lowercased())".utf8)
    var out = [UInt8](repeating: 0, count: 64)
    CCKeyDerivationPBKDF(
      CCPBKDFAlgorithm(kCCPBKDF2), pass, pass.utf8.count, salt, salt.count,
      CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations), &out, out.count)
    let key = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: out[0..<32])
    return Identity(privateKey: key, publicKey: key.publicKey.rawRepresentation.b64, auth: out[32...].map { String(format: "%02x", $0) }.joined())
  }

  static func pairKey(_ mine: Curve25519.KeyAgreement.PrivateKey, _ theirPub: String) throws -> SymmetricKey {
    let pub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: Data(b64: theirPub))
    return try mine.sharedSecretFromKeyAgreement(with: pub).hkdfDerivedSymmetricKey(
      using: SHA256.self, salt: Data(count: 32), sharedInfo: Data("talk:wrap:v1".utf8), outputByteCount: 32)
  }

  // iv(12) + ciphertext + tag(16): CryptoKit's combined form.
  static func seal(_ key: SymmetricKey, _ data: Data, _ aad: String) throws -> Data {
    try AES.GCM.seal(data, using: key, authenticating: Data(aad.utf8)).combined!
  }

  static func open(_ key: SymmetricKey, _ data: Data, _ aad: String) throws -> Data {
    try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key, authenticating: Data(aad.utf8))
  }

  // --- conversation keys ---

  static func newConvKey() -> Data { SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) } }

  static func wrapConvKey(_ raw: Data, mine: Curve25519.KeyAgreement.PrivateKey, theirPub: String, convId: String, theirId: String) throws -> String {
    try seal(pairKey(mine, theirPub), raw, "key:\(convId):\(theirId)").b64
  }

  // The raw bytes, kept for re-wrapping when someone joins a group.
  static func unwrapConvKey(_ wrapped: String, mine: Curve25519.KeyAgreement.PrivateKey, wrapperPub: String, convId: String, myId: String) throws -> Data {
    try open(pairKey(mine, wrapperPub), Data(b64: wrapped), "key:\(convId):\(myId)")
  }

  // --- messages and files ---

  static func sealMessage<T: Encodable>(_ key: SymmetricKey, convId: String, _ body: T) throws -> String {
    try seal(key, JSONEncoder().encode(body), "msg:\(convId)").b64
  }

  static func openMessage<T: Decodable>(_ key: SymmetricKey, convId: String, _ sealed: String) throws -> T {
    try JSONDecoder().decode(T.self, from: open(key, Data(b64: sealed), "msg:\(convId)"))
  }

  static func sealFile(_ key: SymmetricKey, convId: String, _ data: Data) throws -> Data { try seal(key, data, "file:\(convId)") }
  static func openFile(_ key: SymmetricKey, convId: String, _ data: Data) throws -> Data { try open(key, data, "file:\(convId)") }

  // Short code two people compare out loud to confirm nobody swapped a key.
  static func safetyCode(_ pubkey: String) -> String {
    SHA256.hash(data: Data(b64: pubkey)).prefix(6).map { String(format: "%02d", $0 % 100) }.joined(separator: " ")
  }
}

// base64url without padding, as the web code writes it.
nonisolated extension Data {
  init(b64 s: String) {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    t += String(repeating: "=", count: (4 - t.count % 4) % 4)
    self = Data(base64Encoded: t) ?? Data()
  }

  var b64: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
}
