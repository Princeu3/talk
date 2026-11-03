import Foundation
import UIKit

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
  var reads: [String: Int]? // each member's last read message id, for read receipts
  var muted: Bool? // mine: no pushes for messages or group call rings
  var pinned: Bool? // mine: listed first
  var call: GroupCall? // a group call on now
}

// A live group call, as the chat's members see it. `peers` are the user ids in it.
nonisolated struct GroupCall: Codable, Hashable, Sendable {
  let id: String
  let kind: String // "audio" | "video"
  let from: String // who started it
  let peers: [String]
  var ringing: [String]? // rung and not yet in, declined or timed out
}

nonisolated struct Message: Codable, Identifiable, Hashable, Sendable {
  let id: Int
  let convId: String
  let senderId: String
  let body: String
  let createdAt: Double
  var editedAt: Double?
  var reactions: [Reaction]?
}

nonisolated struct Reaction: Codable, Hashable, Sendable {
  let userId: String
  let body: String // sealed ReactionBody
}

// Plaintext inside Reaction.body. `from` and `to` must match the row, or the app ignores it.
nonisolated struct ReactionBody: Codable, Hashable, Sendable {
  let from: String
  let to: Int // message id
  let emoji: String
}

// Plaintext inside Message.body.
nonisolated struct MessageBody: Codable, Hashable, Sendable {
  var from: String
  var text: String?
  var files: [FileRef]?
  var call: CallLog?
  var reply: Reply?
  var forwarded: Bool?
  var system: Bool? // a group event ("Alice added Bob"); `text` holds it, so older apps show it as a message
  var preview: LinkPreview?
}

// A link's card. The sender's device makes it and seals it with the message,
// so readers never contact the site.
nonisolated struct LinkPreview: Codable, Hashable, Sendable {
  let url: String
  var title: String? // at most 200 chars
  var description: String? // at most 300 chars
  var site: String?
  var image: String? // JPEG thumbnail, base64, longest side ≤ 320 px, ≤ 24 KB
}

nonisolated extension LinkPreview {
  static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) // also links bubble text

  // The http(s) links in some text, in order, each with where it sits in the text.
  private static func found(in s: String) -> [(range: Range<String.Index>, url: URL)] {
    (detector?.matches(in: s, range: NSRange(s.startIndex..., in: s)) ?? []).compactMap { m in
      guard let url = m.url, ["http", "https"].contains(url.scheme?.lowercased()), let r = Range(m.range, in: s) else { return nil }
      return (r, url)
    }
  }

  static func links(in s: String) -> [URL] { found(in: s).map(\.url) }

  // The text's first link: as typed, for a card's url (with `http://` when typed without a scheme), and the
  // detector's URL to fetch. That URL may be percent-encoded or punycoded, which the text doesn't contain.
  static func first(in s: String) -> (typed: String, url: URL)? {
    guard let (r, url) = found(in: s).first else { return nil }
    let t = String(s[r])
    return (bare(t).startIndex == t.startIndex ? "http://" + t : t, url)
  }

  // A link without its leading http:// or https://, any case.
  private static func bare(_ link: String) -> Substring {
    link[(link.range(of: "^https?://", options: [.regularExpression, .caseInsensitive])?.upperBound ?? link.startIndex)...]
  }

  // The card stays only while the text holds its link, scheme optional (the web's rule too).
  func fits(_ text: String) -> Bool { text.contains(Self.bare(url)) }

  // The sender picks the link, so a received card keeps it only if it's http(s).
  var isWeb: Bool { ["http", "https"].contains(URL(string: url)?.scheme?.lowercased()) }

  // The card's image as JPEG: longest side ≤ 320 px, ≤ 24 KB, smaller and rougher until it fits, else none.
  static func thumb(_ img: UIImage) -> String? {
    let w = img.size.width * img.scale, h = img.size.height * img.scale
    var side = min(320, max(w, h))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    while side >= 80 {
      let k = side / max(w, h)
      let size = CGSize(width: max(1, (w * k).rounded()), height: max(1, (h * k).rounded()))
      let small = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
        UIColor.white.setFill() // JPEG has no transparency: logos go on white, not black
        ctx.fill(CGRect(origin: .zero, size: size))
        img.draw(in: CGRect(origin: .zero, size: size))
      }
      for q in [0.7, 0.5, 0.3] {
        if let d = small.jpegData(compressionQuality: q), d.count <= 24 * 1024 { return d.base64EncodedString() }
      }
      side *= 0.7
    }
    return nil
  }
}

