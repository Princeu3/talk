import CryptoKit
import Foundation
import Testing
import UIKit

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

@Test func diskNameIsOneSafePathComponent() {
  #expect(diskName("photo.JPG") == "photo.JPG")
  #expect(diskName("../../Library/x.plist") == "..-..-Library-x.plist")
  #expect(diskName("") == "file")
  #expect(diskName(".") == "file")
  #expect(diskName("..") == "file")
  #expect(diskName("Dr. Patel referral letter") == "Dr. Patel referral letter")
  let long = diskName(String(repeating: "👩‍💻", count: 200) + ".mov")
  #expect(long.hasSuffix(".mov") && long.utf8.count <= 255)
}

@Test func avatarSeedMatchesTheWeb() {
  // Expected values from the hash in Avatar, src/components/Sidebar.tsx.
  #expect(avatarSeed("Alice") == 2267157479)
  #expect(avatarSeed("Zoë") == 377293815)
  #expect(avatarSeed("Prince 🙂") == 578124735)
  #expect(avatarSeed("👩‍💻") == 2263806054)
}

@Test func oldAndNewMessagesDecode() throws {
  // Older apps and servers send neither field; both must still decode.
  let old = try JSONDecoder().decode(MessageBody.self, from: Data(#"{"from":"a","text":"hi"}"#.utf8))
  #expect(old.preview == nil)
  let new = try JSONDecoder().decode(MessageBody.self, from: Data(#"{"from":"a","text":"see https://x.org","preview":{"url":"https://x.org","title":"X"}}"#.utf8))
  #expect(new.preview == LinkPreview(url: "https://x.org", title: "X"))
  #expect(try JSONDecoder().decode(GroupCall.self, from: Data(#"{"id":"c","kind":"audio","from":"a","peers":["a"]}"#.utf8)).ringing == nil)
  #expect(try JSONDecoder().decode(GroupCall.self, from: Data(#"{"id":"c","kind":"audio","from":"a","peers":["a"],"ringing":["b"]}"#.utf8)).ringing == ["b"])
  // Unset fields stay off the wire, so older apps see the body they know.
  #expect(!String(decoding: try JSONEncoder().encode(old), as: UTF8.self).contains("preview"))
}

@Test func linksAreWebOnlyAndCardsFollowThem() {
  #expect(LinkPreview.links(in: "a https://a.org/x b mailto:z@y.org c ftp://f.org www.b.org").map(\.absoluteString) == ["https://a.org/x", "http://www.b.org"])
  let card = LinkPreview(url: "https://a.org/x")
  #expect(card.fits("now https://a.org/x"))
  #expect(!card.fits("now https://a.org/y"))
}

@Test func thumbnailsFitTheWireLimit() throws {
  // Noise compresses badly, so this has to step down in size and quality.
  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  let big = UIGraphicsImageRenderer(size: CGSize(width: 1600, height: 900), format: format).image { ctx in
    for x in stride(from: 0, to: 1600, by: 8) {
      for y in stride(from: 0, to: 900, by: 8) {
        UIColor(red: .random(in: 0...1), green: .random(in: 0...1), blue: .random(in: 0...1), alpha: 1).setFill()
        ctx.fill(CGRect(x: x, y: y, width: 8, height: 8))
      }
    }
  }
  let data = try #require(LinkPreview.thumb(big).flatMap { Data(base64Encoded: $0) })
  let img = try #require(UIImage(data: data))
  #expect(data.count <= 24 * 1024)
  #expect(max(img.size.width, img.size.height) <= 320)
}

@Test func searchMatchesWhatPeopleSee() {
  let text = MessageBody(from: "a", text: "First line\nWe met at the Café Zoë yesterday")
  #expect(Search.hit(text, "cafe zoe") == "We met at the Café Zoë yesterday") // case and accents ignored, the matching line only
  #expect(Search.hit(MessageBody(from: "a", files: [FileRef(id: "f", name: "Lease.pdf", type: "application/pdf", size: 1)]), "lease") == "Lease.pdf")
  #expect(Search.hit(MessageBody(from: "a", text: "look", preview: LinkPreview(url: "https://a.org", title: "Trail map")), "trail") == "Trail map")
  #expect(Search.hit(MessageBody(from: "a", text: "Alice added Bob", system: true), "alice") == nil)
  #expect(Search.hit(MessageBody(from: "a", call: CallLog(kind: "audio", ms: 0)), "call") == nil)

  let s = Search.snippet("a long opening sentence that runs on before the word banana shows up", "BANANA")
  #expect(String(s.characters) == "…on before the word banana shows up") // trimmed to a whole word
  let bold = s.runs.filter { $0.inlinePresentationIntent == .stronglyEmphasized }.map { String(s[$0.range].characters) }
  #expect(bold == ["banana"])
  #expect(String(Search.snippet("short banana", "banana").characters) == "short banana")
}
