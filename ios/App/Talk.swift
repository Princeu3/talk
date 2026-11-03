import CryptoKit
import Foundation
import ImageIO
import Observation
import UIKit
import UserNotifications

// Nonisolated, so archive pages decrypt and search scans off the main thread.
nonisolated struct Decrypted: Identifiable, Hashable {
  var message: Message
  let content: MessageBody? // nil: could not decrypt
  var reactions: [String: String] = [:] // user id -> emoji, only those whose sealed from/to match the row
  let folded: String // what search looks through, folded once (Search.text)
  var id: Int { message.id }

  init(message: Message, content: MessageBody?) {
    self.message = message
    self.content = content
    folded = content.map(Search.text) ?? ""
  }

  var forged: Bool { content.map { $0.from != message.senderId } ?? false }
  // A group event line ("Alice added Bob"). A forged one shows as a message, with the warning.
  var system: Bool { content?.system == true && !forged }
}

// A message on its way out, sealed. Resends reuse `cid`, so the server stores it once.
struct Pending: Codable, Identifiable, Hashable {
  let cid: String
  let convId: String
  let body: String
  let createdAt: Double
  var quiet = false
  var seen = false
  var sending = true // false: waiting for the socket
  var error: String? // the server refused it; no automatic resend
  var id: String { cid }
}

// All signed-in state and actions, like src/lib/useTalk.ts on the web.
@Observable
final class Talk {
  let account: Account
  // The icon badge follows the server's unread counts, which the notification
  // extension also uses, so the two never drift apart.
  private(set) var me: Me? { didSet { UNUserNotificationCenter.current().setBadgeCount(totalUnread) } }
  private(set) var messages: [String: [Decrypted]] = [:]
  private(set) var hasOlder: [String: Bool] = [:]
  private(set) var pending: [Pending] = [] // unsent, oldest first, all chats
  private(set) var online = false // the socket is up; the list says "Connecting…" otherwise
  private(set) var typing: [String: [String: Date]] = [:] // conv id -> user id -> their last typing signal
  var activeId: String?
  var onSignedOut: () -> Void = {}

  @ObservationIgnored let socket: Socket
  @ObservationIgnored private var keys: [String: Data] = [:]
  @ObservationIgnored private var loaded = Set<String>()
  @ObservationIgnored private var files: [String: Data] = [:]
  @ObservationIgnored private let thumbs = { let c = NSCache<NSString, UIImage>(); c.totalCostLimit = 32 << 20; return c }() // shared-media squares, by file id
  @ObservationIgnored private(set) var saved: [String: URL] = [:] // attachments over `inMemory`, as temp files
  @ObservationIgnored private(set) var fetching: [String: Task<URL, Error>] = [:] // one download per file at a time
  // On screen, not just running: a call push wakes the app in the background.
  @ObservationIgnored private var visible = false
  @ObservationIgnored private var saving: Task<Void, Never>?
  @ObservationIgnored private var draining = false
  @ObservationIgnored private var forgotten = false // signed out: a late delivery mustn't write the cache back
  @ObservationIgnored private var typedAt: [String: Date] = [:] // my last typing signal per chat
  @ObservationIgnored private var heard = 0 // messages received, so a reload can tell it raced one
  // shortcut: each chat's whole history, decrypted in memory for the session and scanned on every search;
  // upgrade to an FTS5 index once a device's history makes the first search slow.
  @ObservationIgnored private var archive: [String: [Decrypted]] = [:] // pages fetched for search and shared media, newest first
  @ObservationIgnored private var archiving: [String: Task<Void, Never>] = [:]
  @ObservationIgnored private var bumping = false
  private(set) var complete = Set<String>() // chats archived back to their first message
  private(set) var progress = 0 // bumped as pages arrive, at most every 0.4 s, so views re-run without redrawing per page
  private static let page = 50
  private nonisolated static let archivePage = 500 // the server's most
  private nonisolated static let maxFound = 200
  static let emoji = ["👍", "❤️", "😂", "😮", "😢", "🙏"]

  var api: API { account.api }
  var totalUnread: Int { me?.conversations.reduce(0) { $0 + $1.unread } ?? 0 }

