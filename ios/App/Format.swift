import Foundation

// Ports of src/lib/format.ts.
enum Format {
  static func shortTime(_ ms: Double) -> String {
    let d = Date(timeIntervalSince1970: ms / 1000)
    if Calendar.current.isDateInToday(d) { return d.formatted(date: .omitted, time: .shortened) }
    if Date().timeIntervalSince(d) < 6 * 86400 { return d.formatted(.dateTime.weekday(.abbreviated)) }
    return d.formatted(.dateTime.month(.abbreviated).day())
  }

  static func day(_ ms: Double) -> String {
    Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.weekday(.wide).month(.wide).day())
  }

  static func talkTime(_ ms: Double) -> String {
    if ms < 60_000 { return "\(max(1, Int((ms / 1000).rounded()))) sec" }
    let m = Int((min(ms, 1e12) / 60_000).rounded()) // ms comes from the sender; Int() traps on huge values
    return m < 60 ? "\(m) min" : "\(m / 60) hr \(m % 60) min"
  }

  // A missed call reads differently to the caller ("No answer") and the callee.
  static func call(_ c: CallLog, mine: Bool) -> (title: String, detail: String?, missed: Bool) {
    if c.room != nil { return ("Call", "Ended", false) }
    let noun = c.kind == "audio" ? "Voice call" : "Video call"
    if let ms = c.ms, ms > 0 { return (noun, talkTime(ms), false) }
    return mine ? (noun, "No answer", false) : ("Missed \(noun.lowercased())", nil, true)
  }

  static func preview(_ body: MessageBody?, mine: Bool) -> String {
    guard let body else { return "" }
    if let c = body.call {
      let s = call(c, mine: mine)
      return s.detail.map { "\(s.title) · \($0)" } ?? s.title
    }
    if let t = body.text, !t.isEmpty { return t }
    let files = body.files ?? []
    guard let first = files.first else { return "" }
    if first.voice != nil { return "Voice message" }
    let kind = files.allSatisfy { $0.type.hasPrefix("image/") } ? "Photo" : files.allSatisfy { $0.type.hasPrefix("video/") } ? "Video" : nil
    if let kind { return files.count == 1 ? kind : "\(files.count) \(kind.lowercased())s" }
    return files.count == 1 ? first.name : "\(files.count) files"
  }

  static func size(_ n: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file) }
}
