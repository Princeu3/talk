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
          Link(destination: URL(string: "https://push.princeuniverse.dev/terms")!) { Label("Terms of use", systemImage: "doc.text") }
          Link(destination: URL(string: "https://push.princeuniverse.dev/support")!) { Label("Help", systemImage: "questionmark.circle") }
          NavigationLink { LicensesView() } label: { Label("Open source licenses", systemImage: "text.book.closed") }
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

private struct LicensesView: View {
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text("Talk is open source under the GNU AGPL-3.0. [Read the code on GitHub](https://github.com/Princeu3/talk).")
        Text("WebRTC").font(.headline).padding(.top, 8)
        Text("Calls use WebRTC, built for iOS by the stasel/WebRTC package. Its license:").foregroundStyle(Color.mut)
        Text(Self.webrtc).font(.footnote.monospaced()).textSelection(.enabled)
      }
      .padding(20)
    }
    .background(Color.bg)
    .navigationTitle("Open source licenses")
    .navigationBarTitleDisplayMode(.inline)
  }

  static let webrtc = """
    Copyright (c) 2011, The WebRTC project authors. All rights reserved.

    Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

    * Neither the name of Google nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
    """
}
