import AVFoundation
import CallKit
import Observation
import PushKit
import WebRTC

// Phone-style calls: PushKit wakes the phone, CallKit rings it (lock screen,
// Recents, Bluetooth, the system call UI), WebRTC carries audio and video.
// Signaling is the same as the web (src/lib/useCall.ts and server/calls.ts):
// perfect negotiation where the caller is impolite, signals relayed over our
// socket, a watchdog that resends a lost offer, and ICE restarts when the
// network changes.

enum Phase: Equatable { case incoming, calling, ringing, connecting, live, reconnecting, ended }

struct CallView {
  let convId: String
  let peer: String
  let kind: String
  var phase: Phase
  var since: Date?
  var note: String?
  var muted = false
  var camera: Bool
  var front = true
  var remoteMuted = false
  var remoteCamera: Bool
  var local: RTCVideoTrack?
  var remote: RTCVideoTrack?
}

private final class Session {
  var id: String? // server call id; nil until call:start answers
  let uuid: UUID // CallKit's id
  let convId: String
  let peer: String
  let kind: String
  let outgoing: Bool
  var pc: RTCPeerConnection?
  var events: PeerEvents?
  var audio: RTCAudioTrack?
  var video: RTCVideoTrack?
  var videoSender: RTCRtpSender?
  var capturer: RTCCameraVideoCapturer?
  var queue: [[String: Any]] = [] // signals that arrive before the peer connection exists
  var makingOffer = false
  var ignoreOffer = false
  var accepted = false
  var since: Date?
  var muted = false
  var camera: Bool
  var front = true
  var lost: Task<Void, Never>?
  var timers: [Task<Void, Never>] = []
  var done = false

  init(id: String?, uuid: UUID, convId: String, peer: String, kind: String, outgoing: Bool) {
    self.id = id
    self.uuid = uuid
    self.convId = convId
    self.peer = peer
    self.kind = kind
    self.outgoing = outgoing
    camera = kind == "video"
  }
}

@Observable
final class Calls: NSObject {
  static let shared = Calls()

  private(set) var current: CallView?
  var minimized = false
  var openChat: String? // a chat to show, from a call or a notification tap
  var error: String?

  @ObservationIgnored private var talk: Talk?
  @ObservationIgnored private var session: Session?
  @ObservationIgnored private let provider: CXProvider
  @ObservationIgnored private let controller = CXCallController()
  @ObservationIgnored private var registry: PKPushRegistry?
  @ObservationIgnored private var ringback: AVAudioPlayer?
  @ObservationIgnored private lazy var factory: RTCPeerConnectionFactory = {
    RTCInitializeSSL()
    return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
  }()
  private static let lostAfter: Duration = .seconds(30)

  override init() {
    let config = CXProviderConfiguration()
    config.supportsVideo = true
    config.maximumCallsPerCallGroup = 1
    config.maximumCallGroups = 1
    config.supportedHandleTypes = [.generic]
    config.includesCallsInRecents = true
    provider = CXProvider(configuration: config)
    super.init()
    provider.setDelegate(self, queue: nil)
    // CallKit owns the audio session; WebRTC starts audio only once CallKit activates it.
    RTCAudioSession.sharedInstance().useManualAudio = true
    RTCAudioSession.sharedInstance().isAudioEnabled = false
  }

  // Must run at launch: a VoIP push that wakes the app is delivered right after.
  func registerForVoIP() {
    let r = PKPushRegistry(queue: .main)
    r.delegate = self
    r.desiredPushTypes = [.voIP]
    registry = r
  }

