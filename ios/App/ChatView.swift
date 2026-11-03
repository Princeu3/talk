import AVFoundation
import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ChatView: View {
  @Environment(Talk.self) private var talk
  @Environment(Calls.self) private var calls
  @Environment(\.dismiss) private var dismiss
  let convId: String
  @State private var text = ""
  @State private var photos: [PhotosPickerItem] = []
  @State private var pickingPhotos = false
  @State private var pickingFiles = false
  @State private var sending = false
  @State private var error: String?
  @State private var reported: Decrypted? // the long-pressed message being reported
  @State private var zoom: UIImage?
  @State private var recorder: VoiceRecorder?
  @State private var startingRecorder = false
  @State private var shown = false
  @State private var replying: Decrypted?
  @State private var editing: Decrypted?
  @State private var deleting: Decrypted?
  @State private var forwarding: Decrypted?
  @State private var reactionsOf: Decrypted?
  @State private var flash: Int? // a quoted message just scrolled to
  @State private var info = false
  @FocusState private var focused: Bool
  @Environment(\.scenePhase) private var scenePhase

  private var conv: Conversation? { talk.me?.conversations.first { $0.id == convId } }
  private var peer: String? { conv.flatMap(talk.peer) }

  var body: some View {
    let list = talk.messages[convId] ?? []
    let queued = talk.pending.filter { $0.convId == convId }
    let newest = list.last { $0.message.senderId == talk.account.userId && !$0.system && $0.content?.call == nil }
    ScrollViewReader { proxy in
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
            let gap = prev.map { breaks($0, m) } ?? true
            MessageRow(convId: convId, m: m, group: conv?.kind == "group", first: gap, flashing: flash == m.id, onCall: callAgain, onZoom: { zoom = $0 }) {
              act($0, on: m, proxy)
            }
              .padding(.top, gap ? 8 : 0)
              .id(m.id)
            if m.id == newest?.id {
              Text(receipt(m)).font(.caption).foregroundStyle(Color.mut)
                .frame(maxWidth: .infinity, alignment: .trailing).padding(.horizontal, 4).padding(.top, 2)
            }
          }
          ForEach(queued) { p in PendingRow(convId: convId, p: p, onCall: callAgain, onZoom: { zoom = $0 }) }
          TypingRow(convId: convId, group: conv?.kind == "group")
          if list.isEmpty, queued.isEmpty, conv != nil {
            Label("Messages here are end-to-end encrypted.", systemImage: "lock.fill")
              .font(.footnote).foregroundStyle(Color.mut).padding(.top, 40)
          }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
      }
    }
    .defaultScrollAnchor(.bottom)
    .scrollDismissesKeyboard(.interactively)
    .background(Color.bg)
    .safeAreaInset(edge: .bottom) { composer }
    .safeAreaInset(edge: .top, spacing: 0) { if let live = conv?.call { CallBanner(convId: convId, call: live) } }
    .navigationTitle(conv.map(talk.title) ?? "")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { toolbar }
    .navigationDestination(isPresented: $info) { ChatInfoView(convId: convId) }
    .onAppear {
      shown = true
      talk.open(convId)
    }
    .onDisappear {
      shown = false
      if talk.activeId == convId { talk.open(nil) }
      cancelRecording()
    }
    // Left the group or removed from it: nothing to show here any more.
    .onChange(of: conv == nil) { _, gone in if gone { dismiss() } }
    .onChange(of: text) { _, t in if editing == nil, !t.isEmpty { talk.sendTyping(convId) } }
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
    .modifier(ReportAlert(convId: convId, who: reported?.message.senderId, one: reported,
                          isPresented: Binding { reported != nil } set: { if !$0 { reported = nil } }))
    .confirmationDialog("Delete for everyone?", isPresented: Binding { deleting != nil } set: { if !$0 { deleting = nil } },
                        titleVisibility: .visible, presenting: deleting) { d in
      Button("Delete", role: .destructive) { run { try await talk.unsend(d) } }
    } message: { _ in Text("It disappears for everyone in this chat.") }
    .sheet(item: $forwarding) { d in
      ForwardSheet { target in
        forwarding = nil
        run { try await talk.forward(d, to: target) }
      }
    }
    .sheet(item: $reactionsOf) { ReactionsSheet(m: $0) }
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
    // The header opens chat info, where block, report, mute and the members live.
    ToolbarItem(placement: .principal) {
      Button { info = true } label: { header }
        .buttonStyle(.plain)
        .accessibilityHint("Shows chat info")
    }
    // Not in a DM whose other account was deleted: nobody to call.
    if peer != nil || conv?.kind == "group" {
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button("Video call", systemImage: "video") { callAgain("video") }
        Button("Voice call", systemImage: "phone") { callAgain("audio") }
      }
    }
  }

  @ViewBuilder private var header: some View {
    if let conv {
      HStack(spacing: 8) {
        Avatar(name: talk.title(conv), size: 32)
        VStack(alignment: .leading, spacing: 0) {
          Text(talk.title(conv)).font(.headline).lineLimit(1)
          Subtitle(conv: conv, group: peer == nil)
        }
      }
      .accessibilityElement(children: .combine)
    }
  }

  private var composer: some View {
    VStack(spacing: 4) {
      if let d = editing ?? replying { bar(d) }
      HStack(alignment: .bottom, spacing: 8) {
        if let recorder { recording(recorder) } else { editor }
      }
    }
    .padding(.horizontal, 8).padding(.vertical, 6)
    .background(.bar)
  }

  // Above the composer while replying or editing: an accent line, who (or "Editing"), one line of the message, X.
  private func bar(_ d: Decrypted) -> some View {
    HStack(spacing: 10) {
      Capsule().fill(Color.accent).frame(width: 3)
      VStack(alignment: .leading, spacing: 2) {
        Text(editing != nil ? "Editing" : talk.who(d.message.senderId)).font(.subheadline.weight(.semibold))
        Text(Format.preview(d.content, mine: d.message.senderId == talk.account.userId)).font(.subheadline).foregroundStyle(Color.mut).lineLimit(1)
      }
      Spacer()
      Button(editing != nil ? "Cancel editing" : "Cancel reply", systemImage: "xmark", action: cancelCompose)
      .labelStyle(.iconOnly).frame(width: 44, height: 44).foregroundStyle(Color.mut)
    }
    .fixedSize(horizontal: false, vertical: true)
    .padding(.leading, 12)
  }

  @ViewBuilder private var editor: some View {
    Menu {
      Button("Photos and videos", systemImage: "photo.on.rectangle") { pickingPhotos = true }
      Button("File", systemImage: "doc") { pickingFiles = true }
    } label: {
      Image(systemName: "plus").font(.title3).frame(width: 44, height: 44)
    }
    .accessibilityLabel("Attach")
    .disabled(editing != nil)
    TextField("Message", text: $text, axis: .vertical)
      .lineLimit(1...6)
      .focused($focused)
      .padding(.horizontal, 14).padding(.vertical, 10)
      .background(Color.surface, in: .rect(cornerRadius: 22))
    // Empty composer: the send spot becomes the mic, as in iMessage and on the web.
    let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    if empty && editing == nil {
      let off = sending || calls.current != nil
      roundButton("Record voice message", "mic.fill", action: record).disabled(off).opacity(off ? 0.4 : 1)
    } else if editing != nil {
      roundButton("Save edit", "checkmark", action: sendText).disabled(sending || empty)
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
        // Newest bars on the right, so speech scrolls in like a tape. A Canvas takes only the width
        // it's given; a row of bar views asked for all 80 bars' width and pushed the screen wider.
        let levels = r.levels
        Canvas { ctx, size in
          for (i, v) in levels.suffix(Int(size.width / 5)).reversed().enumerated() {
            let h = size.height * (0.12 + 0.88 * min(1, (v * 4).squareRoot()))
            let bar = CGRect(x: size.width - CGFloat(i + 1) * 5 + 2, y: (size.height - h) / 2, width: 3, height: h)
            ctx.fill(Path(roundedRect: bar, cornerRadius: 1.5), with: .color(Color.ink.opacity(0.7)))
          }
        }
        .frame(maxWidth: .infinity).frame(height: 28)
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
    if let d = editing {
      editing = nil
      guard t != d.content?.text else { return }
      return run {
        do { try await talk.edit(d, text: t) } catch { if text.isEmpty { text = t; editing = d }; throw error }
      }
    }
    let reply = takeReply()
    run {
      // Network trouble leaves it queued; only a failure to seal puts the text back.
      do { try await talk.send(convId, text: t, reply: reply) } catch { if text.isEmpty { text = t }; throw error }
    }
  }

  // The reply bar's message, quoted in whatever is sent next.
  private func takeReply() -> Reply? {
    defer { replying = nil }
    return replying.map { Format.reply($0, mine: $0.message.senderId == talk.account.userId) }
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
      let reply = takeReply()
      run { try await talk.send(convId, files: [try await talk.upload(convId, data, name: "Voice message.m4a", type: "audio/mp4", voice: voice)], reply: reply) }
    } catch { self.error = error.localizedDescription }
  }

  private func cancelRecording() {
    recorder?.cancel()
    recorder = nil
  }

  private func sendPhotos(_ items: [PhotosPickerItem]) {
    let reply = takeReply()
    run {
      var refs: [FileRef] = []
      for (i, item) in items.enumerated() {
        guard let data = try await item.loadTransferable(type: Data.self) else { continue }
        let type = item.supportedContentTypes.first ?? .jpeg
        let ext = type.preferredFilenameExtension ?? "jpg"
        refs.append(try await talk.upload(convId, data, name: "\(type.conforms(to: .movie) ? "Video" : "Photo") \(i + 1).\(ext)", type: type.preferredMIMEType ?? "image/jpeg"))
      }
      if !refs.isEmpty { try await talk.send(convId, files: refs, reply: reply) }
    }
  }

  private func sendFiles(_ urls: [URL]) {
    let reply = takeReply()
    run {
      var refs: [FileRef] = []
      for url in urls {
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        refs.append(try await talk.upload(convId, data, name: url.lastPathComponent, type: type))
      }
      if !refs.isEmpty { try await talk.send(convId, files: refs, reply: reply) }
    }
  }

  private func callAgain(_ kind: String) { calls.start(convId: convId, kind: kind) }

  // A new run of bubbles: a pause of 5 minutes, another sender, or after an event line.
  // Its own function: inline in the body, it was too slow for CI's compiler to type-check.
  private func breaks(_ a: Decrypted, _ b: Decrypted) -> Bool {
    b.message.createdAt - a.message.createdAt > 5 * 60_000 || a.message.senderId != b.message.senderId || a.system
  }

  // Out of editing (its text goes) and replying.
  private func cancelCompose() {
    if editing != nil { text = "" }
    editing = nil
    replying = nil
  }

  private func act(_ a: RowAction, on m: Decrypted, _ proxy: ScrollViewProxy) {
    switch a {
    case .react(let e): run { try await talk.react(m, e) }
    case .reactions: reactionsOf = m
    case .reply:
      cancelCompose()
      replying = m
      focused = true
    case .edit:
      replying = nil
      editing = m
      text = m.content?.text ?? ""
      focused = true
    case .forward: forwarding = m
    case .delete: deleting = m
    case .report: reported = m
    case .quote(let id):
      guard isLoaded(id) else { return } // not loaded (or unsent): the quote is all there is
      withAnimation { proxy.scrollTo(id, anchor: .center) }
      flash = id
      Task {
        try? await Task.sleep(for: .seconds(1.2))
        if flash == id { flash = nil }
      }
    }
  }

  private func isLoaded(_ id: Int) -> Bool { talk.messages[convId]?.contains { $0.id == id } == true }

  // Under your newest message: whether, or by whom, it's been read.
  private func receipt(_ m: Decrypted) -> String {
    guard let conv else { return "" }
    let readers = conv.members.filter { $0 != talk.account.userId && (conv.reads?[$0] ?? 0) >= m.id }
    if readers.isEmpty { return "Sent" }
    if conv.kind == "dm" { return "Read" }
    return readers.count <= 3 ? "Read by " + readers.map(talk.name).joined(separator: ", ") : "Read by \(readers.count)"
  }
}

