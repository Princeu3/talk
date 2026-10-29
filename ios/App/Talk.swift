import CryptoKit
import Foundation
import Observation

struct Decrypted: Identifiable, Hashable {
  let message: Message
  let content: MessageBody? // nil: could not decrypt
  var id: Int { message.id }
  var forged: Bool { content.map { $0.from != message.senderId } ?? false }
}

// All signed-in state and actions, like src/lib/useTalk.ts on the web.
@Observable
final class Talk {
  let account: Account
  private(set) var me: Me?
  private(set) var messages: [String: [Decrypted]] = [:]
  private(set) var hasOlder: [String: Bool] = [:]
  var activeId: String?
  var onSignedOut: () -> Void = {}

  @ObservationIgnored let socket: Socket
  @ObservationIgnored private var keys: [String: Data] = [:]
  @ObservationIgnored private var loaded = Set<String>()
  @ObservationIgnored private var files: [String: Data] = [:]
  private static let page = 50

  var api: API { account.api }
  var totalUnread: Int { me?.conversations.reduce(0) { $0 + $1.unread } ?? 0 }

  init(account: Account) {
    self.account = account
    socket = Socket(account: account)
    socket.on("message") { [weak self] data in
      guard let self, let msg = try? JSONDecoder().decode(Message.self, from: data) else { return }
      Task { await self.receive(msg) }
    }
    socket.on("sync") { [weak self] _ in Task { try? await self?.load() } }
    // Reconnects (phones drop sockets constantly) refetch what we may have missed.
    socket.on("connect") { [weak self] _ in
      guard let self else { return }
      socket.emit("active", true)
      Task {
        try? await self.load()
        for id in self.loaded { try? await self.fetchPage(id) }
      }
    }
    socket.onSignedOut = { [weak self] in self?.onSignedOut() }
  }

  func start() {
    socket.connect()
    Task { try? await load() }
  }

  func setActive(_ visible: Bool) {
    if visible { socket.connect() }
    socket.emit("active", visible)
  }

  // MARK: - loading

  @discardableResult
  func load() async throws -> Me {
    do {
      var m: Me = try await api.call("GET", "/api/me")
      m.conversations = m.conversations.map { c in
        var c = c
        if c.id == activeId { c.unread = 0 }
        return c
      }
      me = m
      Names.save(m.users)
      for c in m.conversations { if let last = c.lastMessage { merge(c.id, [decrypt(last)]) } }
      return m
    } catch let e as APIError where e.status == 401 {
      onSignedOut()
      throw e
    }
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
    return Decrypted(message: msg, content: try? Crypto.openMessage(SymmetricKey(data: raw), convId: msg.convId, msg.body))
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
    merge(convId, page.map(decrypt))
    if before != nil || !loaded.contains(convId) { hasOlder[convId] = page.count == Self.page }
    loaded.insert(convId)
  }

  func open(_ convId: String?) {
    activeId = convId
    guard let convId else { return }
    if !loaded.contains(convId) { Task { try? await fetchPage(convId) } }
    markRead(convId)
  }

  func loadOlder(_ convId: String) async {
    if let first = messages[convId]?.first { try? await fetchPage(convId, before: first.id) }
  }

  private func receive(_ msg: Message) async {
    _ = try? await rawKey(msg.convId)
    merge(msg.convId, [decrypt(msg)])
    let mine = msg.senderId == account.userId
    let seen = activeId == msg.convId
    guard var m = me else { return }
    m.conversations = m.conversations.map { c in
      guard c.id == msg.convId else { return c }
      var c = c
      c.lastMessageAt = msg.createdAt
      c.lastMessage = msg
      if !mine && !seen { c.unread += 1 }
      return c
    }.sorted { ($0.lastMessageAt ?? 0) > ($1.lastMessageAt ?? 0) }
    me = m
    if seen { markRead(msg.convId) }
  }

  func markRead(_ convId: String) {
    guard let last = messages[convId]?.last?.id ?? me?.conversations.first(where: { $0.id == convId })?.lastMessage?.id else { return }
    Task { let _: OK? = try? await api.call("POST", "/api/conversations/\(convId)/read", ["upTo": last]) }
    if var m = me, let i = m.conversations.firstIndex(where: { $0.id == convId }), m.conversations[i].unread > 0 {
      m.conversations[i].unread = 0
      me = m
    }
  }

  // MARK: - sending

  func send(_ convId: String, text: String? = nil, files refs: [FileRef]? = nil, call: CallLog? = nil, quiet: Bool = false) async throws {
    let body = MessageBody(from: account.userId, text: text, files: refs, call: call)
    let sealed = try Crypto.sealMessage(try await key(convId), convId: convId, body)
    let r = try await socket.ack("send", ["convId": convId, "body": sealed, "quiet": quiet])
    if let err = (try? JSONSerialization.jsonObject(with: r) as? [String: Any])?["error"] as? String {
      throw APIError(status: 0, message: err)
    }
  }

  static let maxFile = 50 * 1024 * 1024

  func upload(_ convId: String, _ data: Data, name: String, type: String, voice: Voice? = nil) async throws -> FileRef {
    guard data.count <= Self.maxFile else { throw APIError(status: 0, message: "\(name) is over 50 MB") }
    let sealed = try Crypto.sealFile(try await key(convId), convId: convId, data)
    let (res, _) = try await api.data("POST", "/api/conversations/\(convId)/attachments", body: sealed, type: "application/octet-stream")
    let id = try JSONDecoder().decode(Created.self, from: res).id
    files[id] = data
    return FileRef(id: id, name: name, type: type, size: data.count, voice: voice)
  }

  // Decrypted attachment bytes, fetched once per session.
  func file(_ convId: String, _ ref: FileRef) async throws -> Data {
    if let d = files[ref.id] { return d }
    let (sealed, _) = try await api.data("GET", "/api/attachments/\(ref.id)")
    let plain = try Crypto.openFile(try await key(convId), convId: convId, sealed)
    files[ref.id] = plain
    return plain
  }

  // MARK: - people and chats

  func user(_ id: String) -> User? { me?.users.first { $0.id == id } }
  func name(_ id: String) -> String { user(id)?.name ?? "Someone" }

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
    Task { let _: OK? = try? await api.call("POST", "/api/devices", ["token": hex, "kind": kind, "env": env]) }
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

// Names by user id, for CallKit, which must show a caller the instant a push lands.
enum Names {
  static func save(_ users: [User]) {
    UserDefaults.standard.set(Dictionary(users.map { ($0.id, $0.name) }) { $1 }, forKey: "names")
  }
  static func of(_ id: String) -> String? { (UserDefaults.standard.dictionary(forKey: "names") as? [String: String])?[id] }
}
