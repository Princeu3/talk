import CryptoKit
import Intents
import SwiftUI
import UniformTypeIdentifiers

// "Talk" in the share sheet: pick a chat, add a caption, send. Sealed and sent from here,
// the way the app does it, so a screenshot or file never waits for the app to open.
final class ShareViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    let host = UIHostingController(rootView: ShareView(context: extensionContext!) { [weak self] in self?.isModalInPresentation = $0 })
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
  }
}

nonisolated struct SharedFile: Identifiable {
  let id = UUID()
  let data: Data
  let name: String
  let type: String // MIME
  let thumb: UIImage?
}

struct ShareView: View {
  let context: NSExtensionContext
  let busy: (Bool) -> Void // no swipe-away mid-send: it would end the upload with no word to the user
  @State private var account = Vault.load()
  @State private var me: Me?
  @State private var files: [SharedFile] = []
  @State private var caption = ""
  @State private var picked: String?
  @State private var cid = UUID().uuidString.lowercased() // kept across retries, so a lost ack stores once
  @State private var refs: [FileRef] = [] // uploaded so far, so a retry sends only the rest
  @State private var loading = true
  @State private var sending = false
  @State private var task: Task<Void, Never>?
  @State private var error = ""
  @State private var sendError: String?

  var body: some View {
    NavigationStack {
      List {
        if account == nil {
          Text("Sign in to Talk first, then share again.").foregroundStyle(Color.mut)
        } else {
          Section {
            if !files.isEmpty { preview }
            TextField("Add a message", text: $caption, axis: .vertical).lineLimit(1...5)
            if !error.isEmpty { Text(error).foregroundStyle(Color.danger) }
          }
          Section("Send to") {
            if loading { ProgressView().frame(maxWidth: .infinity) }
            ForEach(chats) { row($0) }
          }
        }
      }
      .disabled(sending)
      .scrollContentBackground(.hidden)
      .background(Color.bg)
      .navigationTitle("Send to Talk")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            task?.cancel()
            context.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          if sending { ProgressView() } else {
            Button("Send") { task = Task { await send() } }
              .disabled(picked == nil || me == nil || loading || (files.isEmpty && caption.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
          }
        }
      }
      // As ChatView: an alert shows at any scroll position, and VoiceOver reads it.
      .alert("Couldn’t send", isPresented: .constant(sendError != nil), presenting: sendError) { _ in
        Button("OK") { sendError = nil }
      } message: { Text($0) }
    }
    .tint(Color.accent)
    .task { await load() }
    .onChange(of: sending) { busy(sending) }
    // Uploads are sealed with the chat's own key, so a new chat starts over.
    .onChange(of: picked) {
      cid = UUID().uuidString.lowercased()
      refs = []
    }
  }

  private var chats: [Conversation] {
    (me?.conversations ?? []).sorted { ($0.lastMessageAt ?? 0) > ($1.lastMessageAt ?? 0) }
  }

  // As Talk.title in the app: a group's title, or the other person's name.
  private func title(_ c: Conversation) -> String {
    let other = c.members.first { $0 != account?.userId } ?? account?.userId
    return c.title ?? me?.users.first { $0.id == other }?.name ?? "Someone"
  }

  private func row(_ c: Conversation) -> some View {
    Button { picked = c.id } label: {
      HStack(spacing: 12) {
        Avatar(name: title(c), size: 40)
        Text(title(c)).foregroundStyle(Color.ink).lineLimit(1)
        Spacer()
        Image(systemName: picked == c.id ? "checkmark.circle.fill" : "circle")
          .foregroundStyle(picked == c.id ? Color.accent : Color.mut).font(.title3)
      }
    }
    .accessibilityAddTraits(picked == c.id ? .isSelected : [])
  }

