import CryptoKit
import Foundation
import Security

// The signed-in account. It lives in the keychain, shared with the
// notification extension, readable after the first unlock so pushes can be
// decrypted while the phone is locked.
nonisolated struct Account: Codable, Sendable {
  let server: URL
  let userId: String
  let name: String
  let cookie: String // talk_session=...
  let key: Data // raw X25519 private key

  var privateKey: Curve25519.KeyAgreement.PrivateKey { try! .init(rawRepresentation: key) }
  var api: API { API(server: server, cookie: cookie) }
}

nonisolated enum Vault {
  private static var query: [String: Any] { [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "talk",
    kSecAttrAccount as String: "account",
    kSecAttrAccessGroup as String: "RMVX38Q6NU.dev.princeuniverse.talk.shared",
  ] }

  static func load() -> Account? {
    var out: AnyObject?
    let q = query.merging([kSecReturnData as String: true]) { $1 }
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return try? JSONDecoder().decode(Account.self, from: data)
  }

  static func save(_ account: Account) {
    clear()
    let q = query.merging([
      kSecValueData as String: try! JSONEncoder().encode(account),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]) { $1 }
    let status = SecItemAdd(q as CFDictionary, nil)
    if status != errSecSuccess { print("[vault] save failed", status) }
  }

  static func clear() { SecItemDelete(query as CFDictionary) }
}

nonisolated struct APIError: LocalizedError {
  let status: Int
  let message: String
  var errorDescription: String? { message }
}

nonisolated struct OK: Decodable {}
nonisolated struct Created: Decodable { let id: String }

// REST client. Cookies are handled by hand (not HTTPCookieStorage) so the
// notification extension can send the same session.
nonisolated struct API: Sendable {
  let server: URL
  var cookie: String?

  private static let session: URLSession = {
    let c = URLSessionConfiguration.default
    c.httpCookieStorage = nil
    c.httpShouldSetCookies = false
    c.timeoutIntervalForRequest = 30
    return URLSession(configuration: c)
  }()

  func data(_ method: String, _ path: String, body: Data? = nil, type: String = "application/json") async throws -> (Data, HTTPURLResponse) {
    var req = URLRequest(url: URL(string: path, relativeTo: server)!)
    req.httpMethod = method
    if let cookie { req.setValue(cookie, forHTTPHeaderField: "Cookie") }
    if let body {
      req.httpBody = body
      req.setValue(type, forHTTPHeaderField: "Content-Type")
    }
    let (data, res) = try await Self.session.data(for: req)
    let http = res as! HTTPURLResponse
    guard (200..<300).contains(http.statusCode) else {
      let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
      throw APIError(status: http.statusCode, message: msg ?? "HTTP \(http.statusCode)")
    }
    return (data, http)
  }

  func call<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> T {
    let (data, _) = try await self.data(method, path, body: body.map { try! JSONSerialization.data(withJSONObject: $0) })
    return try JSONDecoder().decode(T.self, from: data)
  }

  // Register or log in; returns the user id and the session cookie.
  func signIn(_ path: String, _ body: [String: Any]) async throws -> (id: String, cookie: String) {
    let (data, res) = try await self.data("POST", path, body: try JSONSerialization.data(withJSONObject: body))
    let id = try JSONDecoder().decode(Created.self, from: data).id
    let header = res.value(forHTTPHeaderField: "Set-Cookie") ?? ""
    guard let cookie = header.split(separator: ";").first.map(String.init), cookie.hasPrefix("talk_session=") else {
      throw APIError(status: 0, message: "The server didn't start a session.")
    }
    return (id, cookie)
  }
}
