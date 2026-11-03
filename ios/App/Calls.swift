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
// network changes. A group call is a mesh: one peer connection per person,
// each negotiated the same way, sharing our microphone and camera.

enum Phase: Equatable { case incoming, calling, ringing, connecting, live, reconnecting, ended }

struct CallView {
  let convId: String
  let peer: String // DM: the other person; group: who started it
  var group: String? // the group's title; nil in a DM
  let kind: String
  var phase: Phase
  var since: Date?
  var note: String?
  var muted = false
  var camera: Bool
  var front = true
  var local: RTCVideoTrack?
  var tiles: [Tile] = [] // everyone we're connecting or connected to, in join order
  var remote: RTCVideoTrack? { tiles.first?.video }
  var remoteMuted: Bool { tiles.first?.muted ?? false }
  var remoteCamera: Bool { tiles.first?.camera ?? false }
}

struct Tile: Identifiable {
  let id: String // user id
  var video: RTCVideoTrack?
  var muted = false
  var camera: Bool
}

private final class Peer {
  let user: String
  let polite: Bool
  var pc: RTCPeerConnection?
  var events: PeerEvents?
  var videoSender: RTCRtpSender?
  var queue: [[String: Any]] = [] // signals that arrive before the peer connection exists
  var makingOffer = false
  var ignoreOffer = false
  var lost: Task<Void, Never>?
  var timers: [Task<Void, Never>] = []

  init(user: String, polite: Bool) {
    self.user = user
    self.polite = polite
  }
}