  func attach(_ talk: Talk) {
    self.talk = talk
    if let token = registry?.pushToken(for: .voIP) { talk.registerDevice(token: token, kind: "voip") }
    let s = talk.socket
    s.on("call:ring") { [weak self] d in
      guard let r = try? JSONDecoder().decode(CallRing.self, from: d) else { return }
      self?.incoming(id: r.id, convId: r.convId, from: r.from, kind: r.kind)
    }
    s.on("call:accepted") { [weak self] d in
      guard let self, let s = session, s.id == Self.id(d), s.pc == nil else { return }
      stopRingback()
      patch { $0.phase = .connecting }
      provider.reportOutgoingCall(with: s.uuid, startedConnectingAt: nil)
      Task { await self.connect(s) }
    }
    s.on("call:signal") { [weak self] d in
      guard let self, let s = session, let o = Self.json(d), s.id == o["id"] as? String, let data = o["data"] as? [String: Any] else { return }
      if s.pc != nil { Task { await self.handle(s, data) } } else { s.queue.append(data) }
    }
    s.on("call:end") { [weak self] d in
      guard let self, let s = session, let o = Self.json(d), s.id == o["id"] as? String else { return }
      remoteEnded(s, reason: o["reason"] as? String ?? "hangup")
    }
    // Our socket came back (phones drop it): tell the server which device we are again.
    s.on("connect") { [weak self] _ in
      guard let self, let s = session, let id = s.id, s.outgoing || s.pc != nil else { return }
      Task {
        let r = try? await talk.socket.ack("call:rejoin", ["id": id])
        if let r, Self.json(r)?["error"] != nil, self.session === s { self.end(s, note: "Call ended", reason: .remoteEnded) }
      }
    }
  }

  func detach() {
    if let s = session { end(s, note: nil, reason: .remoteEnded) }
    talk = nil
  }

  // MARK: - actions from the UI

  func start(convId: String, peer: String, kind: String) {
    guard session == nil, talk != nil else { return }
    let s = Session(id: nil, uuid: UUID(), convId: convId, peer: peer, kind: kind, outgoing: true)
    session = s
    current = CallView(convId: convId, peer: peer, kind: kind, phase: .calling, camera: s.camera, remoteCamera: kind == "video")
    minimized = false
    let action = CXStartCallAction(call: s.uuid, handle: CXHandle(type: .generic, value: peer))
    action.isVideo = kind == "video"
    action.contactIdentifier = talk?.name(peer)
    controller.request(CXTransaction(action: action)) { [weak self] err in
      guard let err else { return }
      Task { @MainActor in self?.fail(s, "Couldn’t start the call. \(err.localizedDescription)") }
    }
  }

  func hangup() {
    guard let s = session else { return current = nil }
    controller.request(CXTransaction(action: CXEndCallAction(call: s.uuid))) { [weak self] err in
      // CallKit didn't know the call (it never got that far): end it here.
      if err != nil { Task { @MainActor in self?.endLocally(s) } }
    }
  }

  func toggleMute() {
    guard let s = session else { return }
    controller.request(CXTransaction(action: CXSetMutedCallAction(call: s.uuid, muted: !s.muted))) { _ in }
  }

  // Off stops the camera (its light goes out); on starts it, adding video to a voice call.
  func toggleCamera() {
    guard let s = session else { return }
    if s.camera {
      s.capturer?.stopCapture()
      s.camera = false
    } else {
      if s.video == nil { addVideo(s) }
      startCamera(s)
      s.camera = true
    }
    patch { $0.camera = s.camera; $0.local = s.video }
    sendState(s)
  }

  func flip() {
    guard let s = session, s.camera else { return }
    s.front.toggle()
    startCamera(s)
    patch { $0.front = s.front }
  }

  // MARK: - incoming

  private func incoming(id: String, convId: String, from: String, kind: String) {
    let uuid = UUID(uuidString: id) ?? UUID()
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: from)
    update.localizedCallerName = talk?.name(from) ?? Names.of(from) ?? "Talk"
    update.hasVideo = kind == "video"
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false

