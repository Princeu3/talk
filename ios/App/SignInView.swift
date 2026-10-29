import SwiftUI

// One field takes either an invite link (server + code in one, to create an
// account) or a server address (to sign in), like Discord's join screen.
struct SignInView: View {
  let onDone: (Account) -> Void
  @State private var link = ""
  @State private var name = ""
  @State private var pass = ""
  @State private var confirm = ""
  @State private var agreed = false
  @State private var busy = false
  @State private var error = ""
  @FocusState private var focus: Int?

  // https://talk.example.com/?invite=CODE, or just talk.example.com
  private var target: (server: URL, invite: String?)? {
    var s = link.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { return nil }
    if !s.contains("://") { s = "https://" + s }
    guard let c = URLComponents(string: s), let host = c.host, !host.isEmpty else { return nil }
    var base = URLComponents()
    base.scheme = c.scheme
    base.host = host
    base.port = c.port
    base.path = "/"
    return base.url.map { ($0, c.queryItems?.first { $0.name == "invite" }?.value) }
  }

  private var register: Bool { target?.invite != nil }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        Text("Talk").font(.system(size: 56, weight: .bold)).tracking(-2)
        Text(register ? "You’re invited. Choose a name and a passphrase." : "Private messages and calls for you and your people.")
          .font(.title3).foregroundStyle(Color.mut).padding(.top, 8).padding(.bottom, 28)

        field("Invite link or server", hint: "Paste the invite link a friend sent you, or your server’s address, like talk.example.com.") {
          TextField("https://talk.example.com/?invite=…", text: $link)
            .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            .focused($focus, equals: 0).submitLabel(.next).onSubmit { focus = 1 }
        }
        field("Name") {
          TextField("", text: $name).textContentType(.username).textInputAutocapitalization(.words)
            .focused($focus, equals: 1).submitLabel(.next).onSubmit { focus = 2 }
        }
        field("Passphrase", hint: register
          ? "At least 12 characters; four random words works well. It never leaves this phone, and it can’t be reset: forget it and your messages are gone."
          : "The same name and passphrase you use everywhere else.") {
          SecureField("", text: $pass).textContentType(register ? .newPassword : .password)
            .focused($focus, equals: 2).submitLabel(register ? .next : .go).onSubmit { register ? (focus = 3) : submit() }
        }
        if register {
          field("Passphrase again") {
            SecureField("", text: $confirm).textContentType(.newPassword).focused($focus, equals: 3).submitLabel(.go).onSubmit(submit)
          }
        }
        Toggle(isOn: $agreed) {
          Text("I agree to the [terms of use](https://push.princeuniverse.dev/terms): no objectionable content or abuse.")
            .font(.subheadline)
        }
        .padding(.bottom, 8)

        if !error.isEmpty {
          Text(error).font(.subheadline.weight(.medium)).foregroundStyle(Color.danger).padding(.top, 4)
        }
        Button(action: submit) {
          Text(busy ? "Unlocking…" : register ? "Create account" : "Sign in")
            .font(.headline).frame(maxWidth: .infinity, minHeight: 50)
        }
        .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(Color.fill).foregroundStyle(Color.onFill)
        .disabled(busy || target == nil || name.isEmpty || pass.isEmpty || !agreed)
        .padding(.top, 20)
      }
      .padding(24)
      .frame(maxWidth: 440)
      .frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Color.bg)
    .tint(Color.accent)
  }

  private func field(_ label: String, hint: String? = nil, @ViewBuilder _ input: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label).font(.subheadline.weight(.medium))
      input().padding(.horizontal, 16).frame(minHeight: 50).background(Color.surface, in: .rect(cornerRadius: 16))
      if let hint { Text(hint).font(.footnote).foregroundStyle(Color.mut) }
    }
    .padding(.bottom, 16)
  }

  private func submit() {
    guard let target, !busy else { return }
    let n = name.trimmingCharacters(in: .whitespaces)
    if register {
      if pass.count < 12 { return error = "Use at least 12 characters. A few random words works well." }
      if pass != confirm { return error = "The passphrases do not match." }
    }
    if !agreed { return error = register ? "Agree to the terms of use to create an account." : "Agree to the terms of use to sign in." }
    busy = true
    error = ""
    let passphrase = pass
    Task {
      defer { busy = false }
      do {
        let ident = await Task.detached { Crypto.deriveIdentity(name: n, passphrase: passphrase) }.value
        let api = API(server: target.server)
        let (id, cookie) = if let invite = target.invite {
          try await api.signIn("/api/register", ["invite": invite, "name": n, "pubkey": ident.publicKey, "auth": ident.auth])
        } else {
          try await api.signIn("/api/login", ["name": n, "auth": ident.auth])
        }
        let account = Account(server: target.server, userId: id, name: n, cookie: cookie, key: ident.privateKey.rawRepresentation)
        Vault.save(account)
        onDone(account)
      } catch let e as URLError {
        error = "Couldn’t reach \(target.server.host() ?? "the server"). \(e.localizedDescription)"
      } catch {
        self.error = error.localizedDescription
      }
    }
  }
}
