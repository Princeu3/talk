import CryptoKit
import Intents
import UserNotifications

// Pushes carry ids only. This fetches the sealed message, decrypts it on the
// phone, and shows the sender's name and text as a communication
// notification. If anything fails, the push's own "New message" shows.
// shortcut: @unchecked, since the system calls in once per instance and waits.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
  private var deliver: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler handler: @escaping (UNNotificationContent) -> Void) {
    deliver = handler
    fallback = request.content
    let info = request.content.userInfo
    guard let account = Vault.load(), let convId = info["convId"] as? String else { return handler(request.content) }
    let messageId = info["messageId"] as? Int
    let base = Unchecked(request.content)
    Task {
      let content = (try? await Self.decrypt(account, convId: convId, messageId: messageId, base: base.value)) ?? base.value
      deliver?(content)
      deliver = nil
    }
  }

  override func serviceExtensionTimeWillExpire() {
    if let deliver, let fallback { deliver(fallback) }
    deliver = nil
  }

  private static func decrypt(_ account: Account, convId: String, messageId: Int?, base: UNNotificationContent) async throws -> UNNotificationContent {
    let api = account.api
    let me: Me = try await api.call("GET", "/api/me")
    guard let conv = me.conversations.first(where: { $0.id == convId }),
          let wrapper = me.users.first(where: { $0.id == conv.wrappedBy }) else { return base }
    let name = { (id: String) in me.users.first { $0.id == id }?.name ?? "Someone" }
    let content = base.mutableCopy() as! UNMutableNotificationContent
    content.badge = me.conversations.reduce(0) { $0 + $1.unread } as NSNumber

    var sender = conv.members.first { $0 != account.userId } ?? account.userId
    if let messageId {
      let page: [Message] = try await api.call("GET", "/api/conversations/\(convId)/messages?before=\(messageId + 1)")
      guard let msg = page.last, msg.id == messageId else { return base }
      let key = SymmetricKey(data: try Crypto.unwrapConvKey(conv.wrappedKey, mine: account.privateKey, wrapperPub: wrapper.pubkey, convId: convId, myId: account.userId))
      let body: MessageBody = try Crypto.openMessage(key, convId: convId, msg.body)
      sender = msg.senderId
      content.body = body.text ?? preview(body)
    }
    let title = conv.title ?? name(sender)
    content.title = conv.kind == "group" ? "\(name(sender)) in \(title)" : title

    // A communication notification: the sender's name, grouped by chat.
    let person = INPerson(personHandle: INPersonHandle(value: sender, type: .unknown), nameComponents: nil,
                          displayName: name(sender), image: nil, contactIdentifier: nil, customIdentifier: sender)
    let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText, content: content.body,
                                     speakableGroupName: conv.kind == "group" ? INSpeakableString(spokenPhrase: title) : nil,
                                     conversationIdentifier: convId, serviceName: nil, sender: person, attachments: nil)
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    try? await interaction.donate()
    return (try? content.updating(from: intent)) ?? content
  }

  private static func preview(_ b: MessageBody) -> String {
    guard let files = b.files, let first = files.first else { return "New message" }
    if first.voice != nil { return "Voice message" }
    if files.allSatisfy({ $0.type.hasPrefix("image/") }) { return files.count == 1 ? "Photo" : "\(files.count) photos" }
    return files.count == 1 ? first.name : "\(files.count) files"
  }
}

private struct Unchecked<T>: @unchecked Sendable {
  let value: T
  init(_ value: T) { self.value = value }
}
