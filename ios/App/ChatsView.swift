import SwiftUI

// A chat to show, at one message when it comes from a search result.
struct Route: Hashable {
  let convId: String
  var at: Int?
}

struct ChatsView: View {
  @Environment(Talk.self) private var talk
  @Environment(Calls.self) private var calls
  @State private var path: [Route] = []
  @State private var sheet: Sheet?
  @State private var query = ""
  @State private var found: [Talk.Found] = []

  enum Sheet: String, Identifiable {
    case new, settings
    var id: String { rawValue }
  }

  var body: some View {
    let q = query.trimmingCharacters(in: .whitespaces)
    NavigationStack(path: $path) {
      List {
        if q.isEmpty { chats } else { SearchResults(query: q, found: found) }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .background(Color.bg)
      .searchable(text: $query, placement: .navigationBarDrawer, prompt: "Search")
      // A pause in typing runs the search, and it runs again as older pages arrive.
      .task(id: q.isEmpty ? "" : "\(q)\n\(talk.progress)") { await find(q) }
      .task(id: q.isEmpty) { if !q.isEmpty { await talk.backfillAll() } }
      .navigationTitle(talk.online ? "Chats" : "Connecting…")
      .navigationDestination(for: Route.self) { ChatView(convId: $0.convId, at: $0.at) }
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Settings", systemImage: "gearshape") { sheet = .settings }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("New chat", systemImage: "square.and.pencil") { sheet = .new }.disabled(talk.me == nil)
        }
      }
      .refreshable { try? await talk.load() }
      .overlay { if talk.me == nil { ProgressView() } }
    }
    .tint(Color.accent)
    .sheet(item: $sheet) { s in
      switch s {
      case .new: NewChatView { id in sheet = nil; path = [Route(convId: id)] }
      case .settings: SettingsView()
      }
    }
    // Calls and notification taps open a chat from outside the list.
    .onChange(of: calls.openChat) { _, id in
      if let id { path = [Route(convId: id)]; calls.openChat = nil }
    }
  }

  // 150 ms after the last keystroke or page; a newer one cancels this.
  private func find(_ q: String) async {
    do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
    let hits = await talk.search(q)
    if !Task.isCancelled { found = hits }
  }

  @ViewBuilder private var chats: some View {
    if let me = talk.me, me.conversations.isEmpty {
      VStack(alignment: .leading, spacing: 12) {
        Text(me.users.filter { $0.deleted != true }.count > 1
             ? "Start a chat with someone here."
             : "Nobody else is here yet. Create an invite link in Settings and send it to a friend.")
          .foregroundStyle(Color.mut)
        Button(me.users.count > 1 ? "New chat" : "Invite someone") { sheet = me.users.count > 1 ? .new : .settings }
          .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(Color.fill).foregroundStyle(Color.onFill)
      }
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
    }
    ForEach(talk.me?.conversations ?? []) { c in
      NavigationLink(value: Route(convId: c.id)) { Row(conv: c) }
        .listRowBackground(Color.bg)
        .listRowSeparator(c.id == talk.me?.conversations.first?.id ? .hidden : .automatic, edges: .top)
        .swipeActions(edge: .leading) {
          Button(c.pinned == true ? "Unpin" : "Pin", systemImage: c.pinned == true ? "pin.slash" : "pin") {
            Task { try? await talk.setMine(c.id, pinned: c.pinned != true) }
          }
          .tint(Color.swipe)
        }
        .swipeActions(edge: .trailing) {
          Button(c.muted == true ? "Unmute" : "Mute", systemImage: c.muted == true ? "bell" : "bell.slash") {
            Task { try? await talk.setMine(c.id, muted: c.muted != true) }
          }
          .tint(Color.swipe)
        }
    }
  }
}

// While searching: chats whose name or a member's name matches, then matching messages, newest first.
private struct SearchResults: View {
  @Environment(Talk.self) private var talk
  let query: String
  let found: [Talk.Found]

  var body: some View {
    let convs = talk.me?.conversations ?? []
    let chats = convs.filter(matches)
    let done = convs.allSatisfy { talk.complete.contains($0.id) }
    if !chats.isEmpty {
      Section("Chats") {
        ForEach(chats) { c in NavigationLink(value: Route(convId: c.id)) { Row(conv: c) }.listRowBackground(Color.bg) }
      }
    }
    if !found.isEmpty {
      Section("Messages") {
        ForEach(found) { f in NavigationLink(value: Route(convId: f.m.message.convId, at: f.id)) { MessageHit(f: f, query: query) }.listRowBackground(Color.bg) }
      }
    }
    if query.count >= 2 && !done {
      Label { Text("Searching older messages…") } icon: { ProgressView() }
        .font(.subheadline).foregroundStyle(Color.mut).listRowBackground(Color.bg).listRowSeparator(.hidden)
    } else if chats.isEmpty && found.isEmpty {
      ContentUnavailableView.search(text: query).listRowBackground(Color.bg).listRowSeparator(.hidden)
    }
  }

  private func matches(_ c: Conversation) -> Bool {
    talk.title(c).localizedStandardContains(query) || c.members.contains { $0 != talk.account.userId && talk.name($0).localizedStandardContains(query) }
  }
}

// A matching message: its chat, the date, and "Sender: the line" with the match in bold.
private struct MessageHit: View {
  @Environment(Talk.self) private var talk
  let f: Talk.Found
  let query: String

