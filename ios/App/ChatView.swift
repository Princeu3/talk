import AVFoundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ChatView: View {
  @Environment(Talk.self) private var talk
  @Environment(Calls.self) private var calls
  let convId: String
  @State private var text = ""
  @State private var photos: [PhotosPickerItem] = []
  @State private var pickingPhotos = false
  @State private var pickingFiles = false
  @State private var sending = false
  @State private var error: String?
  @State private var reporting = false
  @State private var reportNote = ""
  @State private var reported: Decrypted? // set when reporting one message from its long-press menu
  @State private var zoom: UIImage?
  @State private var recorder: VoiceRecorder?
  @State private var startingRecorder = false
  @State private var shown = false
  @Environment(\.scenePhase) private var scenePhase

  private var conv: Conversation? { talk.me?.conversations.first { $0.id == convId } }
  private var peer: String? { conv.flatMap(talk.peer) }

  var body: some View {
    let list = talk.messages[convId] ?? []
    ScrollView {
      LazyVStack(spacing: 2) {
        if talk.hasOlder[convId] == true {
          ProgressView().padding().onAppear { Task { await talk.loadOlder(convId) } }
        }
        ForEach(Array(list.enumerated()), id: \.element.id) { i, m in
          let prev = i > 0 ? list[i - 1] : nil
          if prev.map({ !Calendar.current.isDate(date($0), inSameDayAs: date(m)) }) ?? true {
            Text(Format.day(m.message.createdAt)).font(.caption.weight(.medium)).foregroundStyle(Color.mut).padding(.vertical, 12)
          }
          let gap = prev.map { m.message.createdAt - $0.message.createdAt > 5 * 60_000 || $0.message.senderId != m.message.senderId } ?? true
          MessageRow(convId: convId, m: m, group: conv?.kind == "group", first: gap, onCall: callAgain, onZoom: { zoom = $0 }) {
            reported = $0
            reporting = true
          }
            .padding(.top, gap ? 8 : 0)
        }
        if list.isEmpty, conv != nil {
          Label("Messages here are end-to-end encrypted.", systemImage: "lock.fill")
            .font(.footnote).foregroundStyle(Color.mut).padding(.top, 40)
        }
      }
      .padding(.horizontal, 12)
      .padding(.bottom, 8)
    }
    .defaultScrollAnchor(.bottom)
    .scrollDismissesKeyboard(.interactively)
    .background(Color.bg)
    .safeAreaInset(edge: .bottom) { composer }
    .navigationTitle(conv.map(talk.title) ?? "")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { toolbar }
    .onAppear {
      shown = true
      talk.open(convId)
    }
    .onDisappear {
      shown = false
      if talk.activeId == convId { talk.open(nil) }
      cancelRecording()
    }
    // A recording never outlives the open, foreground chat, so the 600 s limit can't send one unseen.
    .onChange(of: scenePhase) { _, p in if p != .active { cancelRecording() } }
    // A call owns the audio session: stop our voice audio the moment one starts or rings.
    .onChange(of: calls.current == nil) { _, idle in
      if !idle {
        cancelRecording()
        VoicePlayback.current?.pause()
      }
    }
    .alert("Couldn’t send", isPresented: .constant(error != nil), presenting: error) { _ in
      Button("OK") { error = nil }
    } message: { Text($0) }
    .alert("Report \((reported?.message.senderId ?? peer).map(talk.name) ?? "")", isPresented: $reporting) {
      TextField("What happened? (optional)", text: $reportNote)
      Button(reported == nil ? "Report with their last messages" : "Report with this message", role: .destructive) { report(quoting: true) }
      Button(reported == nil ? "Report without messages" : "Report without the message", role: .destructive) { report(quoting: false) }
      Button("Cancel", role: .cancel) { reported = nil }
    } message: {
      Text(reported == nil
        ? "Messages are encrypted, so the server’s owner sees only your note, plus their last 10 messages if you choose to include them. Reporting also blocks them."
        : "Messages are encrypted, so the server’s owner sees only your note, plus this message if you choose to include it. Reporting also blocks them.")
    }
    .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: 10, matching: .any(of: [.images, .videos]))
    .onChange(of: photos) { _, items in
      guard !items.isEmpty else { return }
      photos = []
      sendPhotos(items)
    }
    .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
      if case .success(let urls) = r { sendFiles(urls) }
    }
    .fullScreenCover(item: Binding(get: { zoom.map(Zoomed.init) }, set: { zoom = $0?.image })) { z in
      Image(uiImage: z.image).resizable().scaledToFit()
        .frame(maxWidth: .infinity, maxHeight: .infinity).background(.black)
        .overlay(alignment: .topTrailing) {
          Button("Close", systemImage: "xmark") { zoom = nil }.labelStyle(.iconOnly).font(.title2).padding().tint(.white)
        }
    }
  }

  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    if let peer {
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button("Video call", systemImage: "video") { calls.start(convId: convId, peer: peer, kind: "video") }
        Button("Voice call", systemImage: "phone") { calls.start(convId: convId, peer: peer, kind: "audio") }
        Menu("More", systemImage: "ellipsis") {
          if talk.isBlocked(peer) {
            Button("Unblock", systemImage: "hand.raised.slash") { Task { try? await talk.block(peer, false) } }
          } else {
            Button("Block", systemImage: "hand.raised", role: .destructive) { Task { try? await talk.block(peer, true) } }
          }
          Button("Report", systemImage: "exclamationmark.bubble", role: .destructive) { reporting = true }
        }
      }
    }
  }

  private var composer: some View {
    HStack(alignment: .bottom, spacing: 8) {
      if let recorder { recording(recorder) } else { editor }
    }
    .padding(.horizontal, 8).padding(.vertical, 6)
    .background(.bar)
  }

  @ViewBuilder private var editor: some View {
    Menu {
      Button("Photos and videos", systemImage: "photo.on.rectangle") { pickingPhotos = true }
      Button("File", systemImage: "doc") { pickingFiles = true }
    } label: {
      Image(systemName: "plus").font(.title3).frame(width: 44, height: 44)
    }
    .accessibilityLabel("Attach")
    TextField("Message", text: $text, axis: .vertical)
      .lineLimit(1...6)
      .padding(.horizontal, 14).padding(.vertical, 10)
      .background(Color.surface, in: .rect(cornerRadius: 22))
    // Empty composer: the send spot becomes the mic, as in iMessage and on the web.
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      let off = sending || calls.current != nil
      roundButton("Record voice message", "mic.fill", action: record).disabled(off).opacity(off ? 0.4 : 1)
    } else {
      roundButton("Send", "arrow.up", action: sendText).disabled(sending)
    }
  }

  // Replaces the composer while recording: delete, timer, live waveform, send.
  private func recording(_ r: VoiceRecorder) -> some View {
    Group {
      Button("Delete recording", systemImage: "trash", action: cancelRecording)
      .labelStyle(.iconOnly).font(.title3).frame(width: 44, height: 44).tint(Color.danger)
      HStack(spacing: 10) {
        Circle().fill(Color.danger).frame(width: 10, height: 10)
        Text(Duration.seconds(r.elapsed).formatted(.time(pattern: .minuteSecond))).font(.subheadline.weight(.medium)).monospacedDigit()
          .accessibilityLabel("Recording, \(Duration.seconds(r.elapsed).formatted(.time(pattern: .minuteSecond)))")
        // Newest bars on the right, so speech scrolls in like a tape.
        HStack(spacing: 2) {
          ForEach(Array(r.levels.suffix(80).enumerated()), id: \.offset) { _, v in
            Capsule().fill(Color.ink.opacity(0.7)).frame(width: 3, height: 28 * (0.12 + 0.88 * min(1, (v * 4).squareRoot())))
          }
        }
        .frame(maxWidth: .infinity, alignment: .trailing).frame(height: 28).clipped()
        .accessibilityHidden(true)
      }
      .padding(.horizontal, 14).frame(minHeight: 44)
      .background(Color.surface, in: .rect(cornerRadius: 22))
      roundButton("Send voice message", "arrow.up", action: sendVoice)
    }
  }

  private func roundButton(_ label: String, _ icon: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: icon).font(.headline).frame(width: 36, height: 36)
        .background(Color.fill, in: .circle).foregroundStyle(Color.onFill)
    }
    .frame(width: 44, height: 44)
    .accessibilityLabel(label)
  }

  private func date(_ m: Decrypted) -> Date { Date(timeIntervalSince1970: m.message.createdAt / 1000) }

  private func run(_ work: @escaping () async throws -> Void) {
    sending = true
    Task {
      defer { sending = false }
      do { try await work() } catch { self.error = error.localizedDescription }
    }
  }

  private func sendText() {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty else { return }
    text = ""
    run {
      // Put the text back on failure, as the web does, so a refused send isn't lost.
      do { try await talk.send(convId, text: t) } catch { if text.isEmpty { text = t }; throw error }
    }
  }

  private func record() {
    guard !startingRecorder, recorder == nil else { return } // one start in flight
    startingRecorder = true
    Task {
      defer { startingRecorder = false }
      guard await AVAudioApplication.requestRecordPermission() else {
        error = "Allow Talk to use the microphone in Settings to record voice messages."
        return
      }
      // The permission prompt can outlast the chat, the foreground, or the start of a call.
      // (The prompt itself makes the scene inactive, so check for background, not for active.)
      guard shown, UIApplication.shared.applicationState != .background, calls.current == nil else { return }
      do {
        let r = try VoiceRecorder()
        r.onLimit = sendVoice
        recorder = r
      } catch { self.error = error.localizedDescription }
    }
  }

  private func sendVoice() {
    guard let r = recorder else { return }
    recorder = nil
    do {
      let (data, voice) = try r.stop()
      guard voice.duration >= 0.7 else { return } // a mis-tap, not a message
      run { try await talk.send(convId, files: [try await talk.upload(convId, data, name: "Voice message.m4a", type: "audio/mp4", voice: voice)]) }
    } catch { self.error = error.localizedDescription }
  }

  private func cancelRecording() {
    recorder?.cancel()
    recorder = nil
  }

  private func sendPhotos(_ items: [PhotosPickerItem]) {
    run {
      var refs: [FileRef] = []
      for (i, item) in items.enumerated() {
        guard let data = try await item.loadTransferable(type: Data.self) else { continue }
        let type = item.supportedContentTypes.first ?? .jpeg
        let ext = type.preferredFilenameExtension ?? "jpg"
        refs.append(try await talk.upload(convId, data, name: "\(type.conforms(to: .movie) ? "Video" : "Photo") \(i + 1).\(ext)", type: type.preferredMIMEType ?? "image/jpeg"))
      }
      if !refs.isEmpty { try await talk.send(convId, files: refs) }
    }
  }

  private func sendFiles(_ urls: [URL]) {
    run {
      var refs: [FileRef] = []
      for url in urls {
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        refs.append(try await talk.upload(convId, data, name: url.lastPathComponent, type: type))
      }
      if !refs.isEmpty { try await talk.send(convId, files: refs) }
    }
  }

  private func callAgain(_ kind: String) {
    if let peer { calls.start(convId: convId, peer: peer, kind: kind) }
  }

  private func report(quoting: Bool) {
    let one = reported
    reported = nil
    // One long-pressed message reports its sender (groups too); the toolbar reports the DM peer.
    guard let who = one?.message.senderId ?? peer else { return }
    let picked = one.map { [$0] } ?? Array((talk.messages[convId] ?? []).filter { $0.message.senderId == who && $0.content != nil && !$0.forged }.suffix(10))
    // Decrypted here, so the server's owner can see what was said only if the reporter opts in.
    let quotes = quoting ? picked.filter { $0.content != nil }.map {
      "[\(Date(timeIntervalSince1970: $0.message.createdAt / 1000).formatted(date: .abbreviated, time: .shortened))] \(Format.preview($0.content, mine: false))"
    } : []
    let note = Report.note(reportNote, quoting: quotes)
    reportNote = ""
    Task {
      do { try await talk.report(who, convId: convId, note: note) } catch { self.error = error.localizedDescription }
    }
  }
}

