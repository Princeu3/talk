import ImageIO
import SwiftUI
import UniformTypeIdentifiers

// Pushed from a chat's header: who's in it, its settings, and the people actions.
struct ChatInfoView: View {
  @Environment(Talk.self) private var talk
  @Environment(Calls.self) private var calls
  let convId: String
  @State private var renaming = false
  @State private var newTitle = ""
  @State private var adding = false
  @State private var member: Member?
  @State private var leaving = false
  @State private var reporting = false
  @State private var error: String?

  private struct Member: Identifiable { let id: String }

  var body: some View {
    if let conv = talk.me?.conversations.first(where: { $0.id == convId }) {
      let peer = talk.peer(conv)
      let me = talk.account.userId
      List {
        Section {
          VStack(spacing: 6) {
            Avatar(name: talk.title(conv), size: 96)
            Text(talk.title(conv)).font(.title2.bold()).multilineTextAlignment(.center).padding(.top, 6)
            if peer != nil {
              Label("End-to-end encrypted", systemImage: "lock.fill").font(.subheadline).foregroundStyle(Color.mut)
            } else {
              Text("\(conv.members.count) people").font(.subheadline).foregroundStyle(Color.mut)
              Button("Rename") {
                newTitle = conv.title ?? ""
                renaming = true
              }
              .font(.subheadline.weight(.semibold))
            }
            // Not in a DM whose other account was deleted: nobody to call.
            if peer != nil || conv.kind == "group" {
              HStack(spacing: 12) {
                action("Voice call", "phone.fill") { calls.start(convId: convId, kind: "audio") }
                action("Video call", "video.fill") { calls.start(convId: convId, kind: "video") }
              }
              .padding(.top, 10)
            }
          }
          .frame(maxWidth: .infinity)
          .listRowBackground(Color.clear)
        }

        mediaRow

        if let peer, let u = talk.user(peer) {
          Section {
            Text(Crypto.safetyCode(u.pubkey)).font(.title3.monospaced())
          } header: { Text("Safety code") } footer: {
            Text("Compare this with the code on \(u.name)’s phone, in person or on a call. If they match, nobody swapped a key.")
          }
        }

        if peer == nil {
          Section("Members") {
            // You first, then everyone else by name.
            ForEach([me] + conv.members.filter { $0 != me }.sorted { talk.name($0) < talk.name($1) }, id: \.self) { uid in
              if uid == me {
                person(uid)
              } else {
                Button { member = Member(id: uid) } label: {
                  HStack {
                    person(uid)
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.mut)
                  }
                }
                .foregroundStyle(Color.ink)
              }
            }
            Button("Add people", systemImage: "person.badge.plus") { adding = true }
          }
        }

        Section {
          Toggle("Mute notifications", isOn: binding(conv.muted == true) { try await talk.setMine(convId, muted: $0) })
          Toggle("Pin chat", isOn: binding(conv.pinned == true) { try await talk.setMine(convId, pinned: $0) })
        }

        Section {
          if let peer {
            if talk.isBlocked(peer) {
              Button("Unblock") { run { try await talk.block(peer, false) } }
            } else {
              Button("Block", role: .destructive) { run { try await talk.block(peer, true) } }.foregroundStyle(Color.danger)
            }
            Button("Report", role: .destructive) { reporting = true }.foregroundStyle(Color.danger)
          } else {
            Button("Leave group", role: .destructive) { leaving = true }.foregroundStyle(Color.danger)
          }
        }
      }
      .navigationTitle(peer == nil ? "Group info" : "Contact info")
      .navigationBarTitleDisplayMode(.inline)
      .tint(Color.accent)
      .modifier(ReportAlert(convId: convId, who: peer, one: nil, isPresented: $reporting))
      .alert("Rename group", isPresented: $renaming) {
        TextField("Group name", text: $newTitle)
        Button("Save") {
          let t = newTitle.trimmingCharacters(in: .whitespaces)
          if !t.isEmpty, t != conv.title { run { try await talk.rename(convId, t) } }
        }
        Button("Cancel", role: .cancel) {}
      } message: { Text("Up to 32 letters, numbers, spaces, dots, dashes or underscores.") }
      .confirmationDialog("Leave \(talk.title(conv))?", isPresented: $leaving, titleVisibility: .visible) {
        Button("Leave group", role: .destructive) { run { try await talk.remove(convId, me) } }
      } message: { Text("You’ll stop getting its messages. Someone in it can add you back.") }
      .alert("Something went wrong", isPresented: .constant(error != nil), presenting: error) { _ in
        Button("OK") { error = nil }
      } message: { Text($0) }
      .sheet(isPresented: $adding) { AddPeopleView(conv: conv) }
      .sheet(item: $member) { MemberSheet(convId: convId, userId: $0.id) }
    }
  }

  private var mediaRow: some View {
    Section {
      NavigationLink { SharedMedia(convId: convId) } label: { Label("Media, links and docs", systemImage: "photo.on.rectangle") }
    }
  }

  private func person(_ userId: String) -> some View {
    HStack(spacing: 12) {
      Avatar(name: talk.name(userId), size: 36)
      Text(talk.who(userId))
    }
  }

  private func action(_ label: String, _ icon: String, _ run: @escaping () -> Void) -> some View {
    Button(action: run) {
      VStack(spacing: 4) {
        Image(systemName: icon).font(.title3)
        Text(label).font(.caption)
      }
      .frame(width: 96, height: 60)
      .background(Color.surface, in: .rect(cornerRadius: 14))
    }
    .buttonStyle(.plain)
    .foregroundStyle(Color.accent)
  }

  private func binding(_ on: Bool, _ set: @escaping (Bool) async throws -> Void) -> Binding<Bool> {
    Binding(get: { on }, set: { v in run { try await set(v) } })
  }

  private func run(_ work: @escaping () async throws -> Void) {
    Task {
      do { try await work() } catch { self.error = error.localizedDescription }
    }
  }
}

