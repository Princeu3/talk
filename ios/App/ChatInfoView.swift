import SwiftUI

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
            // A group (no peer) joins its live call or starts one.
            HStack(spacing: 12) {
              action("Voice call", "phone.fill") { calls.start(convId: convId, peer: peer, kind: "audio") }
              action("Video call", "video.fill") { calls.start(convId: convId, peer: peer, kind: "video") }
            }
            .padding(.top, 10)
          }
          .frame(maxWidth: .infinity)
          .listRowBackground(Color.clear)
        }

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
                person(uid, "You")
              } else {
                Button { member = Member(id: uid) } label: {
                  HStack {
                    person(uid, talk.name(uid))
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

  private func person(_ userId: String, _ name: String) -> some View {
    HStack(spacing: 12) {
      Avatar(name: talk.name(userId), size: 36)
      Text(name)
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
