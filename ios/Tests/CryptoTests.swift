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

@Test func voicePeaksMatchTheWeb() {
  // Expected values from src/lib/voice.ts `bucket`.
  #expect(Voice.bucket([0.02, 0.3, 0.05, 0.12, 0, 0.2, 0.07], 5) == [0.33, 1, 0.67, 0.1, 0.83])
  #expect(Voice.bucket([0.1, 0.4], 3) == [0.55, 0.55, 1])
  #expect(Voice.bucket([]) == Array(repeating: 0.1, count: 40))
}

@Test func reportNoteFitsTheServerLimit() {
  #expect(Report.note("spam", quoting: []) == "spam")
  #expect(Report.note("", quoting: ["a", "b"]) == "Their recent messages:\na\nb")
  #expect(Report.note("x", quoting: ["old", "new"], limit: 30) == "x\n\nTheir recent messages:\nnew")
  let long = Report.note(String(repeating: "😀", count: 1500), quoting: [String(repeating: "y", count: 900)])
  #expect(long.utf16.count == 2000 && !long.contains("y"))
  #expect(Report.note("", quoting: [String(repeating: "z", count: 900)]).count == 23 + 301)
}

@Test func avatarSeedMatchesTheWeb() {
  // Expected values from the hash in Avatar, src/components/Sidebar.tsx.
  #expect(avatarSeed("Alice") == 2267157479)
  #expect(avatarSeed("Zoë") == 377293815)
  #expect(avatarSeed("Prince 🙂") == 578124735)
  #expect(avatarSeed("👩‍💻") == 2263806054)
}
