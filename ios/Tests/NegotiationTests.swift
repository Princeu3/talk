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