  init(account: Account) {
    self.account = account
    try? FileManager.default.removeItem(at: Self.savedDir) // nothing from an earlier launch is referenced again
    socket = Socket(account: account)
    socket.on("message") { [weak self] data in
      guard let self, let msg = try? JSONDecoder().decode(Message.self, from: data) else { return }
      heard += 1
      Task { await self.receive(msg) }
    }
    socket.on("sync") { [weak self] _ in Task { try? await self?.load() } }
    // A chat's live group call, or null once it's over.
    socket.on("call:update") { [weak self] data in
      struct Update: Decodable { let convId: String; let call: GroupCall? }
      guard let u = try? JSONDecoder().decode(Update.self, from: data) else { return }
      self?.updateConv(u.convId) { $0.call = u.call }
    }
    socket.on("reaction") { [weak self] data in
      struct R: Decodable { let messageId: Int; let convId: String; let userId: String; let body: String? }
      guard let r = try? JSONDecoder().decode(R.self, from: data) else { return }
      self?.setReaction(r.convId, r.messageId, r.userId, r.body)
    }
    socket.on("edit") { [weak self] data in
      guard let msg = try? JSONDecoder().decode(Message.self, from: data) else { return }
      self?.edited(msg)
    }
    // A `sync` follows, for previews and unread counts.
    socket.on("unsend") { [weak self] data in
      struct U: Decodable { let id: Int; let convId: String }
      guard let u = try? JSONDecoder().decode(U.self, from: data) else { return }
      self?.update(u.convId, u.id) { _ in nil }
    }
    socket.on("read") { [weak self] data in
      struct R: Decodable { let convId: String; let userId: String; let upTo: Int }
      guard let r = try? JSONDecoder().decode(R.self, from: data) else { return }
      self?.updateConv(r.convId) { $0.reads = ($0.reads ?? [:]).merging([r.userId: r.upTo]) { max($0, $1) } }
    }
    socket.on("typing") { [weak self] data in
      struct T: Decodable { let convId: String; let userId: String }
      guard let self, let t = try? JSONDecoder().decode(T.self, from: data) else { return }
      let at = Date()
      typing[t.convId, default: [:]][t.userId] = at
      Task {
        try? await Task.sleep(for: .seconds(6))
        if self.typing[t.convId]?[t.userId] == at { self.typing[t.convId]?[t.userId] = nil }
      }
    }
    // Reconnects (phones drop sockets constantly) refetch what we may have missed.
    socket.on("connect") { [weak self] _ in
      guard let self else { return }
      online = true
      socket.emit("active", visible)
      for i in pending.indices where pending[i].error == nil { pending[i].sending = true }
      Task { await self.drain() }
      Task {
        try? await self.load()
        for id in self.loaded { try? await self.fetchPage(id) }
      }
    }
    socket.onSignedOut = { [weak self] in self?.onSignedOut() }
    socket.onDrop = { [weak self] in self?.online = false }
    restore()
  }

  func start() {
    socket.connect()
    Task { try? await load() }
  }

  func setActive(_ visible: Bool) {
    self.visible = visible
    socket.emit("active", visible)
    guard visible else { return }
    socket.connect()
    if let activeId { markRead(activeId) }
  }

  // MARK: - loading

  @discardableResult
  func load(retried: Bool = false) async throws -> Me {
    let before = heard
    var m: Me
    do { m = try await api.call("GET", "/api/me") } catch let e as APIError where e.status == 401 {
      onSignedOut()
      throw e
    }
    // A message landed mid-fetch (a rename's sync, then its line): this answer may predate it and undo its bump.
    // Asked once more, not forever: a busy chat could otherwise keep this fetching.
    if heard != before, !retried { return try await load(retried: true) }
    // Left or removed: that chat's archive goes. A block or unblock changes what the server sends: all of it goes.
    let kept = Set(m.conversations.map(\.id)), held = Set(archive.keys).union(archiving.keys)
    dropArchive(m.blocked != me?.blocked ? held : held.subtracting(kept))
    m.conversations = m.conversations.map { c in
      var c = c
      if visible && c.id == activeId { c.unread = 0 }
      return c
    }
    me = m
    // Tell the server too, or the next push's badge counts what's on screen.
    if visible, let activeId { markRead(activeId) }
    Names.save(m.users, m.conversations)
    for c in m.conversations { if let last = c.lastMessage { merge(c.id, [decrypt(last)]) } }
    save()
    return m
  }

  func key(_ convId: String) async throws -> SymmetricKey { SymmetricKey(data: try await rawKey(convId)) }

  private func rawKey(_ convId: String) async throws -> Data {
    if let k = keys[convId] { return k }
    var m = me
    if m?.conversations.contains(where: { $0.id == convId }) != true { m = try await load() }
    guard let m, let conv = m.conversations.first(where: { $0.id == convId }),
          let wrapper = m.users.first(where: { $0.id == conv.wrappedBy }) else { throw APIError(status: 404, message: "Chat not found.") }
    let raw = try Crypto.unwrapConvKey(conv.wrappedKey, mine: account.privateKey, wrapperPub: wrapper.pubkey, convId: convId, myId: m.user.id)
    keys[convId] = raw
    return raw
  }

  private func decrypt(_ msg: Message) -> Decrypted {
    guard let raw = keys[msg.convId] ?? (try? keyNow(msg.convId)) else { return Decrypted(message: msg, content: nil) }
    return Self.decrypt(msg, raw)
  }