    // Every VoIP push must reach CallKit, even a duplicate or one we can't take.
    guard session == nil || session?.id == id, talk != nil else {
      provider.reportNewIncomingCall(with: UUID(), update: update) { _ in }
      provider.reportCall(with: uuid, endedAt: nil, reason: .unanswered)
      return
    }
    if session == nil {
      let s = Session(id: id, uuid: uuid, convId: convId, peer: from, kind: kind, outgoing: false)
      session = s
      current = CallView(convId: convId, peer: from, kind: kind, phase: .incoming, camera: s.camera, remoteCamera: kind == "video")
      // A push can arrive after the caller gave up.
      Task {
        do { let _: CallRing = try await talk!.api.call("GET", "/api/calls/\(id)") }
        catch let e as APIError where e.status == 404 { if session === s { remoteEnded(s, reason: "cancelled") } }
        catch {}
      }
    }
    provider.reportNewIncomingCall(with: uuid, update: update) { _ in }
    talk?.socket.connect()
  }

  // MARK: - ending

  private func remoteEnded(_ s: Session, reason: String) {
    let r: CXCallEndedReason = switch reason {
    case "missed": .unanswered
    case "elsewhere": .answeredElsewhere
    case "lost": .failed
    default: .remoteEnded
    }
    let note: String? = switch reason {
    case "hangup": "Call ended"
    case "lost": "Connection lost"
    case "declined": s.outgoing ? "Declined" : nil
    case "missed": s.outgoing ? "No answer" : nil
    default: nil
    }
    end(s, note: note, reason: r)
  }

  private func fail(_ s: Session, _ note: String) {
    if let id = s.id { talk?.socket.emit("call:hangup", ["id": id]) }
    end(s, note: note, reason: .failed)
  }

  private func endLocally(_ s: Session) {
    if let id = s.id { talk?.socket.emit("call:hangup", ["id": id]) }
    finish(s, note: s.outgoing || s.since != nil ? "Call ended" : nil)
  }

  // The call ended without a CallKit action of ours: tell CallKit.
  private func end(_ s: Session, note: String?, reason: CXCallEndedReason) {
    guard !s.done else { return }
    provider.reportCall(with: s.uuid, endedAt: nil, reason: reason)
    finish(s, note: note)
  }

  private func finish(_ s: Session, note: String?) {
    guard !s.done else { return }
    s.done = true
    stopRingback()
    s.lost?.cancel()
    s.timers.forEach { $0.cancel() }
    s.capturer?.stopCapture()
    s.pc?.close()
    if s.outgoing, s.id != nil, let talk {
      let ms = s.since.map { Date().timeIntervalSince($0) * 1000 } ?? 0
      Task { try? await talk.send(s.convId, call: CallLog(kind: s.kind, ms: ms), quiet: true) }
    }
    if session === s { session = nil }
    guard let note else { return current = nil }
    patch { $0.phase = .ended; $0.note = note; $0.local = nil; $0.remote = nil }
    Task {
      try? await Task.sleep(for: .seconds(1.6))
      if current?.phase == .ended { current = nil }
    }
  }

  // MARK: - WebRTC

  private func sendSignal(_ s: Session, _ data: [String: Any]) {
    if let id = s.id { talk?.socket.emit("call:signal", ["id": id, "data": data]) }
  }

  private func sendState(_ s: Session) { sendSignal(s, ["state": ["muted": s.muted, "camera": s.camera]]) }

  private func description(_ d: RTCSessionDescription) -> [String: Any] {
    ["type": RTCSessionDescription.string(for: d.type), "sdp": d.sdp]
  }

  private func iceServers() async -> [RTCIceServer] {
    struct Server: Decodable {
      let urls: [String]
      let username: String?
      let credential: String?
      init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        urls = try (try? c.decode([String].self, forKey: .urls)) ?? [c.decode(String.self, forKey: .urls)]
        username = try c.decodeIfPresent(String.self, forKey: .username)
        credential = try c.decodeIfPresent(String.self, forKey: .credential)
      }
      enum CodingKeys: CodingKey { case urls, username, credential }
    }
    let list: [Server] = (try? await talk?.api.call("GET", "/api/ice")) ?? []
    let servers = list.map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
    return servers.isEmpty ? [RTCIceServer(urlStrings: ["stun:stun.cloudflare.com:3478"])] : servers
  }

  private func connect(_ s: Session) async {
    let config = RTCConfiguration()
    config.iceServers = await iceServers()
    config.sdpSemantics = .unifiedPlan
    config.continualGatheringPolicy = .gatherContinually
    guard !s.done else { return }
    let events = PeerEvents { [weak self] e in Task { @MainActor in self?.event(s, e) } }
    guard let pc = factory.peerConnection(with: config, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: events) else {
      return fail(s, "Couldn’t start the call.")
    }
    s.pc = pc
    s.events = events
    lostAfter(s)

    let audio = factory.audioTrack(with: factory.audioSource(with: nil), trackId: "audio")
    audio.isEnabled = !s.muted
    pc.add(audio, streamIds: ["talk"])
    s.audio = audio
    if let v = s.video { s.videoSender = pc.add(v, streamIds: ["talk"]) }
    else if s.camera { addVideo(s); startCamera(s) }
    patch { $0.local = s.video }

    // An offer can be lost while the other side's socket reconnects; resend it until answered.
    s.timers.append(Task { [weak self] in
      for _ in 0..<6 {
        try? await Task.sleep(for: .seconds(3))
        guard let self, !Task.isCancelled, pc.connectionState != .connected, pc.signalingState != .closed else { return }
        if pc.signalingState == .haveLocalOffer, let d = pc.localDescription { sendSignal(s, ["description": description(d)]) }
      }
    })
    for d in s.queue { await handle(s, d) }
    s.queue = []
    sendState(s)
  }

  private func addVideo(_ s: Session) {
    let source = factory.videoSource()
    s.capturer = RTCCameraVideoCapturer(delegate: source)
    let track = factory.videoTrack(with: source, trackId: "video")
    s.video = track
    if let pc = s.pc { s.videoSender = pc.add(track, streamIds: ["talk"]) }
  }

  private func startCamera(_ s: Session) {
    guard let capturer = s.capturer,
          let device = RTCCameraVideoCapturer.captureDevices().first(where: { $0.position == (s.front ? .front : .back) })
            ?? RTCCameraVideoCapturer.captureDevices().first else { return }
    // Closest to 1280×720, like the web.
    let format = RTCCameraVideoCapturer.supportedFormats(for: device).min { a, b in
      let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription), db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
      return abs(Int(da.width) - 1280) + abs(Int(da.height) - 720) < abs(Int(db.width) - 1280) + abs(Int(db.height) - 720)
    }
    guard let format else { return }
    let fps = min(30, Int(format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 30))
    capturer.startCapture(with: device, format: format, fps: fps)
  }

  private func handle(_ s: Session, _ d: [String: Any]) async {
    guard let pc = s.pc else { return }
    if let st = d["state"] as? [String: Any] {
      patch { $0.remoteMuted = st["muted"] as? Bool ?? false; $0.remoteCamera = st["camera"] as? Bool ?? false }
    }
    if let desc = d["description"] as? [String: Any], let type = desc["type"] as? String, let sdp = desc["sdp"] as? String {
      // Perfect negotiation: on an offer collision the callee yields.
      let collision = type == "offer" && (s.makingOffer || pc.signalingState != .stable)
      s.ignoreOffer = s.outgoing && collision
      if s.ignoreOffer { return }
      do {
        try await wait { pc.setRemoteDescription(RTCSessionDescription(type: RTCSessionDescription.type(for: type), sdp: sdp), completionHandler: $0) }
        if type == "offer" {
          try await wait { pc.setLocalDescriptionWithCompletionHandler($0) }
          if let local = pc.localDescription { sendSignal(s, ["description": description(local)]) }
        }
      } catch { print("[call]", error) }
    } else if let c = d["candidate"] as? [String: Any], let sdp = c["candidate"] as? String {
      let cand = RTCIceCandidate(sdp: sdp, sdpMLineIndex: Int32(c["sdpMLineIndex"] as? Int ?? 0), sdpMid: c["sdpMid"] as? String)
      do { try await wait { pc.add(cand, completionHandler: $0) } }
      catch { if !s.ignoreOffer { print("[call]", error) } }
    }
  }

  private func event(_ s: Session, _ e: PeerEvent) {
    guard let pc = s.pc, !s.done else { return }
    switch e {
    case .negotiate:
      Task {
        s.makingOffer = true
        defer { s.makingOffer = false }
        do {
          try await wait { pc.setLocalDescriptionWithCompletionHandler($0) }
          if let d = pc.localDescription { sendSignal(s, ["description": description(d)]) }
        } catch { print("[call]", error) }
      }
    case .candidate(let sdp, let mid, let index):
      var c: [String: Any] = ["candidate": sdp, "sdpMLineIndex": index]
      if let mid { c["sdpMid"] = mid }
      sendSignal(s, ["candidate": c])
    case .track(let box):
      if let t = box.value as? RTCVideoTrack { patch { $0.remote = t } }
    case .state(let raw):
      switch RTCPeerConnectionState(rawValue: raw) {
      case .connected:
        s.lost?.cancel()
        s.lost = nil
        if s.since == nil {
          s.since = Date()
          if s.outgoing { provider.reportOutgoingCall(with: s.uuid, connectedAt: s.since) }
        }
        patch { $0.phase = .live; $0.since = s.since }
      case .disconnected, .failed:
        if s.since != nil { patch { $0.phase = .reconnecting } }
        // Network change (wifi to cellular): find a new path instead of dropping the call.
        if raw == RTCPeerConnectionState.failed.rawValue { pc.restartIce() }
        else {
          s.timers.append(Task {
            try? await Task.sleep(for: .seconds(3))
            if pc.connectionState == .disconnected { pc.restartIce() }
          })
        }
        lostAfter(s)
      default: break
      }
    }
  }

  private func lostAfter(_ s: Session) {
    guard s.lost == nil else { return }
    s.lost = Task { [weak self] in
      try? await Task.sleep(for: Self.lostAfter)
      guard let self, !Task.isCancelled, !s.done else { return }
      fail(s, s.since != nil ? "Connection lost" : "Couldn’t connect")
    }
  }

  private func wait(_ op: (@escaping @Sendable (Error?) -> Void) -> Void) async throws {
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
      op { @Sendable e in if let e { c.resume(throwing: e) } else { c.resume() } }
    }
  }

  private func patch(_ f: (inout CallView) -> Void) {
    guard var v = current else { return }
    f(&v)
    current = v
  }

  private static func json(_ d: Data) -> [String: Any]? { (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] }
  private static func id(_ d: Data) -> String? { json(d)?["id"] as? String }

  // The familiar US ringback (440 + 480 Hz, 2 s on, 4 s off), made here so there are no sound files to ship.
  private func playRingback() {
    let rate = 8000.0, seconds = 6.0
    let n = Int(rate * seconds)
    var pcm = Data(capacity: n * 2)
    for i in 0..<n {
      let t = Double(i) / rate
      let v = t < 2 ? (sin(2 * .pi * 440 * t) + sin(2 * .pi * 480 * t)) * 0.12 : 0
      withUnsafeBytes(of: Int16(v * Double(Int16.max)).littleEndian) { pcm.append(contentsOf: $0) }
    }
    var wav = Data("RIFF".utf8)
    func u32(_ x: Int) { withUnsafeBytes(of: UInt32(x).littleEndian) { wav.append(contentsOf: $0) } }
    func u16(_ x: Int) { withUnsafeBytes(of: UInt16(x).littleEndian) { wav.append(contentsOf: $0) } }
    u32(36 + pcm.count); wav.append(contentsOf: "WAVEfmt ".utf8)
    u32(16); u16(1); u16(1); u32(Int(rate)); u32(Int(rate) * 2); u16(2); u16(16)
    wav.append(contentsOf: "data".utf8); u32(pcm.count); wav.append(pcm)
    ringback = try? AVAudioPlayer(data: wav)
    ringback?.numberOfLoops = -1
    ringback?.play()
  }

  private func stopRingback() {
    ringback?.stop()
    ringback = nil
  }

  private func configureAudio(video: Bool) {
    let rtc = RTCAudioSession.sharedInstance()
    let config = RTCAudioSessionConfiguration.webRTC()
    config.mode = (video ? AVAudioSession.Mode.videoChat : .voiceChat).rawValue
    rtc.lockForConfiguration()
    try? rtc.setConfiguration(config)
    rtc.unlockForConfiguration()
  }
}

