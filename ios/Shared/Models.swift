import Foundation

// Wire types, mirroring shared/types.ts. The server only ever sees
// ciphertext for message bodies, attachments and conversation keys.

nonisolated struct User: Codable, Identifiable, Hashable, Sendable {
  let id: String
  let name: String
  let pubkey: String
  var deleted: Bool?
}

nonisolated struct Conversation: Codable, Identifiable, Hashable, Sendable {
  let id: String
  let kind: String // "dm" | "group"
  let title: String?
  let members: [String]
  let wrappedKey: String
  let wrappedBy: String
  var lastMessageAt: Double?
  var lastMessage: Message?
  var unread: Int
}

nonisolated struct Message: Codable, Identifiable, Hashable, Sendable {
  let id: Int
  let convId: String
  let senderId: String
  let body: String
  let createdAt: Double
}

// Plaintext inside Message.body.
nonisolated struct MessageBody: Codable, Hashable, Sendable {
  var from: String
  var text: String?
  var files: [FileRef]?
  var call: CallLog?
}

nonisolated struct FileRef: Codable, Hashable, Sendable {
  let id: String
  let name: String
  let type: String
  let size: Int
  var voice: Voice?
}

nonisolated struct Voice: Codable, Hashable, Sendable {
  let duration: Double
  let peaks: [Double]
}

nonisolated struct CallLog: Codable, Hashable, Sendable {
  var kind: String? // "audio" | "video"
  var ms: Double? // talk time; 0 means nobody answered
  var room: String? // an old meetup call
}

nonisolated struct Me: Codable, Sendable {
  let user: User
  let users: [User]
  var conversations: [Conversation]
  let blocked: [String]?
}

nonisolated struct CallRing: Codable, Sendable {
  let id: String
  let convId: String
  let from: String
  let kind: String
}