private struct Zoomed: Identifiable {
  let image: UIImage
  var id: ObjectIdentifier { ObjectIdentifier(image) }
}

private struct MessageRow: View {
  @Environment(Talk.self) private var talk
  let convId: String
  let m: Decrypted
  let group: Bool
  let first: Bool
  let onCall: (String) -> Void
  let onZoom: (UIImage) -> Void
  let onReport: (Decrypted) -> Void

  var body: some View {
    let mine = m.message.senderId == talk.account.userId
    if let call = m.content?.call {
      let s = Format.call(call, mine: mine)
      VStack(spacing: 6) {
        Label {
          Text([s.title, s.detail, Format.shortTime(m.message.createdAt)].compactMap { $0 }.joined(separator: " · "))
        } icon: {
          Image(systemName: call.kind == "audio" ? "phone" : "video")
        }
        .font(.footnote).foregroundStyle(s.missed ? Color.danger : Color.mut)
        if call.room == nil {
          Button(mine ? "Call again" : "Call back") { onCall(call.kind ?? "audio") }
            .font(.footnote.weight(.semibold)).buttonStyle(.bordered).buttonBorderShape(.capsule).tint(Color.accent)
        }
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 8)
    } else {
      VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
        if group && !mine && first {
          Text(talk.name(m.message.senderId)).font(.caption.weight(.semibold)).foregroundStyle(Color.mut).padding(.horizontal, 12)
        }
        if let c = m.content {
          ForEach(c.files ?? [], id: \.id) { f in Attachment(convId: convId, file: f, mine: mine, onZoom: onZoom) }
          if let t = c.text, !t.isEmpty {
            Text(linked(t))
              .padding(.horizontal, 14).padding(.vertical, 9)
              .background(mine ? Color.mine : Color.bubble, in: .rect(cornerRadius: 20))
              .foregroundStyle(Color.ink)
              .textSelection(.enabled)
          }
          if m.forged {
            Label("Sender doesn’t match. Don’t trust this message.", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(Color.danger)
          }
        } else {
          Label("Couldn’t decrypt this message.", systemImage: "lock.slash").font(.footnote).foregroundStyle(Color.mut)
            .padding(.horizontal, 14).padding(.vertical, 9).background(Color.bubble, in: .rect(cornerRadius: 20))
        }
      }
      .contextMenu {
        if !mine {
          if let t = m.content?.text, !t.isEmpty {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = t }
          }
          Button("Report…", systemImage: "exclamationmark.bubble", role: .destructive) { onReport(m) }
        }
      }
      .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
      .padding(mine ? .leading : .trailing, 48)
    }
  }

  private func linked(_ s: String) -> AttributedString {
    var a = AttributedString(s)
    let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    for match in detector?.matches(in: s, range: NSRange(s.startIndex..., in: s)) ?? [] {
      guard let url = match.url, let r = Range(match.range, in: s), let ar = Range(r, in: a) else { continue }
      a[ar].link = url
      a[ar].underlineStyle = .single
    }
    return a
  }
}