// Someone in a group: their safety code, a DM with them, or removing them.
private struct MemberSheet: View {
  @Environment(Talk.self) private var talk
  @Environment(Calls.self) private var calls
  @Environment(\.dismiss) private var dismiss
  let convId: String
  let userId: String
  @State private var removing = false
  @State private var error: String?

  var body: some View {
    let name = talk.name(userId)
    NavigationStack {
      List {
        Section {
          VStack(spacing: 8) {
            Avatar(name: name, size: 80)
            Text(name).font(.title2.bold())
          }
          .frame(maxWidth: .infinity)
          .listRowBackground(Color.clear)
        }
        if let u = talk.user(userId) {
          Section("Safety code") { Text(Crypto.safetyCode(u.pubkey)).font(.title3.monospaced()) }
        }
        Section {
          Button("Message", systemImage: "message") {
            Task {
              do {
                let id = try await talk.createConversation([userId])
                dismiss()
                calls.openChat = id // the chat list opens it
              } catch { self.error = error.localizedDescription }
            }
          }
          .disabled(talk.user(userId)?.deleted == true)
          Button("Remove from group", systemImage: "person.badge.minus", role: .destructive) { removing = true }
            .foregroundStyle(Color.danger)
        }
        if let error { Text(error).foregroundStyle(Color.danger) }
      }
      .navigationTitle(name)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .confirmationDialog("Remove \(name) from the group?", isPresented: $removing, titleVisibility: .visible) {
        Button("Remove", role: .destructive) {
          Task {
            do {
              try await talk.remove(convId, userId)
              dismiss()
            } catch { self.error = error.localizedDescription }
          }
        }
      }
    }
    .tint(Color.accent)
    .presentationDetents([.medium, .large])
  }
}

private struct AddPeopleView: View {
  @Environment(Talk.self) private var talk
  @Environment(\.dismiss) private var dismiss
  let conv: Conversation
  @State private var picked = Set<String>()
  @State private var busy = false
  @State private var error = ""

