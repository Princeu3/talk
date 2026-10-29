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
  @State private var zoom: UIImage?

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
          MessageRow(convId: convId, m: m, group: conv?.kind == "group", first: gap, onCall: callAgain, onZoom: { zoom = $0 })
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
    .onAppear { talk.open(convId) }
    .onDisappear { if talk.activeId == convId { talk.open(nil) } }
    .alert("Couldn’t send", isPresented: .constant(error != nil), presenting: error) { _ in
      Button("OK") { error = nil }
    } message: { Text($0) }
    .alert("Report \(peer.map(talk.name) ?? "")", isPresented: $reporting) {
      TextField("What happened? (optional)", text: $reportNote)
      Button("Report and block", role: .destructive) { report() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Messages are encrypted, so the server’s owner only sees what you write here. Reporting also blocks them.")
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
      Button(action: sendText) {
        Image(systemName: "arrow.up").font(.headline).frame(width: 36, height: 36)
          .background(Color.fill, in: .circle).foregroundStyle(Color.onFill)
      }
      .frame(width: 44, height: 44)
      .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
      .opacity(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
      .accessibilityLabel("Send")
    }
    .padding(.horizontal, 8).padding(.vertical, 6)
    .background(.bar)
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
    run { try await talk.send(convId, text: t) }
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

  private func report() {
    guard let peer else { return }
    let note = reportNote
    reportNote = ""
    Task {
      do { try await talk.report(peer, convId: convId, note: note) } catch { self.error = error.localizedDescription }
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
  let convId: String
  let file: FileRef
  let mine: Bool
  let onZoom: (UIImage) -> Void
  @State private var data: Data?
  @State private var failed = false
  @State private var player: AVAudioPlayer?

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
    HStack(spacing: 10) {
      Button(player?.isPlaying == true ? "Pause" : "Play", systemImage: player?.isPlaying == true ? "pause.fill" : "play.fill") { toggle() }
        .labelStyle(.iconOnly).font(.title3).frame(width: 36, height: 36)
        .disabled(data == nil)
      HStack(spacing: 2) {
        ForEach(Array((file.voice?.peaks ?? []).enumerated()), id: \.offset) { _, p in
          Capsule().fill(Color.ink.opacity(0.6)).frame(width: 3, height: max(3, 28 * p))
        }
      }
      Text(Duration.seconds(file.voice?.duration ?? 0).formatted(.time(pattern: .minuteSecond))).font(.caption).monospacedDigit()
    }
    .padding(.horizontal, 10).padding(.vertical, 6)
    .background(mine ? Color.mine : Color.bubble, in: .capsule)
    .foregroundStyle(Color.ink)
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
    if let player, player.isPlaying { player.pause(); self.player = player; return }
    guard let data else { return }
    try? AVAudioSession.sharedInstance().setCategory(.playback)
    if player == nil { player = try? AVAudioPlayer(data: data) }
    if player == nil { failed = true; return }
    player?.play()
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
