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
// A polite group peer also sends no offer of its own until it has theirs.
nonisolated func isPolite(group: Bool, outgoing: Bool, joinedAfterThem: Bool) -> Bool {
  group ? joinedAfterThem : !outgoing
}

// What we send each person in a group call with n others (docs/chat-features.md, "Group call video"),
// so a mesh of 8 stays inside a phone's upload.
nonisolated func videoCap(_ others: Int) -> (bitrate: Int, scale: Double, fps: Int) {
  switch others {
  case ...1: (1_500_000, 1, 30)
  case 2: (900_000, 1, 30)
  case 3: (600_000, 1.5, 30)
  case 4...5: (400_000, 2, 24)
  default: (250_000, 2.5, 15)
  }
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
