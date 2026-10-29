import CryptoKit
import Foundation
import Testing

// Opens what the web code sealed (vectors.json, from make-vectors.ts).
struct Vectors: Decodable {
  struct Person: Decodable { let name, passphrase, publicKey, auth: String; let safetyCode, id: String? }
  struct Msg: Decodable { let body: MessageBody; let sealed: String }
  struct File: Decodable { let plain, sealed: String }
  let iterations: Int
  let alice, bob: Person
  let convId, convKey, wrapped: String
  let message: Msg
  let file: File

  static let load: Vectors = {
    let url = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "vectors.json")
    return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }()
}

@Test func sameIdentityAsTheWeb() {
  let v = Vectors.load
  for p in [v.alice, v.bob] {
    let id = Crypto.deriveIdentity(name: p.name, passphrase: p.passphrase, iterations: v.iterations)
    #expect(id.publicKey == p.publicKey)
    #expect(id.auth == p.auth)
  }
  #expect(Crypto.safetyCode(v.alice.publicKey) == v.alice.safetyCode)
}

@Test func opensWhatTheWebSealed() throws {
  let v = Vectors.load
  let bob = Crypto.deriveIdentity(name: v.bob.name, passphrase: v.bob.passphrase, iterations: v.iterations)
  let raw = try Crypto.unwrapConvKey(v.wrapped, mine: bob.privateKey, wrapperPub: v.alice.publicKey, convId: v.convId, myId: v.bob.id!)
  #expect(raw.b64 == v.convKey)
  let key = SymmetricKey(data: raw)
  let body: MessageBody = try Crypto.openMessage(key, convId: v.convId, v.message.sealed)
  #expect(body == v.message.body)
  #expect(try Crypto.openFile(key, convId: v.convId, Data(b64: v.file.sealed)).b64 == v.file.plain)
  // bound to its conversation
  #expect(throws: (any Error).self) { let _: MessageBody = try Crypto.openMessage(key, convId: "other", v.message.sealed) }
}

@Test func webCanOpenWhatWeSeal() throws {
  // The other way round: Alice wraps for Bob here, Bob unwraps with the web's public key for Alice.
  let v = Vectors.load
  let alice = Crypto.deriveIdentity(name: v.alice.name, passphrase: v.alice.passphrase, iterations: v.iterations)
  let bob = Crypto.deriveIdentity(name: v.bob.name, passphrase: v.bob.passphrase, iterations: v.iterations)
  let raw = Crypto.newConvKey()
  let wrapped = try Crypto.wrapConvKey(raw, mine: alice.privateKey, theirPub: v.bob.publicKey, convId: v.convId, theirId: v.bob.id!)
  #expect(try Crypto.unwrapConvKey(wrapped, mine: bob.privateKey, wrapperPub: v.alice.publicKey, convId: v.convId, myId: v.bob.id!) == raw)
}