  var body: some View {
    let title = talk.me?.conversations.first { $0.id == f.m.message.convId }.map(talk.title) ?? ""
    HStack(alignment: .top, spacing: 12) {
      Avatar(name: title, size: 44)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(title).font(.headline).lineLimit(1)
          Spacer()
          Text(Format.shortTime(f.m.message.createdAt)).font(.subheadline).foregroundStyle(Color.mut)
        }
        Text(line).font(.subheadline).foregroundStyle(Color.mut).lineLimit(2)
      }
    }
    .padding(.vertical, 4)
  }

  private var line: AttributedString {
    var s = Search.snippet(f.line, query)
    for r in s.runs where r.inlinePresentationIntent == .stronglyEmphasized { s[r.range].foregroundColor = Color.ink }
    return AttributedString("\(talk.who(f.m.message.senderId)): ") + s
  }
}

private struct Row: View {
  @Environment(Talk.self) private var talk
  @Environment(Calls.self) private var calls
  let conv: Conversation

  var body: some View {
    HStack(spacing: 12) {
      Avatar(name: talk.title(conv), size: 52)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(talk.title(conv)).font(.headline).lineLimit(1)
          if conv.muted == true {
            Image(systemName: "bell.slash.fill").font(.caption).foregroundStyle(Color.mut).accessibilityLabel("Muted")
          }
          Spacer()
          if conv.pinned == true {
            Image(systemName: "pin.fill").font(.caption).foregroundStyle(Color.mut).accessibilityLabel("Pinned")
          }
          if let t = conv.lastMessageAt { Text(Format.shortTime(t)).font(.subheadline).foregroundStyle(Color.mut) }
        }
        HStack(alignment: .top) {
          LastLine(conv: conv)
          Spacer()
          if let live = conv.call { JoinPill(kind: live.kind) { calls.start(convId: conv.id, kind: live.kind) } }
          if conv.unread > 0 {
            Text("\(conv.unread)").font(.caption.bold()).monospacedDigit()
              .padding(.horizontal, 7).frame(minWidth: 22, minHeight: 22)
              .background(Color.fill, in: .capsule).foregroundStyle(Color.onFill)
              .accessibilityLabel("\(conv.unread) unread")
          }
        }
      }
      .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] } // the Join pill's Label would otherwise pull the separator to itself
    }
    .padding(.vertical, 4)
  }
}

// A row's second line: who's typing, else the last message. Its own view, so a typing signal redraws only this.
private struct LastLine: View {
  @Environment(Talk.self) private var talk
  let conv: Conversation

  var body: some View {
    let typers = talk.typers(conv.id)
    if !typers.isEmpty {
      Text(Format.typing(typers.map(talk.name), group: conv.kind == "group"))
        .font(.subheadline).foregroundStyle(Color.accent).lineLimit(2)
    } else {
      let last = conv.lastMessage.flatMap { m in talk.messages[conv.id]?.last { $0.id == m.id } }
      Text(last.map { Format.preview($0.content, mine: $0.message.senderId == talk.account.userId) } ?? " ")
        .font(.subheadline).foregroundStyle(Color.mut).lineLimit(2)
    }
  }
}

// Someone to tick in a people picker (new chat, add people).
struct PickRow: View {
  let user: User
  @Binding var picked: Set<String>

  var body: some View {
    let on = picked.contains(user.id)
    Button {
      if on { picked.remove(user.id) } else { picked.insert(user.id) }
    } label: {
      HStack(spacing: 12) {
        Avatar(name: user.name, size: 40)
        Text(user.name).foregroundStyle(Color.ink)
        Spacer()
        Image(systemName: on ? "checkmark.circle.fill" : "circle")
          .foregroundStyle(on ? Color.accent : Color.mut).font(.title3)
      }
    }
    .accessibilityAddTraits(on ? .isSelected : [])
  }
}

struct NewChatView: View {
  @Environment(Talk.self) private var talk
  @Environment(\.dismiss) private var dismiss
  let onOpen: (String) -> Void
  @State private var picked = Set<String>()
  @State private var title = ""
  @State private var busy = false
  @State private var error = ""

  var body: some View {
    let people = (talk.me?.users ?? []).filter { $0.id != talk.account.userId && $0.deleted != true }
    NavigationStack {
      List {
        if picked.count > 1 {
          Section("Group name") { TextField("Name the group", text: $title) }
        }
        Section(picked.count > 1 ? "\(picked.count) people" : "People") {
          ForEach(people) { PickRow(user: $0, picked: $picked) }
        }
        if !error.isEmpty { Text(error).foregroundStyle(Color.danger) }
      }
      .navigationTitle("New chat")
      .navigationBarTitleDisplayMode(.inline)
      .task { try? await talk.load() } // the server sends no sync when someone joins
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(picked.count > 1 ? "Create" : "Chat") { create() }
            .disabled(busy || picked.isEmpty || (picked.count > 1 && title.trimmingCharacters(in: .whitespaces).isEmpty))
        }
      }
    }
  }

  private func create() {
    busy = true
    Task {
      defer { busy = false }
      do { onOpen(try await talk.createConversation(Array(picked), title: title.trimmingCharacters(in: .whitespaces))) }
      catch { self.error = error.localizedDescription }
    }
  }
}
