import SwiftUI

struct ChatsView: View {
  @Environment(Talk.self) private var talk
  @Environment(Calls.self) private var calls
  @State private var path: [String] = []
  @State private var sheet: Sheet?

  enum Sheet: String, Identifiable {
    case new, settings
    var id: String { rawValue }
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
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
          NavigationLink(value: c.id) { Row(conv: c) }
            .listRowBackground(Color.bg)
            .listRowSeparator(c.id == talk.me?.conversations.first?.id ? .hidden : .automatic, edges: .top)
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .background(Color.bg)
      .navigationTitle("Chats")
      .navigationDestination(for: String.self) { ChatView(convId: $0) }
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
      case .new: NewChatView { id in sheet = nil; path = [id] }
      case .settings: SettingsView()
      }
    }
    // Calls and notification taps open a chat from outside the list.
    .onChange(of: calls.openChat) { _, id in
      if let id { path = [id]; calls.openChat = nil }
    }
  }
}

private struct Row: View {
  @Environment(Talk.self) private var talk
  let conv: Conversation

  var body: some View {
    let last = conv.lastMessage.flatMap { m in talk.messages[conv.id]?.last { $0.id == m.id } }
    let mine = conv.lastMessage?.senderId == talk.account.userId
    HStack(spacing: 12) {
      Avatar(name: talk.title(conv), size: 52)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(talk.title(conv)).font(.headline).lineLimit(1)
          Spacer()
          if let t = conv.lastMessageAt { Text(Format.shortTime(t)).font(.subheadline).foregroundStyle(Color.mut) }
        }
        HStack(alignment: .top) {
          Text(last.map { Format.preview($0.content, mine: mine) } ?? " ")
            .font(.subheadline).foregroundStyle(Color.mut).lineLimit(2)
          Spacer()
          if conv.unread > 0 {
            Text("\(conv.unread)").font(.caption.bold()).monospacedDigit()
              .padding(.horizontal, 7).frame(minWidth: 22, minHeight: 22)
              .background(Color.fill, in: .capsule).foregroundStyle(Color.onFill)
              .accessibilityLabel("\(conv.unread) unread")
          }
        }
      }
    }
    .padding(.vertical, 4)
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
          ForEach(people) { u in
            Button {
              if picked.contains(u.id) { picked.remove(u.id) } else { picked.insert(u.id) }
            } label: {
              HStack(spacing: 12) {
                Avatar(name: u.name, size: 40)
                Text(u.name).foregroundStyle(Color.ink)
                Spacer()
                Image(systemName: picked.contains(u.id) ? "checkmark.circle.fill" : "circle")
                  .foregroundStyle(picked.contains(u.id) ? Color.accent : Color.mut).font(.title3)
              }
            }
            .accessibilityAddTraits(picked.contains(u.id) ? .isSelected : [])
          }
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
