import WebRTC

extension RTCConfiguration {
  // One place for how every call's peer connection is set up, so the tests use it too.
  static func talk(_ servers: [RTCIceServer]) -> RTCConfiguration {
    let config = RTCConfiguration()
    config.iceServers = servers
    config.sdpSemantics = .unifiedPlan
    config.continualGatheringPolicy = .gatherContinually
    // Both sides offer when they add their tracks. Browsers roll back their own
    // offer when the caller's arrives; native WebRTC only does with this on.
    config.enableImplicitRollback = true
    return config
  }
}

// Perfect negotiation needs exactly one polite side per pair. In a DM that's the
// callee; in a group, whoever joined later (server/calls.ts makes the joiner polite):
// we yield to the people a join ack lists, never to those who join after us.
nonisolated func isPolite(group: Bool, outgoing: Bool, joinedAfterThem: Bool) -> Bool {
  group ? joinedAfterThem : !outgoing
}

// Call tiles for n other people (docs/chat-features.md): 1 fills the screen, 2 stack,
// 3–4 make 2×2, 5–8 go in two columns that scroll, three rows to a screen.
nonisolated func callGrid(_ n: Int) -> (columns: Int, rows: Int, scrolls: Bool) {
  switch n {
  case ...1: (1, 1, false)
  case 2: (1, 2, false)
  case 3...4: (2, 2, false)
  default: (2, 3, true)
  }
}