// Reports someone: one long-pressed message, or with none, their last 10 here. Reporting also blocks them.
struct ReportAlert: ViewModifier {
  @Environment(Talk.self) private var talk
  let convId: String
  let who: String?
  let one: Decrypted?
  @Binding var isPresented: Bool
  @State private var note = ""
  @State private var error: String?

  func body(content: Content) -> some View {
    content
      .alert("Report \(who.map(talk.name) ?? "")", isPresented: $isPresented) {
        TextField("What happened? (optional)", text: $note)
        Button(one == nil ? "Report with their last messages" : "Report with this message", role: .destructive) { report(quoting: true) }
        Button(one == nil ? "Report without messages" : "Report without the message", role: .destructive) { report(quoting: false) }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text(one == nil
          ? "Messages are encrypted, so the server’s owner sees only your note, plus their last 10 messages if you choose to include them. Reporting also blocks them."
          : "Messages are encrypted, so the server’s owner sees only your note, plus this message if you choose to include it. Reporting also blocks them.")
      }
      .alert("Couldn’t report", isPresented: .constant(error != nil), presenting: error) { _ in
        Button("OK") { error = nil }
      } message: { Text($0) }
  }

  private func report(quoting: Bool) {
    guard let who else { return }
    let picked = one.map { [$0] } ?? Array((talk.messages[convId] ?? []).filter { $0.message.senderId == who && $0.content != nil && !$0.forged }.suffix(10))
    // Decrypted here, so the server's owner can see what was said only if the reporter opts in.
    let quotes = quoting ? picked.filter { $0.content != nil }.map {
      "[\(Date(timeIntervalSince1970: $0.message.createdAt / 1000).formatted(date: .abbreviated, time: .shortened))] \(Format.preview($0.content, mine: false))"
    } : []
    let text = Report.note(note, quoting: quotes)
    note = ""
    Task {
      do { try await talk.report(who, convId: convId, note: text) } catch { self.error = error.localizedDescription }
    }
  }
}

