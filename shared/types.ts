// Wire types shared by server and client. The server only ever sees ciphertext
// for message bodies, attachment bytes and conversation keys.

export interface User {
  id: string
  name: string
  pubkey: string // X25519 public key, base64url
}

export interface Conversation {
  id: string
  kind: 'dm' | 'group'
  title: string | null
  members: string[] // user ids
  wrappedKey: string // this conversation's key, sealed for the caller
  wrappedBy: string // user id whose X25519 key sealed it
  lastMessageAt: number | null
  lastMessage: Message | null // newest message, still sealed; feeds the chat list preview
  unread: number
}

export interface Message {
  id: number
  convId: string
  senderId: string
  body: string // sealed JSON (see MessageBody), base64url
  createdAt: number
}

// Plaintext inside Message.body after decryption.
export interface MessageBody {
  from: string // must equal Message.senderId, or the client flags it
  text?: string
  files?: FileRef[]
  call?: { room: string }
}

export interface FileRef {
  id: string
  name: string
  type: string
  size: number
}

export interface Me {
  user: User
  users: User[]
  conversations: Conversation[]
  vapidPublicKey: string
  callUrl: string
}

export interface SendPayload {
  convId: string
  body: string
  notify?: 'call'
}
