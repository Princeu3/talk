import Testing

@Test func incomingMessageShowsAlertOutsideOpenChat() {
  let message = Message(id: 42, convId: "chat", senderId: "sender", body: "sealed", createdAt: 0)
  let body = MessageBody(from: "sender", text: "Hello")
  let content = MessageNotifications.content(message: message, body: body, sender: "Prince",
    userId: "recipient", isActive: true, activeId: "another-chat")
  #expect(content?.title == "Prince")
  #expect(content?.body == "Hello")
  #expect(content?.sound != nil)
  #expect(content?.userInfo["convId"] as? String == "chat")
  #expect(content?.userInfo["messageId"] as? Int == 42)
  #expect(content?.threadIdentifier == "chat")

  #expect(MessageNotifications.content(message: message, body: body, sender: "Prince",
    userId: "recipient", isActive: true, activeId: "chat") == nil)
  #expect(MessageNotifications.content(message: message, body: body, sender: "Prince",
    userId: "sender", isActive: true, activeId: nil) == nil)
  #expect(MessageNotifications.content(message: message, body: body, sender: "Prince",
    userId: "recipient", isActive: false, activeId: nil) == nil)
}

@Test func unverifiedMessageUsesGenericNotification() {
  let message = Message(id: 42, convId: "chat", senderId: "sender", body: "sealed", createdAt: 0)
  for body: MessageBody? in [nil, MessageBody(from: "someone-else", text: "Forged")] {
    let content = MessageNotifications.content(message: message, body: body, sender: "Prince",
      userId: "recipient", isActive: true, activeId: nil)
    #expect(content?.body == "New message")
  }
}