  // Every received body opens here, so screens can trust a card's link: the sender picks it, and only http(s) stays.
  nonisolated private static func decrypt(_ msg: Message, _ raw: Data) -> Decrypted {
    let key = SymmetricKey(data: raw)
    var body: MessageBody? = try? Crypto.openMessage(key, convId: msg.convId, msg.body)
    if body?.preview?.isWeb == false { body?.preview = nil }
    var d = Decrypted(message: msg, content: body)
    for r in msg.reactions ?? [] { d.reactions[r.userId] = emoji(key, msg, r) }
    return d
  }

  // Only if its sealed from/to match the row.
  nonisolated private static func emoji(_ key: SymmetricKey, _ msg: Message, _ r: Reaction) -> String? {
    guard let b: ReactionBody = try? Crypto.openMessage(key, convId: msg.convId, r.body), b.from == r.userId, b.to == msg.id,
          let e = b.emoji.first else { return nil }
    return String(e) // one character: it's someone else's text in our layout
  }

  // Synchronous unwrap when `me` already has the conversation.
  private func keyNow(_ convId: String) throws -> Data {
    guard let m = me, let conv = m.conversations.first(where: { $0.id == convId }),
          let wrapper = m.users.first(where: { $0.id == conv.wrappedBy }) else { throw APIError(status: 404, message: "") }
    let raw = try Crypto.unwrapConvKey(conv.wrappedKey, mine: account.privateKey, wrapperPub: wrapper.pubkey, convId: convId, myId: m.user.id)
    keys[convId] = raw
    return raw
  }

  private func merge(_ convId: String, _ list: [Decrypted]) {
    var byId = Dictionary((messages[convId] ?? []).map { ($0.id, $0) }) { $1 }
    for m in list { byId[m.id] = m }
    messages[convId] = byId.values.sorted { $0.id < $1.id }
  }

  func fetchPage(_ convId: String, before: Int? = nil) async throws {
    _ = try await rawKey(convId)
    let page: [Message] = try await api.call("GET", "/api/conversations/\(convId)/messages" + (before.map { "?before=\($0)" } ?? ""))
    // Cached rows in the newest page's range that it lacks were unsent while we were away.
    if before == nil { messages[convId]?.removeAll { $0.id >= (page.first?.id ?? 0) && $0.id <= (page.last?.id ?? .max) } }
    merge(convId, page.map(decrypt))
    if before != nil || !loaded.contains(convId) { hasOlder[convId] = page.count == Self.page }
    loaded.insert(convId)
    save()
  }

  func open(_ convId: String?) {
    activeId = convId
    guard let convId else { return }
    if !loaded.contains(convId) { Task { try? await fetchPage(convId) } }
    markRead(convId)
  }

  // The next page up: from the archive while it holds older rows (after a jump to a search hit), else the server.
  func loadOlder(_ convId: String) async {
    guard let first = messages[convId]?.first else { return }
    if let a = archive[convId], let i = a.firstIndex(where: { $0.id < first.id }) {
      return merge(convId, Array(a[i..<min(i + Self.page, a.count)]))
    }
    try? await fetchPage(convId, before: first.id)
  }

  private func receive(_ msg: Message) async {
    _ = try? await rawKey(msg.convId)
    let d = decrypt(msg)
    merge(msg.convId, [d])
    typing[msg.convId]?[msg.senderId] = nil
    let mine = msg.senderId == account.userId
    let answered = (d.content?.call?.ms ?? 0) > 0
    let seen = visible && activeId == msg.convId
    guard var m = me else { return }
    m.conversations = m.conversations.map { c in
      guard c.id == msg.convId else { return c }
      var c = c
      c.lastMessageAt = msg.createdAt
      c.lastMessage = msg
      if !mine && !seen && !answered && !d.system { c.unread += 1 } // event lines are sent `seen`: the server doesn't count them either
      return c
    }.sorted(by: Self.listed)
    me = m
    if seen { markRead(msg.convId) }
    save()
  }

  // Pinned first, then newest, as /api/me orders them.
  private static func listed(_ a: Conversation, _ b: Conversation) -> Bool {
    (a.pinned == true) != (b.pinned == true) ? a.pinned == true : (a.lastMessageAt ?? 0) > (b.lastMessageAt ?? 0)
  }

  // Opens only the new reaction; `message.reactions` stays current for the cache.
  private func setReaction(_ convId: String, _ messageId: Int, _ userId: String, _ body: String?) {
    guard let raw = keys[convId] ?? (try? keyNow(convId)) else { return }
    let r = body.map { Reaction(userId: userId, body: $0) }
    update(convId, messageId) { d in
      var d = d
      d.message.reactions = (d.message.reactions ?? []).filter { $0.userId != userId } + (r.map { [$0] } ?? [])
      d.reactions[userId] = r.flatMap { Self.emoji(SymmetricKey(data: raw), d.message, $0) }
      return d
    }
  }