// One of /api/ice's servers; `urls` is one string or a list, as in the browser.
nonisolated private struct IceServer: Decodable, Sendable {
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

private final class Session {
  var id: String? // server call id; nil until call:start answers
  let uuid: UUID // CallKit's id
  let convId: String
  let peer: String
  var group: Bool
  let kind: String
  let outgoing: Bool
  let join: String? // a group call already on, joined from the chat instead of started
  var peers: [String: Peer] = [:] // by user id; a DM has at most one
  var audio: RTCAudioTrack?
  var video: RTCVideoTrack?
  var capturer: RTCCameraVideoCapturer?
  var accepted = false
  var since: Date?
  var muted = false
  var camera: Bool
  var front = true
  var done = false
  var ice: Task<[IceServer], Never>? // fetched once, for every peer connection
  var checked: Task<Void, Never>? // incoming: the server's call state, which also says whether it's a group call

  init(id: String?, uuid: UUID, convId: String, peer: String, group: Bool, kind: String, outgoing: Bool, join: String? = nil) {
    self.id = id
    self.uuid = uuid
    self.convId = convId
    self.peer = peer
    self.group = group
    self.kind = kind
    self.outgoing = outgoing
    self.join = join
    camera = kind == "video"
  }
}

@Observable
final class Calls: NSObject {
  static let shared = Calls()

  private(set) var current: CallView?
  var minimized = false
  var openChat: String? // a chat to show, from a call or a notification tap
  var error: String? // shown as an alert, with a way to Settings

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

  // Runs at launch and again when the window appears; handlers go on once per account.
  func attach(_ talk: Talk) {
    guard self.talk !== talk else { return }
    self.talk = talk
    if let token = registry?.pushToken(for: .voIP) { talk.registerDevice(token: token, kind: "voip") }
    let s = talk.socket
    s.on("call:ring") { [weak self] d in
      guard let r = try? JSONDecoder().decode(CallRing.self, from: d) else { return }
      self?.incoming(id: r.id, convId: r.convId, from: r.from, kind: r.kind, group: r.group == true)
    }
    s.on("call:accepted") { [weak self] d in
      guard let self, case let (s, _)? = ours(d), s.peers.isEmpty else { return }
      stopRingback()
      patch { $0.phase = .connecting }
      provider.reportOutgoingCall(with: s.uuid, startedConnectingAt: nil)
      addPeer(s, s.peer, polite: isPolite(group: false, outgoing: true, joinedAfterThem: false))
    }
    // Group: someone joined after us, or joined again from another device; (re)connect to them.
    s.on("call:joined") { [weak self] d in
      guard let self, case let (s, o)? = ours(d), let user = o["user"] as? String else { return }
      addPeer(s, user, polite: isPolite(group: true, outgoing: s.outgoing, joinedAfterThem: false))
    }
    s.on("call:left") { [weak self] d in
      guard let self, case let (s, o)? = ours(d), let user = o["user"] as? String else { return }
      closePeer(s, user)
    }
    // DM signals come without `from`: they're from our one peer.
    s.on("call:signal") { [weak self] d in
      guard let self, case let (s, o)? = ours(d), let data = o["data"] as? [String: Any], let p = s.peers[o["from"] as? String ?? s.peer] else { return }
      if p.pc != nil { Task { await self.handle(s, p, data) } } else { p.queue.append(data) }
    }
    s.on("call:end") { [weak self] d in
      guard let self, case let (s, o)? = ours(d) else { return }
      remoteEnded(s, reason: o["reason"] as? String ?? "hangup")
    }
    // Our socket came back (phones drop it): tell the server which device we are again.
    s.on("connect") { [weak self] _ in
      guard let self, let s = session, let id = s.id, s.outgoing || !s.peers.isEmpty else { return }
      Task {
        let r = try? await talk.socket.ack("call:rejoin", ["id": id])
        guard let o = r.flatMap(Self.json), self.session === s else { return }
        if o["error"] != nil { return self.end(s, note: "Call ended", reason: .remoteEnded) }
        // Joins and leaves we missed while away. Anyone new joined after us and waits for our offer.
        guard let peers = o["peers"] as? [String] else { return }
        for u in s.peers.keys where !peers.contains(u) { self.closePeer(s, u) }
        for u in peers where s.peers[u] == nil { self.addPeer(s, u, polite: isPolite(group: true, outgoing: s.outgoing, joinedAfterThem: false)) }
      }
    }
  }

  func detach() {
    if let s = session { end(s, note: nil, reason: .remoteEnded) }
    talk = nil
  }

  #if DEBUG
  // Screenshots only: the Simulator ends every CallKit call, so this shows a live call screen with no media.
  func demo(convId: String, peer: String) {
    current = CallView(convId: convId, peer: peer, kind: "audio", phase: .live, since: Date().addingTimeInterval(-754), camera: false)
  }
  #endif

  // MARK: - actions from the UI

  // A DM rings the other person. A group joins the call it has on, or starts one.
  func start(convId: String, kind: String) {
    guard let talk, let conv = talk.me?.conversations.first(where: { $0.id == convId }) else { return }
    let group = conv.kind == "group"
    let live = group ? conv.call : nil
    if let s = session {
      // Already ringing for, or in, this chat's call: answer it, or show it.
      guard let live, s.id == live.id else { return }
      if s.outgoing || s.accepted { minimized = false }
      else { controller.request(CXTransaction(action: CXAnswerCallAction(call: s.uuid))) { _ in } }
      return
    }
    // A DM whose other account was deleted has nobody to ring.
    guard let peer = group ? live?.from ?? talk.account.userId : talk.peer(conv) else { return }
    Task {
      guard await mediaAllowed(video: kind == "video"), session == nil else { return }
      place(convId: convId, peer: peer, group: group ? conv.title ?? "Group call" : nil, kind: kind, join: live?.id)
    }
  }

  // Asked before a call, not during one: a denied mic or camera would mean a
  // silent or black call with no reason given.
  private func mediaAllowed(video: Bool) async -> Bool {
    guard await AVAudioApplication.requestRecordPermission() else {
      error = "Allow Talk to use the microphone in Settings to make calls."
      return false
    }
    if video, !(await AVCaptureDevice.requestAccess(for: .video)) {
      error = "Allow Talk to use the camera in Settings for video calls."
      return false
    }
    return true
  }

  private func place(convId: String, peer: String, group: String?, kind: String, join: String?) {
    // Joining: known up front, so a call:joined that beats our join ack still finds us.
    let s = Session(id: join, uuid: UUID(), convId: convId, peer: peer, group: group != nil, kind: kind, outgoing: true, join: join)
    session = s
    current = CallView(convId: convId, peer: peer, group: group, kind: kind, phase: .calling, camera: s.camera)
    minimized = false
    let action = CXStartCallAction(call: s.uuid, handle: CXHandle(type: .generic, value: group != nil ? convId : peer))
    action.isVideo = kind == "video"
    action.contactIdentifier = group ?? talk?.name(peer)
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
    if !s.camera, AVCaptureDevice.authorizationStatus(for: .video) != .authorized {
      // Not yet asked (answered on the lock screen) or turned off in Settings.
      Task {
        if await AVCaptureDevice.requestAccess(for: .video) { toggleCamera() }
        else { error = "Allow Talk to use the camera in Settings for video calls." }
      }
      return
    }
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

  // Rings someone in the chat into the group call we're in; returns the server's refusal, if any.
  func ring(_ userId: String) async -> String? {
    guard let talk, let s = session, s.group, let id = s.id else { return "This call has ended." }
    do { return Self.json(try await talk.socket.ack("call:add", ["id": id, "users": [userId]]))?["error"] as? String }
    catch { return error.localizedDescription }
  }

  func flip() {
    guard let s = session, s.camera else { return }
    s.front.toggle()
    startCamera(s)
    patch { $0.front = s.front }
  }

  // MARK: - incoming

  // `group` is nil from a VoIP push, which doesn't say: guess from the cache for CallKit's label
  // (Names keeps group titles by chat id), and answer as the server's call state says.
  private func incoming(id: String, convId: String, from: String, kind: String, group flag: Bool?) {
    // A call we're already in (joined from the chat) keeps its own CallKit id.
    let uuid = session?.id == id ? session!.uuid : UUID(uuidString: id) ?? UUID()
    let conv = talk?.me?.conversations.first { $0.id == convId }
    let group = flag ?? conv.map { $0.kind == "group" } ?? (Names.of(convId) != nil)
    let title = group ? conv?.title ?? Names.of(convId) ?? "Group call" : nil
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: group ? convId : from)
    update.localizedCallerName = title ?? talk?.name(from) ?? Names.of(from) ?? "Talk"
    update.hasVideo = kind == "video"
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false

    // Every VoIP push must reach CallKit, even a duplicate or one we can't take.
    guard session == nil || session?.id == id, talk != nil else {
      let junk = UUID()
      provider.reportNewIncomingCall(with: junk, update: update) { _ in }
      provider.reportCall(with: junk, endedAt: nil, reason: .unanswered)
      return
    }
    if session == nil {
      let s = Session(id: id, uuid: uuid, convId: convId, peer: from, group: group, kind: kind, outgoing: false)
      session = s
      current = CallView(convId: convId, peer: from, group: title, kind: kind, phase: .incoming, camera: s.camera)
      // A push can arrive after the caller gave up, or after another of our devices answered.
      let check = Task {
        struct Ring: Decodable { let state: String; let group: Bool? }
        do {
          let r: Ring = try await talk!.api.call("GET", "/api/calls/\(id)")
          if r.group == true { s.group = true } // the cache never mistakes a DM for a group, only the reverse
          if r.state != "ringing", session === s, !s.accepted { remoteEnded(s, reason: "elsewhere") }
        }
        catch let e as APIError where e.status == 404 { if session === s { remoteEnded(s, reason: "cancelled") } }
        catch {}
      }
      if flag == nil { s.checked = check } // only a push leaves the kind to this check; answering waits for it then
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
    for u in s.peers.keys { closePeer(s, u) }
    s.capturer?.stopCapture()
    // The one who started it logs it, joiners don't.
    if s.outgoing, s.join == nil, s.id != nil, let talk {
      let ms = s.since.map { Date().timeIntervalSince($0) * 1000 } ?? 0
      Task { try? await talk.send(s.convId, call: CallLog(kind: s.kind, ms: ms, group: s.group ? true : nil), quiet: true, seen: ms > 0) }
    }
    if session === s { session = nil }
    guard let note else { return current = nil }
    patch { $0.phase = .ended; $0.note = note; $0.local = nil; $0.tiles = [] }
    Task {
      try? await Task.sleep(for: .seconds(1.6))
      if current?.phase == .ended { current = nil }
    }
  }

  // MARK: - WebRTC

  // A DM signal goes to the other side without `to`, as every app version expects.
  private func sendSignal(_ s: Session, _ p: Peer, _ data: [String: Any]) {
    guard let id = s.id else { return }
    talk?.socket.emit("call:signal", s.group ? ["id": id, "to": p.user, "data": data] : ["id": id, "data": data])
  }

  private func sendState(_ s: Session) { s.peers.values.forEach { sendState(s, $0) } }
  private func sendState(_ s: Session, _ p: Peer) { sendSignal(s, p, ["state": ["muted": s.muted, "camera": s.camera]]) }

  private func description(_ d: RTCSessionDescription) -> [String: Any] {
    ["type": RTCSessionDescription.string(for: d.type), "sdp": d.sdp]
  }

  // One GET per call, shared by every peer connection in it.
  private func iceServers(_ s: Session) async -> [RTCIceServer] {
    let fetch = s.ice ?? Task { () -> [IceServer] in (try? await talk?.api.call("GET", "/api/ice")) ?? [] }
    s.ice = fetch
    let servers = await fetch.value.map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
    return servers.isEmpty ? [RTCIceServer(urlStrings: ["stun:stun.cloudflare.com:3478"])] : servers
  }

  // Starts connecting to one person, replacing any connection we had to them.
  // Signals for them queue until their peer connection exists.
  private func addPeer(_ s: Session, _ user: String, polite: Bool) {
    guard !s.done else { return }
    closePeer(s, user)
    let p = Peer(user: user, polite: polite)
    s.peers[user] = p
    stopRingback()
    patch { v in
      v.tiles.append(Tile(id: user, camera: s.kind == "video"))
      if v.phase == .ringing { v.phase = .connecting }
    }
    Task { await connect(s, p) }
  }

  private func closePeer(_ s: Session, _ user: String) {
    guard let p = s.peers.removeValue(forKey: user) else { return }
    p.lost?.cancel()
    p.timers.forEach { $0.cancel() }
    p.pc?.close()
    p.events = nil // its closure holds the peer and session
    patch { $0.tiles.removeAll { $0.id == user } }
    cap(s)
  }

  // A mesh sends each person their own copy of our video: in a group, cap every copy as the call grows
  // (docs/chat-features.md, "Group call video"). New parameters, no renegotiation. DMs keep the defaults.
  private func cap(_ s: Session) {
    guard s.group, !s.done else { return }
    let c = videoCap(s.peers.count)
    for p in s.peers.values {
      guard let sender = p.videoSender else { continue }
      let params = sender.parameters
      guard let e = params.encodings.first else { continue }
      e.maxBitrateBps = NSNumber(value: c.bitrate)
      e.scaleResolutionDownBy = NSNumber(value: c.scale)
      e.maxFramerate = NSNumber(value: c.fps)
      sender.parameters = params
    }
  }

  private func connect(_ s: Session, _ p: Peer) async {
    let config = RTCConfiguration.talk(await iceServers(s))
    guard !s.done, s.peers[p.user] === p else { return }
    let events = PeerEvents { [weak self] e in Task { @MainActor in self?.event(s, p, e) } }
    guard let pc = factory.peerConnection(with: config, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: events) else {
      return fail(s, "Couldn’t start the call.")
    }
    p.pc = pc
    p.events = events
    lostAfter(s, p)

    // One microphone and camera for everyone in the call.
    let audio = s.audio ?? factory.audioTrack(with: factory.audioSource(with: nil), trackId: "audio")
    audio.isEnabled = !s.muted
    pc.add(audio, streamIds: ["talk"])
    s.audio = audio
    if let v = s.video { p.videoSender = pc.add(v, streamIds: ["talk"]) }
    else if s.camera { addVideo(s); startCamera(s) }
    cap(s) // one more person: everyone's copy gets smaller
    patch { $0.local = s.video }

    // An offer can be lost while the other side's socket reconnects; resend it until answered.
    p.timers.append(Task { [weak self] in
      for _ in 0..<6 {
        try? await Task.sleep(for: .seconds(3))
        guard let self, !Task.isCancelled, pc.connectionState != .connected, pc.signalingState != .closed else { return }
        if pc.signalingState == .haveLocalOffer, let d = pc.localDescription { sendSignal(s, p, ["description": description(d)]) }
      }
    })
    for d in p.queue { await handle(s, p, d) }
    p.queue = []
    sendState(s, p)
  }

  private func addVideo(_ s: Session) {
    let source = factory.videoSource()
    s.capturer = RTCCameraVideoCapturer(delegate: source)
    let track = factory.videoTrack(with: source, trackId: "video")
    s.video = track
    for p in s.peers.values { if let pc = p.pc { p.videoSender = pc.add(track, streamIds: ["talk"]) } }
    cap(s)
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

  private func handle(_ s: Session, _ p: Peer, _ d: [String: Any]) async {
    guard let pc = p.pc else { return }
    if let st = d["state"] as? [String: Any] {
      patch(p.user) { $0.muted = st["muted"] as? Bool ?? false; $0.camera = st["camera"] as? Bool ?? false }
    }
    if let desc = d["description"] as? [String: Any], let type = desc["type"] as? String, let sdp = desc["sdp"] as? String {
      // Perfect negotiation: on an offer collision the polite side yields.
      let collision = type == "offer" && (p.makingOffer || pc.signalingState != .stable)
      p.ignoreOffer = !p.polite && collision
      if p.ignoreOffer { return }
      do {
        try await wait { pc.setRemoteDescription(RTCSessionDescription(type: RTCSessionDescription.type(for: type), sdp: sdp), completionHandler: $0) }
        if type == "offer" {
          try await wait { pc.setLocalDescriptionWithCompletionHandler($0) }
          if let local = pc.localDescription { sendSignal(s, p, ["description": description(local)]) }
        }
      } catch { print("[call]", error) }
    } else if let c = d["candidate"] as? [String: Any], let sdp = c["candidate"] as? String {
      let cand = RTCIceCandidate(sdp: sdp, sdpMLineIndex: Int32(c["sdpMLineIndex"] as? Int ?? 0), sdpMid: c["sdpMid"] as? String)
      do { try await wait { pc.add(cand, completionHandler: $0) } }
      catch { if !p.ignoreOffer { print("[call]", error) } }
    }
  }

  private func event(_ s: Session, _ p: Peer, _ e: PeerEvent) {
    guard let pc = p.pc, !s.done, s.peers[p.user] === p else { return }
    switch e {
    case .negotiate:
      // In a group the polite side waits for the first offer, as the web does: after
      // crossed offers, Chrome's rollback can stop gathering candidates.
      if s.group, p.polite, pc.remoteDescription == nil { return }
      Task {
        p.makingOffer = true
        defer { p.makingOffer = false }
        do {
          try await wait { pc.setLocalDescriptionWithCompletionHandler($0) }
          if let d = pc.localDescription { sendSignal(s, p, ["description": description(d)]) }
        } catch { print("[call]", error) }
      }
    case .candidate(let sdp, let mid, let index):
      var c: [String: Any] = ["candidate": sdp, "sdpMLineIndex": index]
      if let mid { c["sdpMid"] = mid }
      sendSignal(s, p, ["candidate": c])
    case .track(let box):
      if let t = box.value as? RTCVideoTrack { patch(p.user) { $0.video = t } }
    case .state(let raw):
      switch RTCPeerConnectionState(rawValue: raw) {
      case .connected:
        p.lost?.cancel()
        p.lost = nil
        if s.since == nil {
          s.since = Date()
          if s.outgoing { provider.reportOutgoingCall(with: s.uuid, connectedAt: s.since) }
        }
        patch { $0.phase = .live; $0.since = s.since }
      case .disconnected, .failed:
        // Reconnecting only once nobody is reachable; in a group the others still talk.
        if s.since != nil, !s.peers.values.contains(where: { $0.pc?.connectionState == .connected }) { patch { $0.phase = .reconnecting } }
        // Network change (wifi to cellular): find a new path instead of dropping the call.
        if raw == RTCPeerConnectionState.failed.rawValue { pc.restartIce() }
        else {
          p.timers.append(Task {
            try? await Task.sleep(for: .seconds(3))
            if pc.connectionState == .disconnected { pc.restartIce() }
          })
        }
        lostAfter(s, p)
      default: break
      }
    }
  }

  // A DM ends when its connection is lost; a group goes on without whoever we can't reach.
  private func lostAfter(_ s: Session, _ p: Peer) {
    guard p.lost == nil else { return }
    p.lost = Task { [weak self] in
      try? await Task.sleep(for: Self.lostAfter)
      guard let self, !Task.isCancelled, !s.done else { return }
      if s.group { closePeer(s, p.user) }
      if !s.group || s.peers.isEmpty { fail(s, s.since != nil ? "Connection lost" : "Couldn’t connect") }
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

  private func patch(_ user: String, _ f: (inout Tile) -> Void) {
    patch { v in if let i = v.tiles.firstIndex(where: { $0.id == user }) { f(&v.tiles[i]) } }
  }

  private static func json(_ d: Data) -> [String: Any]? { (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] }

  // An event about the call we're in or ringing for: that session, and the event's fields.
  private func ours(_ d: Data) -> (Session, [String: Any])? {
    guard let s = session, let o = Self.json(d), s.id == o["id"] as? String else { return nil }
    return (s, o)
  }

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
      let r = try? await talk.socket.ack(s.join == nil ? "call:start" : "call:join", s.join.map { ["id": $0] } ?? ["convId": s.convId, "kind": s.kind], timeout: 10)
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
      patch { if $0.phase == .calling { $0.phase = .ringing } }
      // Joining a call that's on: connect to everyone in it, yielding to them (they were first).
      for u in o?["peers"] as? [String] ?? [] { addPeer(s, u, polite: isPolite(group: true, outgoing: true, joinedAfterThem: true)) }
    }
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard let s = session, s.uuid == action.callUUID, let id = s.id, let talk, !s.accepted else { return action.fail() }
    s.accepted = true
    configureAudio(video: s.kind == "video")
    action.fulfill()
    // No prompt can show over the lock screen: answer without what we may not use.
    if s.camera, AVCaptureDevice.authorizationStatus(for: .video) != .authorized { s.camera = false }
    if AVAudioApplication.shared.recordPermission == .denied {
      error = "Talk can't use the microphone, so they can't hear you. Allow it in Settings."
    }
    patch { $0.phase = .connecting; $0.camera = s.camera }
    minimized = false
    Task {
      // Answered from the lock screen: the socket may still be connecting.
      for _ in 0..<40 where !talk.socket.connected { try? await Task.sleep(for: .milliseconds(250)) }
      // A group is answered by joining. The cache may have guessed a DM: a group made while the app was away.
      await s.checked?.value
      if s.group, current?.group == nil {
        var c = talk.me?.conversations.first { $0.id == s.convId }
        if c == nil { c = (try? await talk.load())?.conversations.first { $0.id == s.convId } }
        patch { $0.group = c?.title ?? "Group call" }
      }
      let r = try? await talk.socket.ack(s.group ? "call:join" : "call:accept", ["id": id], timeout: 10)
      guard let o = r.flatMap(Self.json), o["id"] != nil else {
        return end(s, note: (r.flatMap(Self.json)?["error"] as? String) ?? "Couldn’t reach the server. Check your connection.", reason: .failed)
      }
      if !s.group { return addPeer(s, s.peer, polite: isPolite(group: false, outgoing: false, joinedAfterThem: false)) }
      for u in o["peers"] as? [String] ?? [] { addPeer(s, u, polite: isPolite(group: true, outgoing: false, joinedAfterThem: true)) }
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
    if let s = session, s.outgoing, s.peers.isEmpty { playRingback() }
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
    incoming(id: p["callId"] as? String ?? UUID().uuidString, convId: p["convId"] as? String ?? "", from: p["from"] as? String ?? "", kind: p["kind"] as? String ?? "audio", group: nil)
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