  private var preview: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(files) { f in
          if let thumb = f.thumb {
            Image(uiImage: thumb).resizable().scaledToFill().frame(width: 72, height: 72).clipShape(.rect(cornerRadius: 10))
              .accessibilityLabel(f.name)
          } else {
            Label(f.name, systemImage: "doc").font(.footnote).lineLimit(1)
              .padding(.horizontal, 10).frame(height: 72).frame(maxWidth: 200)
              .background(Color.raised, in: .rect(cornerRadius: 10))
          }
        }
      }
    }
  }

  private func load() async {
    defer { loading = false }
    guard let account else { return }
    // A tap on a suggested person in the share sheet's top row arrives as this intent.
    picked = (context.intent as? INSendMessageIntent)?.conversationIdentifier
    async let fetched: Me = account.api.call("GET", "/api/me")
    let (got, text, problem) = await Inbox.load(context.inputItems.compactMap { $0 as? NSExtensionItem })
    files = got
    caption = text
    if let problem { error = problem }
    do { me = try await fetched } catch { self.error = error.localizedDescription }
    // A suggestion can name a chat this account isn't in, such as one from an earlier sign-in.
    if me?.conversations.contains(where: { $0.id == picked }) != true { picked = nil }
  }

  private func send() async {
    guard let account, let me, let conv = me.conversations.first(where: { $0.id == picked }),
          let wrapper = me.users.first(where: { $0.id == conv.wrappedBy }) else { return }
    sending = true
    defer { sending = false }
    let socket = Socket(account: account)
    defer { socket.disconnect() }
    do {
      let key = SymmetricKey(data: try Crypto.unwrapConvKey(conv.wrappedKey, mine: account.privateKey, wrapperPub: wrapper.pubkey, convId: conv.id, myId: account.userId))
      for f in files.dropFirst(refs.count) {
        // Sealed to disk and streamed from there: an in-memory upload body costs about two more copies.
        let sealed = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try Crypto.sealFile(key, convId: conv.id, f.data).write(to: sealed)
        defer { try? FileManager.default.removeItem(at: sealed) }
        let (res, _) = try await account.api.data("POST", "/api/conversations/\(conv.id)/attachments", file: sealed, type: "application/octet-stream")
        refs.append(FileRef(id: try JSONDecoder().decode(Created.self, from: res).id, name: f.name, type: f.type, size: f.data.count))
      }
      let text = caption.trimmingCharacters(in: .whitespacesAndNewlines)
      let body = MessageBody(from: account.userId, text: text.isEmpty ? nil : text, files: refs.isEmpty ? nil : refs)
      let sealed = try Crypto.sealMessage(key, convId: conv.id, body)
      guard sealed.count <= 64 * 1024 else { throw APIError(status: 0, message: "That message is too long to send.") }
      try await connect(socket)
      struct Ack: Decodable { let message: Message?; let error: String? }
      let r = try await socket.ack("send", ["convId": conv.id, "body": sealed, "cid": cid])
      let ack = try? JSONDecoder().decode(Ack.self, from: r)
      guard ack?.message != nil else { throw APIError(status: 0, message: ack?.error ?? "Couldn’t send.") }
      context.completeRequest(returningItems: nil)
    } catch {
      sendError = error.localizedDescription
    }
  }

  // Waits up to 15 s for the socket's first connect.
  private func connect(_ socket: Socket) async throws {
    var signedOut = false
    socket.onSignedOut = { signedOut = true }
    socket.connect()
    var waited = 0
    while !socket.connected, !signedOut, waited < 60 {
      try await Task.sleep(for: .milliseconds(250))
      waited += 1
    }
    if signedOut { throw APIError(status: 401, message: "You’re signed out. Open Talk and sign in again.") }
    if !socket.connected { throw APIError(status: 0, message: "Couldn’t reach the server. Check your connection and try again.") }
  }
}