  // An edit comes without reactions: each copy keeps the ones it holds and takes the new body.
  private func edited(_ msg: Message) {
    let new = decrypt(msg)
    update(msg.convId, msg.id) { old in
      var d = new
      d.message.reactions = old.message.reactions
      d.reactions = old.reactions
      return d
    }
  }

  // Changes a message we hold, in the chat and in the archive (nil drops it); one we don't hold arrives whole with its page.
  private func update(_ convId: String, _ id: Int, _ fn: (Decrypted) -> Decrypted?) {
    func apply(_ list: inout [Decrypted]) {
      guard let i = list.firstIndex(where: { $0.id == id }) else { return }
      if let d = fn(list[i]) { list[i] = d } else { list.remove(at: i) }
    }
    if archive[convId] != nil { apply(&archive[convId]!) }
    if messages[convId]?.contains(where: { $0.id == id }) == true { apply(&messages[convId]!) } // untouched otherwise, so the thread doesn't redraw
    save()
  }

  func markRead(_ convId: String) {
    let ids = [messages[convId]?.last?.id, me?.conversations.first(where: { $0.id == convId })?.lastMessage?.id]
    guard let last = ids.compactMap({ $0 }).max() else { return }
    Task { let _: OK? = try? await api.call("POST", "/api/conversations/\(convId)/read", ["upTo": last]) }
    if me?.conversations.first(where: { $0.id == convId })?.unread ?? 0 > 0 { updateConv(convId) { $0.unread = 0 } }
  }

  // One chat in `me`, changed in place, if it's there.
  private func updateConv(_ id: String, _ f: (inout Conversation) -> Void) {
    guard var m = me, let i = m.conversations.firstIndex(where: { $0.id == id }) else { return }
    f(&m.conversations[i])
    me = m
  }

  // MARK: - history archive (search, shared media)

  // A chat's messages, newest first: the archive, with the open chat's above and below it. Never a blocked
  // person's: a block or unblock empties the archive (`load`), so only the chat's rows need the check.
  func history(_ convId: String) -> [Decrypted] {
    let blocked = Set(me?.blocked ?? [])
    let now = (messages[convId] ?? []).filter { !blocked.contains($0.message.senderId) }
    guard let old = archive[convId], let hi = old.first?.id, let lo = old.last?.id else { return now.reversed() }
    return Array(now.filter { $0.id > hi }.reversed()) + old + now.filter { $0.id < lo }.reversed()
  }

  // Pages one chat back to its first message, `archivePage` at a time, once per session. The first page is the newest,
  // not the oldest we hold: the offline cache can skip messages that came while the app was closed.
  func backfill(_ convId: String) async {
    if complete.contains(convId) { return }
    if let t = archiving[convId] { return await t.value }
    let t = Task {
      do {
        let raw = try await rawKey(convId)
        while true {
          let page = try await Self.archived(api, convId, before: archive[convId]?.last?.id, raw)
          if Task.isCancelled { return } // dropped meanwhile (left the chat, a block)
          archive[convId, default: []].append(contentsOf: page)
          if page.count < Self.archivePage { complete.insert(convId) }
          bump()
          if page.count < Self.archivePage { break }
        }
      } catch {} // offline: the next search picks up from the oldest page we have
      if !Task.isCancelled { archiving[convId] = nil }
    }
    archiving[convId] = t
    await t.value
  }

  // One archive page, newest first, fetched, decoded and decrypted off the main thread.
  @concurrent nonisolated private static func archived(_ api: API, _ convId: String, before: Int?, _ raw: Data) async throws -> [Decrypted] {
    let page: [Message] = try await api.call("GET", "/api/conversations/\(convId)/messages?limit=\(archivePage)" + (before.map { "&before=\($0)" } ?? ""))
    return page.reversed().map { decrypt($0, raw) } // pages come oldest first
  }

  // Every chat, in list order, three at a time.
  func backfillAll() async {
    let ids = (me?.conversations ?? []).map(\.id).filter { !complete.contains($0) }
    await withTaskGroup(of: Void.self) { g in
      for (i, id) in ids.enumerated() {
        if i >= 3 { _ = await g.next() }
        if Task.isCancelled { break }
        g.addTask { await self.backfill(id) }
      }
    }
  }

  private func bump() {
    guard !bumping else { return }
    bumping = true
    Task {
      try? await Task.sleep(for: .milliseconds(400))
      bumping = false
      progress += 1
    }
  }

  private func dropArchive(_ ids: Set<String>) {
    for id in ids {
      archiving.removeValue(forKey: id)?.cancel()
      archive[id] = nil
      if complete.contains(id) { complete.remove(id) }
    }
  }

