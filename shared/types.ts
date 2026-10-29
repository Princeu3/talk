// Wire types shared by server and client. The server only ever sees ciphertext
// for message bodies, attachment bytes and conversation keys.

export interface User {
  id: string
  name: string
  pubkey: string // X25519 public key, base64url
  deleted?: boolean // account deleted; kept so keys it sealed still open
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
  call?: CallLog
}

export type CallKind = 'audio' | 'video'

// Posted by the caller when a call ends. `room` marks an old meetup call,
// which can no longer be joined.
export interface CallLog {
  kind?: CallKind
  ms?: number // talk time; 0 means nobody answered
  room?: string
}

// Live call signaling. Nothing here is stored: once a call ends, it's gone.
export interface CallRing {
  id: string
  convId: string
  from: string
  kind: CallKind
}

export type CallEnd = 'hangup' | 'declined' | 'cancelled' | 'missed' | 'elsewhere' | 'lost'

export interface FileRef {
  id: string
  name: string
  type: string
  size: number
  voice?: Voice // set on recorded voice messages
}

// Drawn before the audio is fetched, so the waveform shows instantly.
export interface Voice {
  duration: number // seconds
  peaks: number[] // bar heights, 0.1..1
}

export interface Me {
  user: User
  users: User[]
  conversations: Conversation[]
  blocked: string[] // user ids I blocked
  vapidPublicKey: string
}

export interface SendPayload {
  convId: string
  body: string
  quiet?: boolean // no push (call logs: the ring already notified)
}