private struct Attachment: View {
  @Environment(Talk.self) private var talk
  @Environment(Calls.self) private var calls
  let convId: String
  let file: FileRef
  let mine: Bool
  let onZoom: (UIImage) -> Void
  @State private var data: Data?
  @State private var failed = false
  @State private var playback = VoicePlayback()
  @State private var unplayable = false

  var body: some View {
    Group {
      if file.type.hasPrefix("image/"), let data, let img = UIImage(data: data) {
        Button { onZoom(img) } label: {
          Image(uiImage: img).resizable().scaledToFill().frame(maxWidth: 260, maxHeight: 320).clipShape(.rect(cornerRadius: 16))
        }
        .accessibilityLabel("Open \(file.name)")
      } else if file.voice != nil {
        voice
      } else if file.type.hasPrefix("image/") && data == nil && !failed {
        RoundedRectangle(cornerRadius: 16).fill(Color.raised).frame(width: 240, height: 180).overlay { ProgressView() }
      } else {
        chip
      }
    }
    .task(id: file.id) { await load() }
  }

  private var voice: some View {
    let v = file.voice!
    let dur = min(max(v.duration, 0.1), 3600) // from the sender; Duration.seconds traps on huge values
    // Older web recordings are Opus (in WebM, or in mp4 from Chrome), which AVAudioPlayer can't play.
    let cantPlay = unplayable || file.type.contains("webm") || file.type.contains("opus")
    let inCall = calls.current != nil
    return VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
      // Per-frame redraw only while playing; the player's position isn't observable.
      TimelineView(.animation(paused: !playback.playing)) { _ in
        let at = playback.time
        let filled = Int((min(1, at / dur) * Double(v.peaks.count)).rounded())
        HStack(spacing: 10) {
          Button(failed ? "Retry" : playback.playing ? "Pause" : "Play", systemImage: failed ? "arrow.clockwise" : playback.playing ? "pause.fill" : "play.fill") { toggle() }
            .labelStyle(.iconOnly).font(.title3).frame(width: 36, height: 36)
            .disabled((data == nil && !failed) || cantPlay || inCall).opacity(cantPlay || inCall ? 0.35 : 1)
          HStack(spacing: 2) {
            ForEach(Array(v.peaks.enumerated()), id: \.offset) { i, p in
              Capsule().fill(Color.ink.opacity(i < filled ? 1 : 0.35)).frame(width: 3, height: max(3, 28 * min(p, 1)))
            }
          }
          .accessibilityHidden(true)
          Text(Duration.seconds(playback.playing || at > 0 ? at : dur).formatted(.time(pattern: .minuteSecond))).font(.caption).monospacedDigit()
        }
      }
      .padding(.horizontal, 10).padding(.vertical, 6)
      .background(mine ? Color.mine : Color.bubble, in: .capsule)
      .foregroundStyle(Color.ink)
      if cantPlay {
        Text("Recorded in a format iPhone can’t play. Open it on the web.").font(.caption).foregroundStyle(Color.mut)
      } else if inCall {
        Text("Plays after the call.").font(.caption).foregroundStyle(Color.mut)
      } else if failed {
        Text("Couldn’t load. Tap to retry.").font(.caption).foregroundStyle(Color.mut)
      }
    }
  }

  private var chip: some View {
    HStack(spacing: 10) {
      Image(systemName: failed ? "exclamationmark.triangle" : "doc").font(.title3)
      VStack(alignment: .leading) {
        Text(file.name).lineLimit(1)
        Text(failed ? "Couldn’t load. Tap to retry." : Format.size(file.size)).font(.caption).foregroundStyle(Color.mut)
      }
      if let data { ShareLink(item: DataFile(data: data, name: file.name), preview: SharePreview(file.name)) { Image(systemName: "square.and.arrow.up") } }
    }
    .padding(12)
    .background(mine ? Color.mine : Color.bubble, in: .rect(cornerRadius: 16))
    .foregroundStyle(Color.ink)
    .onTapGesture { if failed { failed = false; Task { await load() } } }
  }

  private func load() async {
    guard data == nil, file.size <= 25 * 1024 * 1024 || file.voice != nil else { return }
    do { data = try await talk.file(convId, file) } catch { failed = true }
  }

  private func toggle() {
    if failed { failed = false; Task { await load() }; return }
    guard let data else { return }
    do { try playback.toggle(data) } catch { unplayable = true }
  }
}