// MARK: - CallKit

extension Calls: CXProviderDelegate {
  func providerDidReset(_ provider: CXProvider) {
    if let s = session { endLocally(s) }
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    guard let s = session, s.uuid == action.callUUID, let talk else { return action.fail() }
    configureAudio(video: s.kind == "video")
    // Your own camera fills the screen while it rings, like a mirror.
    if s.camera { addVideo(s); startCamera(s); patch { $0.local = s.video } }
    Task {
      let r = try? await talk.socket.ack("call:start", ["convId": s.convId, "kind": s.kind], timeout: 10)
      let o = r.flatMap(Self.json)
      if s.done {
        if let id = o?["id"] as? String { talk.socket.emit("call:hangup", ["id": id]) }
        return action.fail()
      }
      guard let id = o?["id"] as? String else {
        action.fail()
        return finish(s, note: o?["error"] as? String ?? "Couldn’t reach the server. Check your connection.")
      }
      s.id = id
      action.fulfill()
      provider.reportOutgoingCall(with: s.uuid, startedConnectingAt: nil)
      patch { $0.phase = .ringing }
    }
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard let s = session, s.uuid == action.callUUID, let id = s.id, let talk, !s.accepted else { return action.fail() }
    s.accepted = true
    configureAudio(video: s.kind == "video")
    action.fulfill()
    patch { $0.phase = .connecting }
    minimized = false
    Task {
      // Answered from the lock screen: the socket may still be connecting.
      for _ in 0..<40 where !talk.socket.connected { try? await Task.sleep(for: .milliseconds(250)) }
      let r = try? await talk.socket.ack("call:accept", ["id": id], timeout: 10)
      guard let o = r.flatMap(Self.json), o["id"] != nil else {
        return end(s, note: (r.flatMap(Self.json)?["error"] as? String) ?? "Couldn’t reach the server. Check your connection.", reason: .failed)
      }
      await connect(s)
    }
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    guard let s = session, s.uuid == action.callUUID else { return action.fulfill() }
    endLocally(s)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    guard let s = session, s.uuid == action.callUUID else { return action.fail() }
    s.muted = action.isMuted
    s.audio?.isEnabled = !s.muted
    patch { $0.muted = s.muted }
    sendState(s)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    RTCAudioSession.sharedInstance().audioSessionDidActivate(audioSession)
    RTCAudioSession.sharedInstance().isAudioEnabled = true
    if let s = session, s.outgoing, s.pc == nil { playRingback() }
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    RTCAudioSession.sharedInstance().audioSessionDidDeactivate(audioSession)
    RTCAudioSession.sharedInstance().isAudioEnabled = false
  }
}