private struct Zoomed: Identifiable {
  let image: UIImage
  var id: ObjectIdentifier { ObjectIdentifier(image) }
}

// A group call on now, under the header: join it, or go back to it.
private struct CallBanner: View {
  @Environment(Calls.self) private var calls
  let convId: String
  let call: GroupCall

  var body: some View {
    let inIt = calls.current.map { $0.convId == convId && $0.phase != .incoming && $0.phase != .ended } ?? false
    let n = call.peers.count
    HStack(spacing: 10) {
      Image(systemName: call.kind == "video" ? "video.fill" : "phone.fill").foregroundStyle(Color.acceptCall)
      Text("\(Format.callNoun(call.kind, group: true)) · \(n) \(n == 1 ? "person" : "people")")
        .font(.subheadline).lineLimit(1)
      Spacer()
      JoinPill(label: inIt ? "Return to call" : "Join") { calls.start(convId: convId, kind: call.kind) }
    }
    .padding(.horizontal, 12).padding(.vertical, 8)
    .background(.bar)
  }
}

// An unsent message: sending, or failed with retry and delete.
private struct PendingRow: View {
  @Environment(Talk.self) private var talk
  let convId: String
  let p: Pending
  let onCall: (String) -> Void
  let onZoom: (UIImage) -> Void

