import UserNotifications

nonisolated enum MessageNotifications {
  // The server suppresses remote pushes while this app is active. Surface live
  // socket messages locally unless the recipient is already viewing that chat.
  static func content(message: Message, body: MessageBody?, sender: String,
                      userId: String, isActive: Bool, activeId: String?) -> UNMutableNotificationContent? {
    guard isActive, message.senderId != userId, message.convId != activeId else { return nil }
    let content = UNMutableNotificationContent()
    content.title = sender
    content.body = body?.from == message.senderId ? (body?.text ?? "New message") : "New message"
    content.sound = .default
    content.threadIdentifier = message.convId
    content.userInfo = ["convId": message.convId, "messageId": message.id]
    return content
  }
}