  var body: some View {
    let people = (talk.me?.users ?? []).filter { !conv.members.contains($0.id) && $0.deleted != true }
    NavigationStack {
      List {
        if people.isEmpty {
          Text("Everyone on this server is already in the group.").foregroundStyle(Color.mut)
        }
        ForEach(people) { PickRow(user: $0, picked: $picked) }
        if !error.isEmpty { Text(error).foregroundStyle(Color.danger) }
      }
      .navigationTitle("Add people")
      .navigationBarTitleDisplayMode(.inline)
      .task { try? await talk.load() } // the server sends no sync when someone joins it
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Add") { add() }.disabled(busy || picked.isEmpty)
        }
      }
    }
    .tint(Color.accent)
  }

  private func add() {
    busy = true
    Task {
      defer { busy = false }
      do {
        try await talk.add(conv.id, people(picked))
        dismiss()
      } catch { self.error = error.localizedDescription }
    }
  }

  // In name order, so the "added" line reads the same everywhere.
  private func people(_ ids: Set<String>) -> [String] { ids.sorted { talk.name($0) < talk.name($1) } }
}

private struct FileItem: Identifiable {
  let m: Decrypted
  let file: FileRef
  var id: String { file.id }
}

private struct LinkItem: Identifiable {
  let m: Decrypted
  let url: URL
  let title: String?
  let site: String
  var id: String { "\(m.id) \(url.absoluteString)" }
}

// Links found in each message's text, kept by id and edit: the detector is slow over a long history.
private final class LinkCache {
  private var byId: [Int: (at: Double?, urls: [URL])] = [:]

  // Only texts that look linked go through the detector.
  func links(_ m: Decrypted, _ text: String) -> [URL] {
    if let c = byId[m.id], c.at == m.message.editedAt { return c.urls }
    let urls = text.contains("http") || text.contains("www.") ? LinkPreview.links(in: text) : []
    byId[m.id] = (m.message.editedAt, urls)
    return urls
  }
}

// Media, links and docs: what the chat's history holds, newest first, filling in as older pages arrive.
private struct SharedMedia: View {
  @Environment(Talk.self) private var talk
  let convId: String
  @State private var tab = Tab.media
  @State private var zoom: UIImage?
  @State private var cache = LinkCache()

  enum Tab: String, CaseIterable { case media = "Media", links = "Links", docs = "Docs" }

  var body: some View {
    let _ = talk.progress // pages arriving re-read the history
    let list = talk.history(convId)
    let done = talk.complete.contains(convId)
    Group {
      switch tab {
      case .media: MediaGrid(convId: convId, items: files(list, media: true), done: done) { zoom = $0 }
      case .links: LinkList(items: links(list), done: done)
      case .docs: DocList(convId: convId, items: files(list, media: false), done: done)
      }
    }
    .background(Color.bg)
    .navigationTitle("Media, links and docs")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) {
        Picker("Show", selection: $tab) { ForEach(Tab.allCases, id: \.self) { Text($0.rawValue) } }
          .pickerStyle(.segmented).frame(width: 260)
      }
    }
    .photoViewer($zoom)
    .task { await talk.backfill(convId) }
  }

  // Photos and videos, or every other file; never voice messages.
  private func files(_ list: [Decrypted], media: Bool) -> [FileItem] {
    var out: [FileItem] = []
    for m in list {
      for f in m.content?.files ?? [] where f.voice == nil && (f.type.hasPrefix("image/") || f.type.hasPrefix("video/")) == media {
        out.append(FileItem(m: m, file: f))
      }
    }
    return out
  }

  // A message's card, else the links in its text.
  private func links(_ list: [Decrypted]) -> [LinkItem] {
    var out: [LinkItem] = []
    for m in list {
      guard let c = m.content, !m.system else { continue }
      if let p = c.preview, let url = URL(string: p.url) {
        out.append(LinkItem(m: m, url: url, title: p.title, site: p.label))
      } else if let t = c.text {
        for url in cache.links(m, t) { out.append(LinkItem(m: m, url: url, title: nil, site: Format.host(url) ?? "")) }
      }
    }
    return out
  }
}

// Under a tab: a spinner while older pages arrive, then a note if nothing turned up.
private struct Pages: View {
  let done: Bool
  let empty: Bool
  let none: String