  var body: some View {
    VStack(alignment: .trailing, spacing: 0) {
      MessageRow(convId: convId, m: talk.shown(p), group: false, first: false, onCall: onCall, onZoom: onZoom) { _ in }
      if p.sending {
        Text("Sending…").font(.caption).foregroundStyle(Color.mut).padding(.horizontal, 4).padding(.vertical, 4)
      } else {
        HStack(spacing: 16) {
          if let error = p.error {
            Button(error + " Tap to retry.") { talk.retry(p) }
              .foregroundStyle(Color.danger)
          } else {
            Text("Waiting for connection").foregroundStyle(Color.mut)
          }
          Button("Delete", role: .destructive) { talk.discard(p) }
            .foregroundStyle(Color.mut)
        }
        .font(.caption).padding(.horizontal, 4).frame(minHeight: 32)
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
}

enum RowAction { case reply, edit, forward, delete, report, reactions, react(String), quote(Int) }

private struct MessageRow: View {
  @Environment(Talk.self) private var talk
  let convId: String
  let m: Decrypted
  let group: Bool
  let first: Bool
  var flashing = false
  let onCall: (String) -> Void
  let onZoom: (UIImage) -> Void
  let onAction: (RowAction) -> Void
  @State private var drag: CGFloat = 0

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
          let live = talk.me?.conversations.first { $0.id == convId }?.call != nil
          Button(call.group == true ? (live ? "Join" : "Call") : mine ? "Call again" : "Call back") { onCall(call.kind ?? "audio") }
            .font(.footnote.weight(.semibold)).buttonStyle(.bordered).buttonBorderShape(.capsule).tint(Color.accent)
        }
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 8)
    } else if m.system {
      Text(m.content?.text ?? "").font(.caption).foregroundStyle(Color.mut).multilineTextAlignment(.center)
        .frame(maxWidth: .infinity).padding(.vertical, 6)
    } else {
      VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
        if group && !mine && first {
          Text(talk.name(m.message.senderId)).font(.caption.weight(.semibold)).foregroundStyle(Color.mut).padding(.horizontal, 12)
        }
        if let c = m.content {
          if c.forwarded == true {
            Label("Forwarded", systemImage: "arrowshape.turn.up.right").font(.caption).foregroundStyle(Color.mut).padding(.horizontal, 12)
          }
          if let r = c.reply { quote(r) }
          ForEach(c.files ?? [], id: \.id) { f in Attachment(convId: convId, file: f, mine: mine, onZoom: onZoom) }
          // No text selection: a long press opens the message menu, which has Copy.
          if let t = c.text, !t.isEmpty {
            Text(linked(t))
              .padding(.horizontal, 14).padding(.vertical, 9)
              .background(mine ? Color.mine : Color.bubble, in: .rect(cornerRadius: 20))
              .foregroundStyle(Color.ink)
          }
          if !m.reactions.isEmpty { pills }
          if m.message.editedAt != nil {
            Text("Edited").font(.caption).foregroundStyle(Color.mut).padding(.horizontal, 12)
          }
          if m.forged {
            Label("Sender doesn’t match. Don’t trust this message.", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(Color.danger)
          }
        } else {
          Label("Couldn’t decrypt this message.", systemImage: "lock.slash").font(.footnote).foregroundStyle(Color.mut)
            .padding(.horizontal, 14).padding(.vertical, 9).background(Color.bubble, in: .rect(cornerRadius: 20))
        }
      }
      .background(Color.accent.opacity(flashing ? 0.25 : 0), in: .rect(cornerRadius: 20))
      .animation(.easeOut(duration: 0.6), value: flashing)
      .offset(x: drag)
      .background(alignment: .leading) {
        Image(systemName: "arrowshape.turn.up.left.fill").foregroundStyle(Color.mut)
          .opacity(min(1, drag / 60)).offset(x: drag / 2 - 10).accessibilityHidden(true)
      }
      .contextMenu { menu(mine) }
      .simultaneousGesture(swipe, including: m.message.id != 0 && m.content != nil ? .all : .subviews)
      .sensoryFeedback(.impact(weight: .light), trigger: drag >= 60) { !$0 && $1 }
      .accessibilityAction(named: "Reply") { onAction(.reply) }
      .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
      .padding(mine ? .leading : .trailing, 48)
    }
  }

  // Reactions first, then the actions; your own messages can be edited (15 min) and deleted.
  @ViewBuilder private func menu(_ mine: Bool) -> some View {
    if m.message.id != 0 { // a pending row has no id to act on yet
      if let c = m.content {
        ControlGroup {
          ForEach(Talk.emoji, id: \.self) { e in
            Button { onAction(.react(e)) } label: { Text(e) }
          }
        }
        .controlGroupStyle(.palette)
        .menuActionDismissBehavior(.enabled) // palettes stay open by default; one pick is the whole job
        Button("Reply", systemImage: "arrowshape.turn.up.left") { onAction(.reply) }
        if let t = c.text, !t.isEmpty {
          Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = t }
        }
        Button("Forward", systemImage: "arrowshape.turn.up.right") { onAction(.forward) }
        if mine, c.text?.isEmpty == false, Date().timeIntervalSince1970 * 1000 - m.message.createdAt < 15 * 60_000 {
          Button("Edit", systemImage: "pencil") { onAction(.edit) }
        }
      }
      if mine {
        Button("Delete", systemImage: "trash", role: .destructive) { onAction(.delete) }
      } else {
        Button("Report…", systemImage: "exclamationmark.bubble", role: .destructive) { onAction(.report) }
      }
    }
  }

  // Swipe right to reply; mostly-vertical drags stay with the scroll view.
  private var swipe: some Gesture {
    DragGesture(minimumDistance: 20)
      .onChanged { v in
        guard v.translation.width > 0, v.translation.width > abs(v.translation.height) * 2 else { return }
        drag = min(v.translation.width, 80)
      }
      .onEnded { _ in
        if drag >= 60 { onAction(.reply) }
        withAnimation(.spring(duration: 0.3)) { drag = 0 }
      }
  }

  private func quote(_ r: Reply) -> some View {
    let who = talk.who(r.from)
    return Button { onAction(.quote(r.id)) } label: {
      HStack(spacing: 8) {
        Capsule().fill(Color.accent).frame(width: 3)
        VStack(alignment: .leading, spacing: 2) {
          Text(who).font(.caption.weight(.semibold))
          Text(r.preview).font(.caption).foregroundStyle(Color.mut).lineLimit(2)
        }
      }
      .fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, 10).padding(.vertical, 6)
      .background(Color.raised, in: .rect(cornerRadius: 14))
    }
    .buttonStyle(.plain)
    .foregroundStyle(Color.ink)
    .accessibilityLabel("Reply to \(who): \(r.preview)")
    .accessibilityHint("Shows the original message")
  }

  // One pill per emoji with its count, tucked under the bubble's edge; yours is outlined.
  private var pills: some View {
    let counts = Dictionary(grouping: m.reactions.values) { $0 }.map { (emoji: $0.key, n: $0.value.count) }
      .sorted { (Talk.emoji.firstIndex(of: $0.emoji) ?? 99, $0.emoji) < (Talk.emoji.firstIndex(of: $1.emoji) ?? 99, $1.emoji) }
    let yours = m.reactions[talk.account.userId]
    return Button { onAction(.reactions) } label: {
      HStack(spacing: 4) {
        ForEach(counts, id: \.emoji) { r in
          Text(r.n > 1 ? "\(r.emoji) \(r.n)" : r.emoji).font(.footnote).monospacedDigit()
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(r.emoji == yours ? Color.mine : Color.surface, in: .capsule)
            .overlay { Capsule().strokeBorder(r.emoji == yours ? Color.accent : Color.bg, lineWidth: 1.5) }
        }
      }
    }
    .buttonStyle(.plain)
    .foregroundStyle(Color.ink)
    .padding(.top, -10).padding(.horizontal, 8)
    .accessibilityLabel("Reactions: " + counts.map { "\($0.emoji) \($0.n)" }.joined(separator: ", "))
    .accessibilityHint("Shows who reacted")
  }

  private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

  private func linked(_ s: String) -> AttributedString {
    var a = AttributedString(s)
    for match in Self.detector?.matches(in: s, range: NSRange(s.startIndex..., in: s)) ?? [] {
      guard let url = match.url, let r = Range(match.range, in: s), let ar = Range(r, in: a) else { continue }
      a[ar].link = url
      a[ar].underlineStyle = .single
    }
    return a
  }
}

