import Foundation

// Wire types, mirroring shared/types.ts. The server only ever sees
// ciphertext for message bodies, attachments and conversation keys.

nonisolated struct User: Codable, Identifiable, Hashable, Sendable {
  let id: String
  let name: String
  let pubkey: String
  var deleted: Bool?
}

nonisolated struct Conversation: Codable, Identifiable, Hashable, Sendable {
  let id: String
  let kind: String // "dm" | "group"
  let title: String?
  let members: [String]
  let wrappedKey: String
  let wrappedBy: String
  var lastMessageAt: Double?
  var lastMessage: Message?
  var unread: Int
}

nonisolated struct Message: Codable, Identifiable, Hashable, Sendable {
  let id: Int
  let convId: String
  let senderId: String
  let body: String
  let createdAt: Double
}

// Plaintext inside Message.body.
nonisolated struct MessageBody: Codable, Hashable, Sendable {
  var from: String
  var text: String?
  var files: [FileRef]?
  var call: CallLog?
}

nonisolated struct FileRef: Codable, Hashable, Sendable {
  let id: String
  let name: String
  let type: String
  let size: Int
  var voice: Voice?
}

nonisolated struct Voice: Codable, Hashable, Sendable {
  let duration: Double
  let peaks: [Double]

  // Loudness samples -> n bar heights in 0.1...1, as src/lib/voice.ts `bucket` does.
  static func bucket(_ levels: [Double], _ n: Int = 40) -> [Double] {
    guard !levels.isEmpty else { return Array(repeating: 0.1, count: n) }
    let top = levels.max()! > 0 ? levels.max()! : 1
    return (0..<n).map { i in
      let from = i * levels.count / n
      let to = max(from + 1, (i + 1) * levels.count / n)
      let v = levels[from..<to].max()! / top
      return ((0.1 + 0.9 * v.squareRoot()) * 100).rounded() / 100
    }
  }
}

// POST /api/reports `note`: what the reporter wrote, then any messages they chose
// to quote. Fits the server's 2000 limit (JS length, so UTF-16) by dropping the
// oldest quotes first.
nonisolated enum Report {
  static func note(_ note: String, quoting quotes: [String], limit: Int = 2000) -> String {
    var quotes = quotes.map { $0.count > 300 ? String($0.prefix(300)) + "…" : $0 }
    func joined() -> String {
      quotes.isEmpty ? note : (note.isEmpty ? "" : note + "\n\n") + "Their recent messages:\n" + quotes.joined(separator: "\n")
    }
    while joined().utf16.count > limit, !quotes.isEmpty { quotes.removeFirst() }
    var s = String(joined().prefix(limit))
    while s.utf16.count > limit { s.removeLast() }
    return s
  }
}

// Avatar's seed: FNV over the lowercased name, one value per code point, its first
// UTF-16 unit, as the web's [...name].reduce(... ch.charCodeAt(0)) does, so emoji match too.
nonisolated func avatarSeed(_ name: String) -> UInt32 {
  name.lowercased().unicodeScalars.reduce(UInt32(2166136261)) { ($0 ^ UInt32($1.utf16[0])) &* 16777619 }
}

nonisolated struct CallLog: Codable, Hashable, Sendable {
  var kind: String? // "audio" | "video"
  var ms: Double? // talk time; 0 means nobody answered
  var room: String? // an old meetup call
}

nonisolated struct Me: Codable, Sendable {
  let user: User
  let users: [User]
  var conversations: [Conversation]
  let blocked: [String]?
}

nonisolated struct CallRing: Codable, Sendable {
  let id: String
  let convId: String
  let from: String
  let kind: String
}
