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