// Typing reads live in these two small views, so each typing signal redraws them, not the whole thread.
private struct TypingRow: View {
  @Environment(Talk.self) private var talk
  let convId: String
  let group: Bool

  var body: some View {
    let typers = talk.typers(convId)
    if !typers.isEmpty { TypingBubble().accessibilityLabel(Format.typing(typers.map(talk.name), group: group)) }
  }
}

// Under the header's title: who's typing, else the members (group) or the encryption note.
private struct Subtitle: View {
  @Environment(Talk.self) private var talk
  let conv: Conversation
  let group: Bool

  var body: some View {
    let typers = talk.typers(conv.id)
    Text(!typers.isEmpty ? Format.typing(typers.map(talk.name), group: group)
         : group ? conv.members.filter { $0 != talk.account.userId }.map(talk.name).joined(separator: ", ")
         : "End-to-end encrypted")
      .font(.caption).foregroundStyle(Color.mut).lineLimit(1)
  }
}

// Three dots taking turns at the bottom of the thread while someone types.
private struct TypingBubble: View {
  var body: some View {
    TimelineView(.periodic(from: .now, by: 0.4)) { t in
      let on = Int(t.date.timeIntervalSinceReferenceDate / 0.4) % 3
      HStack(spacing: 4) {
        ForEach(0..<3, id: \.self) { i in Circle().fill(Color.mut).frame(width: 8, height: 8).opacity(i == on ? 1 : 0.35) }
      }
      .padding(.horizontal, 14).padding(.vertical, 13)
      .background(Color.bubble, in: .rect(cornerRadius: 20))
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.top, 8)
    .accessibilityElement()
  }
}

