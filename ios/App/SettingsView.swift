import SwiftUI

struct SettingsView: View {
  @Environment(Talk.self) private var talk
  @Environment(\.dismiss) private var dismiss
  @State private var invite: URL?
  @State private var inviteError = ""
  @State private var confirmDelete = false
  @State private var deletePass = ""
  @State private var deleting = false
  @State private var deleteError: String?

  var body: some View {
    let me = talk.me
    NavigationStack {
      List {
        Section {
          HStack(spacing: 14) {
            Avatar(name: talk.account.name, size: 56)
            VStack(alignment: .leading) {
              Text(talk.account.name).font(.title3.bold())
              Text(talk.account.server.host() ?? "").font(.subheadline).foregroundStyle(Color.mut)
            }
          }
        }

        Section {
          if let invite {
            ShareLink(item: invite, message: Text("Join me on Talk")) { Label("Share invite link", systemImage: "square.and.arrow.up") }
            Text(invite.absoluteString).font(.footnote).foregroundStyle(Color.mut).textSelection(.enabled)
          } else {
            Button("Create invite link", systemImage: "person.badge.plus") { makeInvite() }
          }
          if !inviteError.isEmpty { Text(inviteError).foregroundStyle(Color.danger) }
        } header: { Text("Invite") } footer: { Text("Works once, for one person, for 7 days.") }

        Section {
          ForEach((me?.users ?? []).filter { $0.deleted != true }) { u in
            HStack(spacing: 12) {
              Avatar(name: u.name, size: 32)
              Text(u.id == talk.account.userId ? "\(u.name) (you)" : u.name)
              Spacer()
              Text(Crypto.safetyCode(u.pubkey)).font(.callout.monospaced()).foregroundStyle(Color.mut)
            }
            .accessibilityElement(children: .combine)
          }
        } header: { Text("Safety codes") } footer: {
          Text("Compare these in person or on a call. If they match on both phones, nobody swapped a key.")
        }

        if let blocked = me?.blocked, !blocked.isEmpty {
          Section("Blocked") {
            ForEach(blocked, id: \.self) { id in
              HStack {
                Text(talk.name(id))
                Spacer()
                Button("Unblock") { Task { try? await talk.block(id, false) } }.buttonStyle(.borderless)
              }
            }
          }
        }

        Section {
          Link(destination: URL(string: "https://push.princeuniverse.dev/privacy")!) { Label("Privacy policy", systemImage: "hand.raised") }
          Link(destination: URL(string: "https://push.princeuniverse.dev/support")!) { Label("Help", systemImage: "questionmark.circle") }
        }

        Section {
          Button("Sign out of this phone") { Task { await talk.signOut() } }
          Button("Delete account", role: .destructive) { confirmDelete = true }
        } footer: {
          Text("Deleting removes your account and every message you sent from this server. It can’t be undone.")
        }
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .alert("Delete your account?", isPresented: $confirmDelete) {
        SecureField("Passphrase", text: $deletePass)
        Button("Delete", role: .destructive) { delete() }
        Button("Cancel", role: .cancel) { deletePass = "" }
      } message: {
        Text("Enter your passphrase. Your account and every message you sent are removed from the server for good.")
      }
      .alert("Couldn’t delete", isPresented: .constant(deleteError != nil), presenting: deleteError) { _ in
        Button("OK") { deleteError = nil }
      } message: { Text($0) }
      .overlay { if deleting { ProgressView("Deleting…").padding().background(.regularMaterial, in: .rect(cornerRadius: 16)) } }
    }
    .tint(Color.accent)
  }

  private func makeInvite() {
    Task {
      do { invite = try await talk.invite() } catch { inviteError = error.localizedDescription }
    }
  }

  private func delete() {
    let pass = deletePass
    deletePass = ""
    deleting = true
    Task {
      defer { deleting = false }
      do { try await talk.deleteAccount(passphrase: pass) } catch { deleteError = error.localizedDescription }
    }
  }
}
