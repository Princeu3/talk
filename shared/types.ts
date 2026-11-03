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
  reads?: Record<string, number> // each member's last read message id, for read receipts
  muted?: boolean // mine: no pushes for messages or group call rings
  pinned?: boolean // mine: listed first
  call?: GroupCall // a group call on now
}

// A live group call, as the chat's members see it. `peers` are the user ids in it.
export interface GroupCall {
  id: string
  kind: CallKind
  from: string // who started it
  peers: string[]
}

export interface Message {
  id: number
  convId: string
  senderId: string
  body: string // sealed JSON (see MessageBody), base64url
  createdAt: number
  editedAt?: number
  reactions?: Reaction[]
}

export interface Reaction {
  userId: string
  body: string // sealed ReactionBody
}

// Plaintext inside Reaction.body. `from` and `to` must match the row, or the client ignores it.
export interface ReactionBody {
  from: string
  to: number // message id
  emoji: string
}

// Plaintext inside Message.body after decryption.
export interface MessageBody {
  from: string // must equal Message.senderId, or the client flags it
  text?: string
  files?: FileRef[]
  call?: CallLog
  reply?: Reply
  forwarded?: boolean
  system?: boolean // a group event ("Alice added Bob"); `text` holds it, so older apps show it as a message
}

// Quoted in a reply, so it shows even when the original isn't loaded or was unsent.
export interface Reply {
  id: number
  from: string // user id of the quoted message's sender
  preview: string // its text, or "Photo", "Voice message", ...; at most 200 chars
}

export type CallKind = 'audio' | 'video'

// Posted by the caller when a call ends. `room` marks an old meetup call,
// which can no longer be joined.
export interface CallLog {
  kind?: CallKind
  ms?: number // talk time; 0 means nobody answered
  room?: string
  group?: boolean
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
  seen?: boolean // not unread for anyone (an answered call: both were there)
  cid?: string // client-made UUID; a resend with the same one acks the stored message
}
