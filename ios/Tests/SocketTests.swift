import Foundation
import Network
import Testing

// The iPhone app's Socket.IO client against a fake server that records each frame it gets.
@MainActor
struct SocketTests {
  // At launch the app emits "active" while its socket is still connecting. Socket.IO closes any
  // connection whose first event comes before the client's "40", so every launch lost its first socket.
  @Test func sendsNoEventBeforeTheServerConnectsIt() async throws {
    let (server, socket) = try await pair()
    defer { server.stop(); socket.disconnect() }

    socket.connect()
    socket.emit("active", true) // what setActive does at launch, mid-handshake
    try #require(await until { server.frames.contains("40") })
    server.send(#"40{"sid":"a"}"#)
    try #require(await until { socket.connected })
    socket.emit("active", false)
    await until { server.frames.last?.hasPrefix("42") == true }
    #expect(server.frames == ["40", #"42["active",false]"#])
  }

  private func pair() async throws -> (FakeIO, Socket) {
    let server = try FakeIO()
    try #require(await until { server.port > 0 })
    return (server, Socket(account: Account(server: URL(string: "http://127.0.0.1:\(server.port)")!, userId: "u", name: "U", cookie: "", key: Data())))
  }

  @discardableResult
  private func until(_ done: () -> Bool) async -> Bool {
    for _ in 0..<500 where !done() { try? await Task.sleep(for: .milliseconds(10)) }
    return done()
  }
}

// Stands in for the Socket.IO server: opens with Engine.IO's "0", records each frame the
// client sends, and answers "40" only when the test says so.
@MainActor
final class FakeIO {
  private let listener: NWListener
  private var conn: NWConnection?
  private(set) var frames: [String] = []
  var port: UInt16 { listener.port?.rawValue ?? 0 } // 0 until the listener is ready

  init() throws {
    let params = NWParameters.tcp
    params.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(), at: 0)
    listener = try NWListener(using: params)
    listener.newConnectionHandler = { [weak self] c in
      MainActor.assumeIsolated { self?.accept(c) }
    }
    listener.start(queue: .main)
  }

  func send(_ s: String) {
    let text = NWConnection.ContentContext(identifier: "text", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
    conn?.send(content: Data(s.utf8), contentContext: text, isComplete: true, completion: .idempotent)
  }

  func stop() {
    conn?.cancel()
    listener.cancel()
  }

  private func accept(_ c: NWConnection) {
    conn = c
    c.stateUpdateHandler = { [weak self] state in
      guard case .ready = state else { return }
      MainActor.assumeIsolated { self?.send(#"0{"sid":"s","upgrades":[],"pingInterval":25000,"pingTimeout":20000}"#) }
    }
    c.start(queue: .main)
    receive(c)
  }

  private func receive(_ c: NWConnection) {
    c.receiveMessage { [weak self] data, _, _, error in
      MainActor.assumeIsolated {
        if let data { self?.frames.append(String(decoding: data, as: UTF8.self)) }
        if error == nil { self?.receive(c) }
      }
    }
  }
}