// What the share sheet handed over: files to attach, and text or links for the caption.
nonisolated enum Inbox {
  static let maxFile = 50 * 1024 * 1024

  private enum Loaded: Sendable {
    case text(String)
    case file(Data, name: String?, type: UTType?)
    case tooBig(String)
  }

  static func load(_ items: [NSExtensionItem]) async -> (files: [SharedFile], text: String, problem: String?) {
    var files: [SharedFile] = []
    var texts: [String] = []
    var problem: String?
    for provider in items.flatMap({ $0.attachments ?? [] }) {
      let types = provider.registeredContentTypes
      guard let type = types.first(where: { $0.conforms(to: .image) || $0.conforms(to: .audiovisualContent) })
              ?? types.first(where: { $0.conforms(to: .url) || $0.conforms(to: .text) || $0.conforms(to: .data) }) else { continue }
      switch try? await item(provider, type) {
      case .text(let s): texts.append(s)
      case .tooBig(let name): problem = "\(name) is over 50 MB"
      case .file(let data, let name, let got):
        let kind = got ?? type
        let ext = name.map { ($0 as NSString).pathExtension } ?? kind.preferredFilenameExtension ?? ""
        let base = provider.suggestedName ?? (kind.conforms(to: .image) ? "Photo \(files.count + 1)" : "File \(files.count + 1)")
        let fileName = name ?? (ext.isEmpty || base.hasSuffix(".\(ext)") ? base : "\(base).\(ext)")
        guard data.count <= maxFile else { problem = "\(fileName) is over 50 MB"; continue }
        let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? kind.preferredMIMEType ?? "application/octet-stream"
        let thumb = mime.hasPrefix("image/") ? UIImage(data: data)?.preparingThumbnail(of: CGSize(width: 216, height: 216)) : nil
        files.append(SharedFile(data: data, name: fileName, type: mime, thumb: thumb))
      case nil: problem = "Couldn’t read one of the items."
      }
    }
    return (files, texts.joined(separator: "\n"), problem)
  }

  // Settled inside the callback: a file URL is only readable there.
  private static func item(_ provider: NSItemProvider, _ type: UTType) async throws -> Loaded {
    try await withCheckedThrowingContinuation { c in
      provider.loadItem(forTypeIdentifier: type.identifier) { item, error in
        switch item {
        case let s as String: c.resume(returning: .text(s))
        case let u as URL where !u.isFileURL: c.resume(returning: .text(u.absoluteString))
        case let u as URL:
          let scoped = u.startAccessingSecurityScopedResource()
          defer { if scoped { u.stopAccessingSecurityScopedResource() } }
          // A share extension gets about 120 MB, so size first and map rather than read:
          // mapped pages are clean and don't count against that limit.
          if let size = try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > maxFile {
            c.resume(returning: .tooBig(u.lastPathComponent))
            return
          }
          // Mapped from our own clone (free on APFS): the sender may delete or rewrite its file after
          // this returns, and a mapping over a shrunk file crashes. Unlinking the clone keeps the mapping.
          let copy = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
          defer { try? FileManager.default.removeItem(at: copy) }
          do {
            try FileManager.default.copyItem(at: u, to: copy)
            c.resume(returning: .file(try Data(contentsOf: copy, options: .mappedIfSafe), name: u.lastPathComponent, type: nil))
          } catch { c.resume(throwing: error) }
        // Some apps register a link or plain text as raw bytes rather than as an object.
        case let d as Data where type.conforms(to: .url) && !type.conforms(to: .fileURL):
          c.resume(returning: .text((try? NSURL.object(withItemProviderData: d, typeIdentifier: type.identifier))?.absoluteString ?? String(decoding: d, as: UTF8.self)))
        case let d as Data where type.conforms(to: .plainText):
          c.resume(returning: .text((try? NSString.object(withItemProviderData: d, typeIdentifier: type.identifier)) as String? ?? String(decoding: d, as: UTF8.self)))
        case let d as Data: c.resume(returning: .file(d, name: nil, type: nil))
        // The screenshot editor hands over an image object, not a file.
        case let i as UIImage:
          if let png = i.pngData() { c.resume(returning: .file(png, name: nil, type: .png)) } else { c.resume(throwing: CocoaError(.fileReadCorruptFile)) }
        default: c.resume(throwing: error ?? CocoaError(.fileReadUnknown))
        }
      }
    }
  }
}