// AVAudioPlayer isn't observable, so this mirrors play/pause for SwiftUI and rewinds at the end.
@Observable final class VoicePlayback: NSObject, AVAudioPlayerDelegate {
  @ObservationIgnored private(set) static weak var current: VoicePlayback? // one voice message plays at a time
  private(set) var playing = false
  private var player: AVAudioPlayer?
  var time: Double { player?.currentTime ?? 0 }

  func toggle(_ data: Data) throws {
    if playing { return pause() }
    // A call owns the audio session, and playback would steal a recording's.
    guard Calls.shared.current == nil, VoiceRecorder.current == nil else { return }
    if player == nil {
      let p = try AVAudioPlayer(data: data)
      // Opus in mp4 opens but reports no length and plays nothing.
      guard p.duration >= 0.1 else { throw CocoaError(.fileReadCorruptFile) }
      p.delegate = self
      player = p
    }
    if let c = Self.current, c !== self { c.pause() }
    Self.current = self
    try? AVAudioSession.sharedInstance().setCategory(.playback)
    try? AVAudioSession.sharedInstance().setActive(true)
    playing = player?.play() ?? false
    if !playing { releaseVoiceAudio() }
  }

  func pause() {
    guard playing else { return }
    player?.pause()
    playing = false
    releaseVoiceAudio()
  }

  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    Task { @MainActor in
      self.player?.currentTime = 0
      playing = false
      releaseVoiceAudio()
    }
  }

  // Leaving the chat mid-message frees the player; give the session back so music resumes.
  isolated deinit { if playing { releaseVoiceAudio() } }
}