  var body: some View {
    if !done {
      ProgressView().frame(maxWidth: .infinity).padding()
    } else if empty {
      Text(none).foregroundStyle(Color.mut).frame(maxWidth: .infinity).padding(.vertical, 40)
    }
  }
}

private struct MediaGrid: View {
  let convId: String
  let items: [FileItem]
  let done: Bool
  let onZoom: (UIImage) -> Void

  var body: some View {
    ScrollView {
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 3), spacing: 2) {
        ForEach(items) { MediaCell(convId: convId, file: $0.file, onZoom: onZoom) }
      }
      Pages(done: done, empty: items.isEmpty, none: "No photos or videos")
    }
  }
}

// A photo opens in the viewer; a video goes to the share sheet, as in the chat (which has no player).
private struct MediaCell: View {
  @Environment(Talk.self) private var talk
  let convId: String
  let file: FileRef
  let onZoom: (UIImage) -> Void
  @State private var thumb: UIImage?

  private var video: Bool { file.type.hasPrefix("video/") }
  private var big: Bool { file.size > Talk.inMemory }

  var body: some View {
    if video {
      ShareLink(item: SealedVideo(talk: talk, convId: convId, file: file), preview: SharePreview(file.name)) { square }
    } else {
      Button(action: open) { square }
        .accessibilityLabel("Open \(file.name)")
        // Shrunk without keeping the photo in memory; big ones wait for a tap, as in the chat.
        .task(id: file.id) {
          guard !big else { return }
          thumb = try? await talk.thumb(convId, file)
        }
    }
  }

  private var square: some View {
    Color.raised.aspectRatio(1, contentMode: .fit)
      .overlay {
        if let thumb {
          Image(uiImage: thumb).resizable().scaledToFill()
        } else {
          Image(systemName: video ? "play.fill" : "photo").font(.title2).foregroundStyle(Color.mut)
        }
      }
      .clipped()
  }

  private func open() {
    Task {
      if big {
        if let url = try? await talk.save(convId, file), let img = await Attachment.downsample(CGImageSourceCreateWithURL(url as CFURL, nil)) { onZoom(img) }
      } else if let data = try? await talk.file(convId, file), let img = UIImage(data: data) {
        onZoom(img)
      }
    }
  }
}

// A video, decrypted only when the share sheet asks for it.
private struct SealedVideo: Transferable {
  let talk: Talk
  let convId: String
  let file: FileRef

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(exportedContentType: .movie) { v in SentTransferredFile(try await v.talk.save(v.convId, v.file)) }
  }
}

private struct LinkList: View {
  @Environment(\.openURL) private var openURL
  let items: [LinkItem]
  let done: Bool

  var body: some View {
    List {
      ForEach(items) { i in
        Button { openURL(i.url) } label: {
          VStack(alignment: .leading, spacing: 2) {
            Text(i.title ?? i.url.absoluteString).foregroundStyle(Color.ink).lineLimit(2)
            Text("\(i.site) · \(Format.shortTime(i.m.message.createdAt))").font(.caption).foregroundStyle(Color.mut).lineLimit(1)
          }
        }
        .listRowBackground(Color.bg)
      }
      Pages(done: done, empty: items.isEmpty, none: "No links").listRowBackground(Color.bg).listRowSeparator(.hidden)
    }
    .listStyle(.plain)
  }
}

// Each file as the chat shows it (tap to download a big one, then share), with its date.
private struct DocList: View {
  let convId: String
  let items: [FileItem]
  let done: Bool

  var body: some View {
    List {
      ForEach(items) { i in
        VStack(alignment: .leading, spacing: 4) {
          Attachment(convId: convId, file: i.file, mine: false) { _ in }
          Text(Format.shortTime(i.m.message.createdAt)).font(.caption).foregroundStyle(Color.mut)
        }
        .listRowBackground(Color.bg)
      }
      Pages(done: done, empty: items.isEmpty, none: "No documents").listRowBackground(Color.bg).listRowSeparator(.hidden)
    }
    .listStyle(.plain)
  }
}
