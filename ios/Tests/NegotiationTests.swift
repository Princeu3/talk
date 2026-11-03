import Foundation
import Testing
import WebRTC

// Every call starts in glare: caller and callee both add their tracks, so both
// offer. The callee must drop its own offer and answer the caller's, or the
// call never connects (iPhone to iPhone calls hung at "Connecting…" this way).
@MainActor
struct NegotiationTests {
  let factory: RTCPeerConnectionFactory = {
    RTCInitializeSSL()
    return RTCPeerConnectionFactory()
  }()

  func peer(_ config: RTCConfiguration) -> RTCPeerConnection {
    let pc = factory.peerConnection(with: config, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: nil)!
    // A transceiver stands in for the tracks; an audio track would start the
    // Simulator's audio hardware, which can hang a test process.
    pc.addTransceiver(of: .video)
    return pc
  }

  func wait(_ op: (@escaping @Sendable (Error?) -> Void) -> Void) async throws {
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
      op { e in if let e { c.resume(throwing: e) } else { c.resume() } }
    }
  }

  // Both offer; the callee then gets the caller's offer while holding its own.
  func glare(_ config: RTCConfiguration) async throws -> RTCPeerConnection {
    let caller = peer(config), callee = peer(config)
    try await wait { caller.setLocalDescriptionWithCompletionHandler($0) }
    try await wait { callee.setLocalDescriptionWithCompletionHandler($0) }
    #expect(callee.signalingState == .haveLocalOffer)
    let offer = caller.localDescription!
    try await wait { callee.setRemoteDescription(offer, completionHandler: $0) }
    try await wait { callee.setLocalDescriptionWithCompletionHandler($0) }
    return callee
  }

  @Test func calleeAnswersTheCallersOfferOverItsOwn() async throws {
    let callee = try await glare(.talk([]))
    #expect(callee.localDescription?.type == .answer)
    #expect(callee.signalingState == .stable)
  }

  @Test func withoutImplicitRollbackTheCalleeRefuses() async throws {
    let config = RTCConfiguration.talk([])
    config.enableImplicitRollback = false
    await #expect(throws: (any Error).self) { _ = try await glare(config) }
  }
}

// Group calls: one polite side per pair, and tiles that fit the screen.
struct GroupCallTests {
  @Test func exactlyOneSideOfEachPairYields() {
    // DM: the callee yields, the caller doesn't.
    #expect(isPolite(group: false, outgoing: false, joinedAfterThem: false))
    #expect(!isPolite(group: false, outgoing: true, joinedAfterThem: false))
    // Group: the joiner yields to whoever its ack listed; they hear call:joined and don't.
    // Whether either side placed its call through CallKit (outgoing) doesn't matter.
    for joinerOutgoing in [true, false] {
      for theirOutgoing in [true, false] {
        let joiner = isPolite(group: true, outgoing: joinerOutgoing, joinedAfterThem: true)
        let earlier = isPolite(group: true, outgoing: theirOutgoing, joinedAfterThem: false)
        #expect(joiner && !earlier)
      }
    }
  }

  func grid(_ n: Int) -> String {
    let g = callGrid(n)
    return "\(g.columns)x\(g.rows)" + (g.scrolls ? " scrolls" : "")
  }

  @Test func tilesForEachCallSize() {
    #expect(grid(0) == "1x1") // waiting for others
    #expect(grid(1) == "1x1") // as in a DM: they fill the screen
    #expect(grid(2) == "1x2") // stacked
    #expect(grid(3) == "2x2")
    #expect(grid(4) == "2x2")
    for n in 5...7 { #expect(grid(n) == "2x3 scrolls") } // a full call is 8, so 7 others
  }

  @Test func videoShrinksAsTheCallGrows() {
    // docs/chat-features.md, "Group call video"
    #expect(videoCap(1) == (1_500_000, 1, 30))
    #expect(videoCap(2) == (900_000, 1, 30))
    #expect(videoCap(3) == (600_000, 1.5, 30))
    #expect(videoCap(4) == (400_000, 2, 24) && videoCap(5) == (400_000, 2, 24))
    #expect(videoCap(6) == (250_000, 2.5, 15) && videoCap(7) == (250_000, 2.5, 15))
  }
}