// Hands the audio session back so the user's music resumes; never during a call, which owns it.
func releaseVoiceAudio() {
  guard Calls.shared.current == nil else { return }
  try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
}

// Records a voice message the way src/lib/voice.ts does: AAC in .m4a (audio/mp4) at 48 kbps,
// loudness sampled every 50 ms for the waveform, at most ten minutes.
@Observable final class VoiceRecorder {
  @ObservationIgnored private(set) static weak var current: VoiceRecorder? // the one recording now, if any
  private(set) var levels: [Double] = []
  private(set) var elapsed = 0.0
  @ObservationIgnored var onLimit: (() -> Void)?
  @ObservationIgnored private let rec: AVAudioRecorder
  @ObservationIgnored private var timer: Timer?
  @ObservationIgnored private let url: URL
  @ObservationIgnored private var done = false

  init() throws {
    guard Calls.shared.current == nil else { throw APIError(status: 0, message: "You can’t record during a call.") }
    VoicePlayback.current?.pause()
    let url = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).m4a")
    self.url = url
    try AVAudioSession.sharedInstance().setCategory(.playAndRecord, options: .defaultToSpeaker)
    try AVAudioSession.sharedInstance().setActive(true)
    do {
      rec = try AVAudioRecorder(url: url, settings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 48_000,
      ])
      rec.isMeteringEnabled = true
      guard rec.record() else { throw APIError(status: 0, message: "Couldn’t start recording.") }
    } catch {
      try? FileManager.default.removeItem(at: url)
      releaseVoiceAudio()
      throw error
    }
    Self.current = self
    // Auto-Lock makes the scene inactive, which cancels the recording; keep the screen on instead.
    UIApplication.shared.isIdleTimerDisabled = true
    timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.sample() }
    }
  }

  isolated deinit { cancel() }

  private func sample() {
    rec.updateMeters()
    levels.append(pow(10, Double(rec.averagePower(forChannel: 0)) / 20)) // dB -> RMS amplitude, like the web's analyser
    elapsed = rec.currentTime
    if elapsed >= 600 { onLimit?() }
  }

  func stop() throws -> (Data, Voice) {
    let duration = (rec.currentTime * 10).rounded() / 10
    finish()
    defer { try? FileManager.default.removeItem(at: url) }
    return (try Data(contentsOf: url), Voice(duration: duration, peaks: Voice.bucket(levels)))
  }

  func cancel() {
    guard !done else { return }
    finish()
    try? FileManager.default.removeItem(at: url)
  }

  // Runs once: stops the clock and the mic, then gives the audio session back.
  private func finish() {
    guard !done else { return }
    done = true
    timer?.invalidate()
    onLimit = nil
    rec.stop()
    if Self.current === self { Self.current = nil }
    UIApplication.shared.isIdleTimerDisabled = false
    releaseVoiceAudio()
  }
}

// Shares decrypted bytes as a file with its real name.
struct DataFile: Transferable {
  let data: Data
  let name: String
  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(exportedContentType: .data) { f in
      let url = FileManager.default.temporaryDirectory.appending(path: f.name)
      try f.data.write(to: url)
      return SentTransferredFile(url)
    }
  }
}