  // Opens a chat at an archived message: the archive from it to the newest joins the chat, so the thread can scroll there.
  func reveal(_ convId: String, _ id: Int) {
    guard let a = archive[convId], let i = a.firstIndex(where: { $0.id == id }) else { return }
    merge(convId, Array(a[...i]))
  }

  nonisolated struct Found: Identifiable {
    let m: Decrypted
    let line: String // the text line, file name or link title that matched
    var id: Int { m.id }
  }

  // Messages matching a query of 2+ characters, newest first, at most `maxFound`.
  func search(_ q: String) async -> [Found] {
    guard q.count >= 2 else { return [] }
    return await Self.scan((me?.conversations ?? []).map { history($0.id) }, q)
  }

  // Off the main thread: each chat newest first, up to the cap. The folded text narrows it; `Search.hit` finds the line.
  @concurrent nonisolated private static func scan(_ chats: [[Decrypted]], _ q: String) async -> [Found] {
    let folded = Search.fold(q)
    var out: [Found] = []
    for list in chats {
      var n = 0
      for d in list where d.folded.contains(folded) {
        guard let b = d.content, let line = Search.hit(b, q) else { continue }
        out.append(Found(m: d, line: line))
        n += 1
        if n == maxFound { break }
      }
    }
    return Array(out.sorted { $0.id > $1.id }.prefix(maxFound))
  }

  // MARK: - offline cache

  // What the server last sent, still sealed, so chats open with no network.
  // Bodies are decrypted only in memory, like everything else here.
  private struct Snapshot: Codable {
    let me: Me
    let messages: [String: [Message]]
    let pending: [Pending]? // absent in caches from before the outbox
  }

  private var cacheURL: URL {
    URL.applicationSupportDirectory.appending(path: "cache-\(account.userId).json")
  }

  private func restore() {
    guard let data = try? Data(contentsOf: cacheURL), let snap = try? JSONDecoder().decode(Snapshot.self, from: data) else { return }
    me = snap.me
    for (convId, list) in snap.messages { merge(convId, list.map(decrypt)) }
    // Shown as failed until the socket is up and resends them, so nothing spins with no network.
    pending = (snap.pending ?? []).map { var p = $0; p.sending = false; return p }
  }

  // Coalesced: a burst of messages writes once. `now` for what mustn't be lost
  // if the app is killed in the next second (a message just queued).
  private func save(now: Bool = false) {
    saving?.cancel()
    if now { return write() }
    saving = Task {
      try? await Task.sleep(for: .seconds(1))
      if !Task.isCancelled { write() }
    }
  }