private struct ForwardSheet: View {
  @Environment(Talk.self) private var talk
  @Environment(\.dismiss) private var dismiss
  let onPick: (String) -> Void

  var body: some View {
    NavigationStack {
      List(talk.me?.conversations ?? []) { c in
        Button { onPick(c.id) } label: {
          HStack(spacing: 12) {
            Avatar(name: talk.title(c), size: 40)
            Text(talk.title(c)).foregroundStyle(Color.ink)
          }
        }
      }
      .navigationTitle("Forward to")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }
    .tint(Color.accent)
  }
}

// Who reacted with what; your own row takes yours back.
private struct ReactionsSheet: View {
  @Environment(Talk.self) private var talk
  @Environment(\.dismiss) private var dismiss
  let m: Decrypted

  var body: some View {
    let live = talk.messages[m.message.convId]?.first { $0.id == m.id } ?? m
    let me = talk.account.userId
    let rows = live.reactions.sorted { $0.key == me || ($1.key != me && talk.name($0.key) < talk.name($1.key)) }
    NavigationStack {
      List(rows, id: \.key) { r in
        if r.key == me {
          Button { Task { try? await talk.react(live, r.value) } } label: { row(r.key, r.value, mine: true) }
            .accessibilityHint("Removes your reaction")
        } else {
          row(r.key, r.value, mine: false)
        }
      }
      .navigationTitle("Reactions")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .tint(Color.accent)
    .presentationDetents([.medium, .large])
    .onChange(of: live.reactions.isEmpty) { _, empty in if empty { dismiss() } }
  }

  private func row(_ userId: String, _ emoji: String, mine: Bool) -> some View {
    HStack(spacing: 12) {
      Avatar(name: talk.name(userId), size: 36)
      VStack(alignment: .leading) {
        Text(talk.who(userId)).foregroundStyle(Color.ink)
        if mine { Text("Tap to remove").font(.caption).foregroundStyle(Color.mut) }
      }
      Spacer()
      Text(emoji).font(.title2)
    }
    .accessibilityElement(children: .combine)
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
  @State private var saved: URL? // over Talk.inMemory: a temp file instead of `data`
  @State private var preview: UIImage? // a big photo, decoded at screen size
  @State private var tapped = false
  @State private var failed = false
  @State private var playback = VoicePlayback()
  @State private var unplayable = false

  private var big: Bool { file.size > Talk.inMemory && file.voice == nil }
  private var wanted: Bool { tapped || talk.saved[file.id] != nil || talk.fetching[file.id] != nil } // a big one, tapped, loading or loaded
  private var waiting: Bool { big && !wanted && !failed }
  private var loading: Bool { !failed && (big ? wanted && saved == nil : data == nil) }

  var body: some View {
    Group {
      if file.type.hasPrefix("image/"), let img = preview ?? data.flatMap(UIImage.init(data:)) {
        Button { onZoom(img) } label: {
          Image(uiImage: img).resizable().scaledToFill().frame(maxWidth: 260, maxHeight: 320).clipShape(.rect(cornerRadius: 16))
        }
        .accessibilityLabel("Open \(file.name)")
      } else if file.voice != nil {
        voice
      } else if file.type.hasPrefix("image/") && loading {
        RoundedRectangle(cornerRadius: 16).fill(Color.raised).frame(width: 240, height: 180).overlay { ProgressView() }
      } else {
        chip
      }
    }
    // Only a tap starts a big one; coming back on screen joins its download or picks up the file.
    .task(id: file.id) { if !big || talk.saved[file.id] != nil || talk.fetching[file.id] != nil { await load() } }
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
      Image(systemName: failed ? "exclamationmark.triangle" : waiting ? "arrow.down.circle" : "doc").font(.title3)
      VStack(alignment: .leading) {
        Text(file.name).lineLimit(1)
        Text(failed ? "Couldn’t load. Tap to retry." : waiting ? "\(Format.size(file.size)) · Tap to download" : Format.size(file.size))
          .font(.caption).foregroundStyle(Color.mut)
      }
      if let data {
        ShareLink(item: DataFile(data: data, name: file.name), preview: SharePreview(file.name)) { Image(systemName: "square.and.arrow.up") }
      } else if let saved {
        ShareLink(item: saved, preview: SharePreview(file.name)) { Image(systemName: "square.and.arrow.up") }
      } else if big && loading {
        ProgressView()
      }
    }
    .padding(12)
    .background(mine ? Color.mine : Color.bubble, in: .rect(cornerRadius: 16))
    .foregroundStyle(Color.ink)
    .onTapGesture {
      guard failed || waiting else { return }
      failed = false
      tapped = true
      Task { await load() }
    }
  }

  private func load() async {
    do {
      if !big {
        if data == nil { data = try await talk.file(convId, file) }
      } else if saved == nil {
        let url = try await talk.save(convId, file)
        guard !Task.isCancelled else { return } // off screen: decode once when it comes back
        if file.type.hasPrefix("image/") { preview = await Self.downsample(url) }
        saved = url
      }
    } catch {
      // Scrolling away cancels the row's task; that isn't a failed download.
      if !Task.isCancelled { failed = true }
    }
  }

  // A full 48 MP photo decodes to about 190 MB; the bubble and the zoom need only screen size.
  @concurrent nonisolated private static func downsample(_ url: URL) async -> UIImage? {
    let opts = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2048] as CFDictionary
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts) else { return nil }
    return UIImage(cgImage: img)
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
      // In Talk's temp folder, so sign-out and the next launch clear it too.
      let url = Talk.savedDir.appending(path: "\(UUID().uuidString)/\(diskName(f.name))")
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try f.data.write(to: url)
      return SentTransferredFile(url)
    }
  }
}
