import Foundation

// A small Socket.IO v5 client (Engine.IO 4, websocket only), enough for
// Talk: events both ways and acks for what we emit. socket.io-client-swift
// is barely maintained, and the protocol is a handful of prefixes:
// 0 open, 2/3 ping/pong, 40 connected, 44 refused, 42 event, 43 ack.
final class Socket {
  var onSignedOut: () -> Void = {}
  private(set) var connected = false

  private let url: URL
  private let cookie: String
  private var task: URLSessionWebSocketTask?
  private var handlers: [String: [(Data) -> Void]] = [:]
  private var acks: [Int: CheckedContinuation<Data, Error>] = [:]
  private var nextAck = 0
  private var wanted = false
  private var retries = 0
  private var lastHeard = Date()
  private var watchdog: Task<Void, Never>?

  init(account: Account) {
    var c = URLComponents(url: account.server, resolvingAgainstBaseURL: false)!
    c.scheme = c.scheme == "http" ? "ws" : "wss"
    c.path = "/socket.io/"
    c.queryItems = [.init(name: "EIO", value: "4"), .init(name: "transport", value: "websocket")]
    url = c.url!
    cookie = account.cookie
  }

  // "connect" fires on every (re)connect, with no data.
  func on(_ event: String, _ fn: @escaping (Data) -> Void) { handlers[event, default: []].append(fn) }

  func connect() {
    wanted = true
    guard task == nil else { return }
    var req = URLRequest(url: url)
    req.setValue(cookie, forHTTPHeaderField: "Cookie")
    let t = URLSession.shared.webSocketTask(with: req)
    task = t
    t.resume()
    receive(t)
  }

  func disconnect() {
    wanted = false
    drop()
  }

  func emit(_ event: String, _ data: Any) { send("42", event, data) }

  // Emits and waits for the server's ack, as JSON of its first argument.
  func ack(_ event: String, _ data: Any, timeout: Double = 15) async throws -> Data {
    guard connected else { throw APIError(status: 0, message: "Not connected. Check your connection.") }
    nextAck += 1
    let id = nextAck
    return try await withCheckedThrowingContinuation { cont in
      acks[id] = cont
      send("42\(id)", event, data)
      Task {
        try? await Task.sleep(for: .seconds(timeout))
        acks.removeValue(forKey: id)?.resume(throwing: APIError(status: 0, message: "The server didn't answer."))
      }
    }
  }

  private func send(_ prefix: String, _ event: String, _ data: Any) {
    guard let json = try? JSONSerialization.data(withJSONObject: [event, data]) else { return }
    write(prefix + String(decoding: json, as: UTF8.self))
  }

  private func write(_ s: String) { task?.send(.string(s)) { _ in } }

  private func receive(_ t: URLSessionWebSocketTask) {
    t.receive { [weak self] result in
      Task { @MainActor in
        guard let self, self.task === t else { return }
        switch result {
        case .success(.string(let s)):
          self.handle(s)
          self.receive(t)
        case .success:
          self.receive(t)
        case .failure:
          self.drop()
          self.retry()
        }
      }
    }
  }

  private func handle(_ s: String) {
    lastHeard = Date()
    if s == "2" { return write("3") }
    if s.hasPrefix("0") {
      let open = (try? JSONSerialization.jsonObject(with: Data(s.dropFirst().utf8))) as? [String: Any]
      let limit = ((open?["pingInterval"] as? Double) ?? 25_000) + ((open?["pingTimeout"] as? Double) ?? 20_000)
      watch(limit / 1000)
      return write("40")
    }
    if s.hasPrefix("40") {
      connected = true
      retries = 0
      for fn in handlers["connect"] ?? [] { fn(Data()) }
      return
    }
    if s.hasPrefix("44") {
      if s.contains("signed out") { wanted = false; onSignedOut() }
      return drop()
    }
    if s.hasPrefix("43") {
      let rest = s.dropFirst(2)
      let digits = rest.prefix { $0.isNumber }
      guard let id = Int(digits), let args = parse(rest.dropFirst(digits.count)) else { return }
      acks.removeValue(forKey: id)?.resume(returning: args.first ?? Data("null".utf8))
      return
    }
    if s.hasPrefix("42"), let args = parse(s.dropFirst(2)), let name = args.first.flatMap({ try? JSONDecoder().decode(String.self, from: $0) }) {
      let payload = args.count > 1 ? args[1] : Data("null".utf8)
      for fn in handlers[name] ?? [] { fn(payload) }
    }
  }

  // A JSON array, as one JSON blob per element.
  private func parse(_ s: Substring) -> [Data]? {
    guard let arr = (try? JSONSerialization.jsonObject(with: Data(s.utf8), options: .fragmentsAllowed)) as? [Any] else { return nil }
    return arr.map { (try? JSONSerialization.data(withJSONObject: $0, options: .fragmentsAllowed)) ?? Data("null".utf8) }
  }

  // The server pings every pingInterval; silence past interval + timeout means the link is dead.
  private func watch(_ limit: Double) {
    watchdog?.cancel()
    watchdog = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(5))
        guard let self, self.task != nil else { return }
        if Date().timeIntervalSince(self.lastHeard) > limit {
          self.drop()
          self.retry()
          return
        }
      }
    }
  }

  private func drop() {
    watchdog?.cancel()
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    connected = false
    for (_, c) in acks { c.resume(throwing: APIError(status: 0, message: "Connection lost.")) }
    acks = [:]
  }

  private func retry() {
    guard wanted else { return }
    retries += 1
    let delay = min(15, pow(2, Double(min(retries, 4))) / 2)
    Task {
      try? await Task.sleep(for: .seconds(delay))
      if wanted { connect() }
    }
  }
}