// Chat search (docs/chat-features.md): ignores case and accents; covers text, file names and link titles,
// never event lines or call logs.
nonisolated enum Search {
  // What search looks through, folded once per message: its text, file names and link title. A plain
  // `contains` of the folded query narrows the field; `hit` then finds the line.
  static func text(_ b: MessageBody) -> String {
    guard b.system != true, b.call == nil else { return "" }
    return fold(([b.text, b.preview?.title].compactMap { $0 } + (b.files ?? []).map(\.name)).joined(separator: "\n"))
  }

  static func fold(_ s: String) -> String { s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil) }

  // The line that matched: one of the text's lines, a file name, or the link's title.
  static func hit(_ b: MessageBody, _ q: String) -> String? {
    guard b.system != true, b.call == nil else { return nil }
    let text = b.text?.split(whereSeparator: \.isNewline).map(String.init) ?? []
    return (text + (b.files ?? []).map(\.name) + [b.preview?.title].compactMap { $0 }).first { $0.localizedStandardContains(q) }
  }

  // The line from a little before the match, so a short row still shows it, with the match in bold.
  static func snippet(_ line: String, _ q: String) -> AttributedString {
    guard let r = line.range(of: q, options: [.caseInsensitive, .diacriticInsensitive], locale: .current) else { return AttributedString(line) }
    var start = line.distance(from: line.startIndex, to: r.lowerBound) > 30 ? line.index(r.lowerBound, offsetBy: -20) : line.startIndex
    // Start on a whole word when one begins before the match.
    if start > line.startIndex, let sp = line[start..<r.lowerBound].firstIndex(of: " ") { start = line.index(after: sp) }
    var match = AttributedString(line[r])
    match.inlinePresentationIntent = .stronglyEmphasized
    return AttributedString((start > line.startIndex ? "…" : "") + line[start..<r.lowerBound]) + match + AttributedString(line[r.upperBound...])
  }
}

// Quoted in a reply, so it shows even when the original isn't loaded or was unsent.
nonisolated struct Reply: Codable, Hashable, Sendable {
  let id: Int
  let from: String // user id of the quoted message's sender
  let preview: String // its text, or "Photo", "Voice message", ...; at most 200 chars
}

nonisolated struct FileRef: Codable, Hashable, Sendable {
  let id: String
  let name: String
  let type: String
  let size: Int
  var voice: Voice?
}

// The sender picks file names: make one a single path component the disk accepts (no "/",
// never "", "." or "..", well under 255 bytes), keeping a short extension.
nonisolated func diskName(_ name: String) -> String {
  let n = name.replacingOccurrences(of: "/", with: "-") as NSString
  var bytes = 0
  // A long "extension" is part of the name ("Dr. Patel referral letter"), so keep it in the stem.
  let ext = n.pathExtension.utf8.count <= 16 ? n.pathExtension : ""
  var stem = String((ext.isEmpty ? n as String : n.deletingPathExtension).prefix { bytes += $0.utf8.count; return bytes <= 100 })
  if stem.isEmpty || stem == "." || stem == ".." { stem = "file" }
  return ext.isEmpty ? stem : "\(stem).\(ext)"
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
  var group: Bool?
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
  var group: Bool? = nil // set on group rings
}