// MARK: - PushKit

extension Calls: PKPushRegistryDelegate {
  func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
    talk?.registerDevice(token: credentials.token, kind: "voip")
  }

  func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    let p = payload.dictionaryPayload
    incoming(id: p["callId"] as? String ?? UUID().uuidString, convId: p["convId"] as? String ?? "", from: p["from"] as? String ?? "", kind: p["kind"] as? String ?? "audio")
    completion()
  }
}

// MARK: - peer connection events, off the main thread

nonisolated enum PeerEvent: Sendable {
  case negotiate
  case candidate(sdp: String, mid: String?, index: Int32)
  case state(Int)
  case track(Box)
}

nonisolated struct Box: @unchecked Sendable { let value: AnyObject }

nonisolated final class PeerEvents: NSObject, RTCPeerConnectionDelegate {
  let send: @Sendable (PeerEvent) -> Void
  init(_ send: @escaping @Sendable (PeerEvent) -> Void) { self.send = send }

  func peerConnectionShouldNegotiate(_ pc: RTCPeerConnection) { send(.negotiate) }
  func peerConnection(_ pc: RTCPeerConnection, didGenerate c: RTCIceCandidate) { send(.candidate(sdp: c.sdp, mid: c.sdpMid, index: c.sdpMLineIndex)) }
  func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCPeerConnectionState) { send(.state(s.rawValue)) }
  func peerConnection(_ pc: RTCPeerConnection, didAdd r: RTCRtpReceiver, streams: [RTCMediaStream]) {
    if let t = r.track { send(.track(Box(value: t))) }
  }
  func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCSignalingState) {}
  func peerConnection(_ pc: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ pc: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCIceConnectionState) {}
  func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCIceGatheringState) {}
  func peerConnection(_ pc: RTCPeerConnection, didRemove c: [RTCIceCandidate]) {}
  func peerConnection(_ pc: RTCPeerConnection, didOpen dc: RTCDataChannel) {}
}