  private func write() {
    guard let me, !forgotten else { return }
    let snap = Snapshot(me: me, messages: messages.mapValues { $0.suffix(Self.page).map(\.message) }, pending: pending)
    let url = cacheURL
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    // Readable after first unlock, so a call push in a locked pocket still finds names and keys.
    try? JSONEncoder().encode(snap).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  // On sign-out: the next account on this phone mustn't see this one's chats.
  func forget() {
    forgotten = true
    saving?.cancel()
    try? FileManager.default.removeItem(at: cacheURL)
    try? FileManager.default.removeItem(at: Self.savedDir)
  }

  // MARK: - sending

  // Sealed, saved, then sent; returns once queued. A failure shows on the pending row.
  func send(_ convId: String, text: String? = nil, files refs: [FileRef]? = nil, call: CallLog? = nil, reply: Reply? = nil, forwarded: Bool? = nil,
            preview: LinkPreview? = nil, system: Bool? = nil, quiet: Bool = false, seen: Bool = false) async throws {
    let sealed = try await seal(convId, MessageBody(from: account.userId, text: text, files: refs, call: call, reply: reply, forwarded: forwarded, system: system, preview: preview))
    let p = Pending(cid: UUID().uuidString.lowercased(), convId: convId, body: sealed, createdAt: Date().timeIntervalSince1970 * 1000, quiet: quiet, seen: seen, sending: socket.connected)
    pending.append(p)
    save(now: true)
    Task { await drain() }
  }

  // Every message body goes out through here (send, edit, forward): its card only while the text still holds its link.
  private func seal(_ convId: String, _ body: MessageBody) async throws -> String {
    var body = body
    if let p = body.preview, !p.fits(body.text ?? "") { body.preview = nil }
    return try await sealed(convId, body)
  }

  // The server's limit; thrown here, so the draft comes back instead of a row that can never send.
  private func sealed(_ convId: String, _ plain: some Encodable) async throws -> String {
    let out = try Crypto.sealMessage(try await key(convId), convId: convId, plain)
    guard out.count <= 64 * 1024 else { throw APIError(status: 0, message: "That message is too long to send.") }
    return out
  }

  // One at a time, oldest first, so messages land in the order they were written.
  private func drain() async {
    guard !draining else { return }
    draining = true
    struct Ack: Decodable { let message: Message?; let error: String? }
    while socket.connected, let p = pending.first(where: { $0.error == nil }) {
      do {
        let r = try await socket.ack("send", ["convId": p.convId, "body": p.body, "quiet": p.quiet, "seen": p.seen, "cid": p.cid])
        let ack = try? JSONDecoder().decode(Ack.self, from: r)
        if let msg = ack?.message {
          pending.removeAll { $0.cid == p.cid }
          merge(msg.convId, [decrypt(msg)])
        } else if let i = pending.firstIndex(where: { $0.cid == p.cid }) {
          pending[i].sending = false
          pending[i].error = ack?.error ?? "Couldn’t send."
        }
        save()
      } catch {
        // No answer in time, or the link dropped. Online, the loop resends it; the cid stores it once.
      }
    }
    for i in pending.indices where pending[i].error == nil { pending[i].sending = false }
    draining = false
  }

  // MARK: - message actions

  // Picking your own emoji again takes it back; another one replaces it.
  func react(_ d: Decrypted, _ emoji: String) async throws {
    let id = d.message.id, convId = d.message.convId
    if d.reactions[account.userId] == emoji {
      let _: OK = try await api.call("DELETE", "/api/messages/\(id)/reaction")
      setReaction(convId, id, account.userId, nil)
    } else {
      let body = try await sealed(convId, ReactionBody(from: account.userId, to: id, emoji: emoji))
      let _: OK = try await api.call("PUT", "/api/messages/\(id)/reaction", ["body": body])
      setReaction(convId, id, account.userId, body)
    }
  }

  // New text, same everything else (files, reply, forwarded). The server allows 15 minutes.
  func edit(_ d: Decrypted, text: String) async throws {
    guard var body = d.content else { return }
    body.text = text
    let sealed = try await seal(d.message.convId, body)
    struct Edited: Decodable { let message: Message }
    let r: Edited = try await api.call("PATCH", "/api/messages/\(d.message.id)", ["body": sealed])
    edited(r.message)
  }

  func unsend(_ d: Decrypted) async throws {
    let _: OK = try await api.call("DELETE", "/api/messages/\(d.message.id)")
    update(d.message.convId, d.message.id) { _ in nil }
  }

  // Files are fetched, decrypted and sealed again with the other chat's key.
  func forward(_ d: Decrypted, to convId: String) async throws {
    guard let c = d.content else { return }
    let from = d.message.convId
    var refs: [FileRef] = []
    for f in c.files ?? [] {
      let data = f.size > Self.inMemory && f.voice == nil ? try Data(contentsOf: try await save(from, f)) : try await file(from, f)
      refs.append(try await upload(convId, data, name: f.name, type: f.type, voice: f.voice))
    }
    try await send(convId, text: c.text, files: refs.isEmpty ? nil : refs, forwarded: true, preview: c.preview)
  }

  // At most every 3 s; the others drop it 6 s after the last one.
  func sendTyping(_ convId: String) {
    guard Date().timeIntervalSince(typedAt[convId] ?? .distantPast) >= 3 else { return }
    typedAt[convId] = Date()
    socket.emit("typing", ["convId": convId])
  }

  func typers(_ convId: String) -> [String] { (typing[convId] ?? [:]).keys.sorted { name($0) < name($1) } }

  func retry(_ p: Pending) {
    guard let i = pending.firstIndex(where: { $0.cid == p.cid }) else { return }
    pending[i].error = nil
    pending[i].sending = socket.connected
    Task { await drain() }
  }

  func discard(_ p: Pending) {
    pending.removeAll { $0.cid == p.cid }
    save(now: true)
  }

  // A pending message as a row, decrypted in memory like the rest.
  func shown(_ p: Pending) -> Decrypted {
    decrypt(Message(id: 0, convId: p.convId, senderId: account.userId, body: p.body, createdAt: p.createdAt))
  }

  static let maxFile = 50 * 1024 * 1024

  func upload(_ convId: String, _ data: Data, name: String, type: String, voice: Voice? = nil) async throws -> FileRef {
    guard data.count <= Self.maxFile else { throw APIError(status: 0, message: "\(name) is over 50 MB") }
    let sealed = try Crypto.sealFile(try await key(convId), convId: convId, data)
    let (res, _) = try await api.data("POST", "/api/conversations/\(convId)/attachments", body: sealed, type: "application/octet-stream")
    let id = try JSONDecoder().decode(Created.self, from: res).id
    if data.count > Self.inMemory { _ = try? keep(id, name, data) } else { files[id] = data }
    return FileRef(id: id, name: name, type: type, size: data.count, voice: voice)
  }

  // Decrypted attachment bytes, fetched once per session.
  func file(_ convId: String, _ ref: FileRef) async throws -> Data {
    if let d = files[ref.id] { return d }
    let plain = try await download(convId, ref)
    files[ref.id] = plain
    return plain
  }

  // A shared-media square: decrypted and shrunk without keeping the photo, unlike `file`; a few dozen stay cached.
  func thumb(_ convId: String, _ ref: FileRef) async throws -> UIImage? {
    if let t = thumbs.object(forKey: ref.id as NSString) { return t }
    let data = if let d = files[ref.id] { d } else { try await download(convId, ref) }
    guard let t = await Attachment.downsample(CGImageSourceCreateWithData(data as CFData, nil), max: 360) else { return nil }
    thumbs.setObject(t, forKey: ref.id as NSString, cost: t.cgImage.map { $0.bytesPerRow * $0.height } ?? 0)
    return t
  }

  private func download(_ convId: String, _ ref: FileRef) async throws -> Data {
    let (sealed, _) = try await api.data("GET", "/api/attachments/\(ref.id)")
    return try Crypto.openFile(try await key(convId), convId: convId, sealed)
  }

  // Bigger attachments load on a tap and stay on disk, not in memory.
  static let inMemory = 25 * 1024 * 1024
  nonisolated static let savedDir = URL.temporaryDirectory.appending(path: "attachments")

  // Decrypted to a temp file named like the original, fetched once per session.
  func save(_ convId: String, _ ref: FileRef) async throws -> URL {
    if let u = saved[ref.id] { return u }
    if let t = fetching[ref.id] { return try await t.value }
    let t = Task {
      defer { fetching[ref.id] = nil }
      return try keep(ref.id, ref.name, try await download(convId, ref))
    }
    fetching[ref.id] = t
    return try await t.value
  }

  private func keep(_ id: String, _ name: String, _ data: Data) throws -> URL {
    guard !forgotten else { throw CancellationError() } // signed out: no plaintext after forget()
    let url = Self.savedDir.appending(path: "\(UUID().uuidString)/\(diskName(name))")
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    // Like the cache: a download that ends after the screen locks can still write.
    try data.write(to: url, options: .completeFileProtectionUntilFirstUserAuthentication)
    saved[id] = url
    return url
  }

  // MARK: - people and chats

  func user(_ id: String) -> User? { me?.users.first { $0.id == id } }
  func name(_ id: String) -> String { user(id)?.name ?? "Someone" }
  func who(_ id: String) -> String { id == account.userId ? "You" : name(id) }

  func title(_ c: Conversation) -> String {
    c.title ?? name(c.members.first { $0 != account.userId } ?? account.userId)
  }

  func peer(_ c: Conversation) -> String? { c.kind == "dm" ? c.members.first { $0 != account.userId } : nil }

  // One user id makes (or reuses) a DM; more make a group.
  func createConversation(_ userIds: [String], title: String? = nil) async throws -> String {
    guard let m = me else { throw APIError(status: 0, message: "Still loading.") }
    if userIds.count == 1, let existing = m.conversations.first(where: { $0.kind == "dm" && $0.members.contains(userIds[0]) }) {
      return existing.id
    }
    let id = UUID().uuidString.lowercased()
    let raw = Crypto.newConvKey()
    let members: [[String: Any]] = try ([m.user.id] + userIds).map { uid in
      let pub = m.users.first { $0.id == uid }!.pubkey
      return ["userId": uid, "wrappedKey": try Crypto.wrapConvKey(raw, mine: account.privateKey, theirPub: pub, convId: id, theirId: uid)]
    }
    let kind = userIds.count == 1 ? "dm" : "group"
    var body: [String: Any] = ["id": id, "kind": kind, "members": members]
    if kind == "group" { body["title"] = title }
    let _: OK = try await api.call("POST", "/api/conversations", body)
    try await load()
    return id
  }

  // Mine alone. The server syncs too; this just shows it at once.
  func setMine(_ convId: String, muted: Bool? = nil, pinned: Bool? = nil) async throws {
    var body: [String: Any] = [:]
    body["muted"] = muted
    body["pinned"] = pinned
    let _: OK = try await api.call("PATCH", "/api/conversations/\(convId)/me", body)
    updateConv(convId) {
      if let muted { $0.muted = muted }
      if let pinned { $0.pinned = pinned }
    }
    if pinned != nil { me?.conversations.sort(by: Self.listed) }
  }

  // The server syncs everyone in the chat, us too, so none of these reload here.
  func rename(_ convId: String, _ title: String) async throws {
    let _: OK = try await api.call("PATCH", "/api/conversations/\(convId)", ["title": title])
    await announce(convId, "\(account.name) named the group “\(title)”")
  }

  // Each person gets the chat key wrapped for them, as createConversation does.
  func add(_ convId: String, _ userIds: [String]) async throws {
    let raw = try await rawKey(convId)
    for uid in userIds {
      guard let pub = user(uid)?.pubkey else { continue }
      let wrapped = try Crypto.wrapConvKey(raw, mine: account.privateKey, theirPub: pub, convId: convId, theirId: uid)
      let _: OK = try await api.call("POST", "/api/conversations/\(convId)/members", ["userId": uid, "wrappedKey": wrapped])
    }
    await announce(convId, "\(account.name) added \(ListFormatter.localizedString(byJoining: userIds.map(name)))")
  }

  // Your own id leaves the group.
  func remove(_ convId: String, _ userId: String) async throws {
    guard userId != account.userId else { return try await leave(convId) }
    let _: OK = try await api.call("DELETE", "/api/conversations/\(convId)/members/\(userId)")
    await announce(convId, "\(account.name) removed \(name(userId))")
  }

  // A group event line, through the outbox like any message, so it keeps its order and retries.
  private func announce(_ convId: String, _ text: String) async {
    try? await send(convId, text: text, system: true, quiet: true, seen: true)
  }

  // "left" goes straight over the socket, not the outbox: it must land before the DELETE, after which we can't send.
  // Best effort: offline, we still leave, just without the line.
  private func leave(_ convId: String) async throws {
    struct Ack: Decodable { let message: Message? }
    do {
      let sealed = try await seal(convId, MessageBody(from: account.userId, text: "\(account.name) left", system: true))
      let r = try await socket.ack("send", ["convId": convId, "body": sealed, "quiet": true, "seen": true, "cid": UUID().uuidString.lowercased()])
      if let msg = try JSONDecoder().decode(Ack.self, from: r).message { merge(convId, [decrypt(msg)]) }
    } catch {}
    let _: OK = try await api.call("DELETE", "/api/conversations/\(convId)/members/\(account.userId)")
  }

  func invite() async throws -> URL {

    let (data, _) = try await api.data("POST", "/api/invites")
    struct Invite: Decodable { let code: String }
    let code = try JSONDecoder().decode(Invite.self, from: data).code
    var c = URLComponents(url: account.server, resolvingAgainstBaseURL: false)!
    c.path = "/"
    c.queryItems = [.init(name: "invite", value: code)]
    return c.url!
  }

  func isBlocked(_ userId: String) -> Bool { me?.blocked?.contains(userId) == true }

  func block(_ userId: String, _ on: Bool) async throws {
    let _: OK = try await api.call(on ? "PUT" : "DELETE", "/api/blocks/\(userId)")
    try await load()
  }

  func report(_ userId: String, convId: String?, note: String) async throws {
    var body: [String: Any] = ["userId": userId]
    if let convId { body["convId"] = convId }
    if !note.isEmpty { body["note"] = note }
    let _: OK = try await api.call("POST", "/api/reports", body)
    try await load()
  }

  func registerDevice(token: Data, kind: String) {
    let hex = token.map { String(format: "%02x", $0) }.joined()
    #if DEBUG
    let env = "sandbox"
    #else
    let env = "production"
    #endif
    UserDefaults.standard.set(hex, forKey: "token.\(kind)")
    // v: 2 knows group calls, so the server rings this phone for them.
    Task { let _: OK? = try? await api.call("POST", "/api/devices", ["token": hex, "kind": kind, "env": env, "v": 2]) }
  }

  func signOut() async {
    for kind in ["alert", "voip"] {
      if let t = UserDefaults.standard.string(forKey: "token.\(kind)") { let _: OK? = try? await api.call("DELETE", "/api/devices/\(t)") }
    }
    let _: OK? = try? await api.call("POST", "/api/logout")
    socket.disconnect()
    onSignedOut()
  }

  // Asks for the passphrase again: deletion can't be undone.
  func deleteAccount(passphrase: String) async throws {
    let name = account.name
    let ident = await Task.detached { Crypto.deriveIdentity(name: name, passphrase: passphrase) }.value
    let _: OK = try await api.call("DELETE", "/api/me", ["auth": ident.auth])
    socket.disconnect()
    onSignedOut()
  }
}

// Names by user id, and group titles by chat id, for CallKit, which must show a caller the instant a push lands.
enum Names {
  static func save(_ users: [User], _ convs: [Conversation]) {
    var names = Dictionary(users.map { ($0.id, $0.name) }) { $1 }
    for c in convs where c.kind == "group" { names[c.id] = c.title }
    UserDefaults.standard.set(names, forKey: "names")
  }
  static func of(_ id: String) -> String? { (UserDefaults.standard.dictionary(forKey: "names") as? [String: String])?[id] }
}
