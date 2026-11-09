// All app data and actions in one hook; components only render what it returns.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, socket } from './api.ts'
import * as c from './crypto.ts'
import { fits, names, userName } from './format.ts'
import type { Agent, Conversation, FileRef, GroupCall, LinkPreview, Me, Message, MessageBody, Reaction, ReactionBody, Voice } from '../../shared/types.ts'

export interface Decrypted extends Message {
  content: MessageBody | null // null: could not decrypt
  forged: boolean // inner sender differs from the one the server claims
  system: boolean // a group event line; a forged one shows as a plain (flagged) message
  reacts?: Record<string, string> // user id -> emoji, only reactions that check out
}

// A message on its way out, sealed. Resends reuse `cid`, so the server stores it once.
export interface Pending {
  cid: string
  convId: string
  body: string
  content: MessageBody
  createdAt: number
  quiet?: boolean
  seen?: boolean
  sending: boolean // false: waiting for the socket
  error?: string // the server refused it; no automatic resend
}

const PAGE = 50
const ARCHIVE_PAGE = 500 // the server's most
export const MAX_FILE = 50 * 1024 * 1024
export const AUTO_LOAD = 25 * 1024 * 1024 // bigger files wait for a tap

const bump = (list: Conversation[], msg: Message, unread: boolean) =>
  list
    .map((x) => (x.id === msg.convId ? { ...x, lastMessageAt: msg.createdAt, unread: x.unread + (unread ? 1 : 0) } : x))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))

const withReaction = (reacts: Record<string, string> | undefined, userId: string, emoji: string | null) => {
  const { [userId]: _, ...rest } = reacts ?? {}
  return emoji ? { ...rest, [userId]: emoji } : rest
}

// A reaction counts only if it names its own row, so the server can't move one onto another message.
async function openReaction(key: CryptoKey, convId: string, messageId: number, r: Reaction) {
  try {
    const b = await c.openMessage<ReactionBody>(key, convId, r.body)
    return b.from === r.userId && b.to === messageId && typeof b.emoji === 'string' && b.emoji.length <= 16 ? b.emoji : null
  } catch {
    return null
  }
}

// A link's card for the composer. The server reads the page (the web can't fetch other sites);
// `url` stays the link as typed, so anyone can tell whether it's still in the text.
export async function unfurl(link: string): Promise<LinkPreview> {
  const r = await api<LinkPreview & { imageType?: string }>('POST', '/api/unfurl', { url: link })
  const image = r.image && (await shrink(r.image, r.imageType).catch(() => undefined))
  return { url: link, title: r.title, description: r.description, site: r.site, image }
}

// The wire's thumbnail: JPEG, longest side ≤ 320 px, ≤ 24 KB. Steps quality, then size, down until it fits; else none.
async function shrink(b64: string, type?: string) {
  const bmp = await createImageBitmap(new Blob([c.unb64(b64) as BlobPart], { type }))
  try {
    for (let side = 320; side >= 80; side = Math.round(side * 0.75)) {
      const k = Math.min(1, side / Math.max(bmp.width, bmp.height))
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)))
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff' // JPEG has no transparency; a logo's clear parts would turn black
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.8, 0.6, 0.4]) {
        const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer())
        if (jpeg.length <= 24 * 1024) return btoa(String.fromCharCode(...jpeg))
      }
    }
  } finally {
    bmp.close()
  }
}

// A pending helper proved its key with the secret from a link this browser made: HMAC-SHA256 of
// 'talk-pair-v1:' + its key. 'no secret': the link came from another browser (or was used here already).
async function checkAgent(a: Agent): Promise<'no secret' | 'bad proof' | 'ok'> {
  const s = localStorage.getItem(`talk:agent-link:${a.invite}`)
  if (!s) return 'no secret'
  const key = await crypto.subtle.importKey('raw', c.unb64(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  return (await crypto.subtle.verify('HMAC', key, c.unb64(a.proof), new TextEncoder().encode(`talk-pair-v1:${a.pubkey}`))) ? 'ok' : 'bad proof'
}

export function useTalk(privateKey: CryptoKey, onSignedOut: () => void) {
  const [me, setMe] = useState<Me | null>(null)
  const [messages, setMessages] = useState<Record<string, Decrypted[]>>({})
  const [hasOlder, setHasOlder] = useState<Record<string, boolean>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  // Unsent, oldest first, all chats. The ref is the truth (drain reads it between awaits); state mirrors it.
  // shortcut: in memory, so a reload drops unsent messages; IndexedDB if that bites.
  const queue = useRef<Pending[]>([])
  const [pending, setPending] = useState<Pending[]>([])
  const [typers, setTypers] = useState<Record<string, string[]>>({}) // conv id -> who is typing there
  const typingTimers = useRef(new Map<string, number>())
  const lastTyping = useRef(0)

  const meRef = useRef(me)
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const draining = useRef(false)
  const keys = useRef(new Map<string, { key: CryptoKey; raw: Uint8Array<ArrayBuffer> }>())
  const loaded = useRef(new Set<string>())
  const blobs = useRef(new Map<string, Promise<string>>())
  const heard = useRef(0) // messages received, so a reload can tell it raced one
  // load() needs decrypt(), which needs keyFor(), which needs load(): break the cycle with a ref.
  const decryptRef = useRef<(m: Message) => Promise<Decrypted>>(null!)
  const msgRef = useRef(messages)
  msgRef.current = messages
  // Older history for search and shared media, newest first, below what `messages` held when paging began.
  // Decrypted in memory for this session only, never React state (a page must not re-render the chat).
  // shortcut: every session pages and decrypts history again; persist to an index once a device's history makes the first search slow.
  const archive = useRef(new Map<string, { list: Decrypted[]; done: boolean; busy?: Promise<boolean> }>())
  const [focus, setFocus] = useState<{ convId: string; id: number } | null>(null) // a message to scroll to and flash

  const load = useCallback(async (again = true): Promise<Me> => {
    try {
      const before = heard.current
      const m = await api<Me>('GET', '/api/me')
      // A message landed while this was in flight (a rename's sync, then its line): the
      // answer may predate it and would undo its bump, so ask again, once (a busy chat never goes quiet).
      if (again && heard.current !== before) return load(false)
      // The open chat is read even if the server hasn't heard yet (that request may still be in flight).
      const shown = activeRef.current && !document.hidden ? activeRef.current : null
      m.conversations = m.conversations.map((x) => (x.id === shown ? { ...x, unread: 0 } : x))
      meRef.current = m
      setMe(m)
      // Left or removed from the open chat: close it rather than show an empty pane.
      if (activeRef.current && !m.conversations.some((x) => x.id === activeRef.current)) setActiveId(null)
      for (const id of archive.current.keys()) if (!m.conversations.some((x) => x.id === id)) archive.current.delete(id)
      for (const conv of m.conversations)
        if (conv.lastMessage) decryptRef.current(conv.lastMessage).then((d) => merge(conv.id, [d]))
      return m
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onSignedOut()
      throw e
    }
  }, [onSignedOut])

  const keyFor = useCallback(
    async (convId: string) => {
      const hit = keys.current.get(convId)
      if (hit) return hit
      let m = meRef.current
      if (!m?.conversations.some((x) => x.id === convId)) m = await load()
      const conv = m.conversations.find((x) => x.id === convId)!
      const wrapper = m.users.find((u) => u.id === conv.wrappedBy)!
      const k = await c.unwrapConvKey(conv.wrappedKey, privateKey, wrapper.pubkey, convId, m.user.id)
      keys.current.set(convId, k)
      return k
    },
    [load, privateKey],
  )

  const decrypt = useCallback(
    async (msg: Message): Promise<Decrypted> => {
      try {
        const { key } = await keyFor(msg.convId)
        const content = await c.openMessage<MessageBody>(key, msg.convId, msg.body)
        const list = msg.reactions ?? []
        const emojis = await Promise.all(list.map((r) => openReaction(key, msg.convId, msg.id, r)))
        const reacts: Record<string, string> = {}
        list.forEach((r, i) => {
          const emoji = emojis[i]
          if (emoji) reacts[r.userId] = emoji
        })
        // The sender picks the card's link and screens use it as an href: http(s) only.
        if (content.preview && !/^https?:\/\//i.test(String(content.preview.url))) delete content.preview
        const forged = content.from !== msg.senderId
        return { ...msg, content, forged, system: !!content.system && !forged, reacts }
      } catch {
        return { ...msg, content: null, forged: false, system: false }
      }
    },
    [keyFor],
  )
  decryptRef.current = decrypt

  const merge = (convId: string, list: Decrypted[]) =>
    setMessages((prev) => {
      const byId = new Map((prev[convId] ?? []).map((m) => [m.id, m]))
      for (const m of list) byId.set(m.id, m)
      return { ...prev, [convId]: [...byId.values()].sort((a, b) => a.id - b.id) }
    })

  // Changes a message we hold, open or archived (null drops it); one we don't arrives whole with its page.
  const update = (convId: string, id: number, fn: (m: Decrypted) => Decrypted | null) => {
    const a = archive.current.get(convId)
    if (a) a.list = a.list.flatMap((m) => (m.id !== id ? [m] : (fn(m) ?? [])))
    setMessages((prev) => {
      const list = prev[convId]
      if (!list?.some((m) => m.id === id)) return prev
      return { ...prev, [convId]: list.flatMap((m) => (m.id !== id ? [m] : (fn(m) ?? []))) }
    })
  }

  // An edit arrives without reactions; keep the ones we hold.
  const applyEdit = useCallback(
    async (msg: Message) => {
      const d = await decrypt(msg)
      update(msg.convId, msg.id, (x) => ({ ...d, reacts: x.reacts }))
    },
    [decrypt],
  )

  const patchConv = (convId: string, fn: (x: Conversation) => Conversation) =>
    setMe((m) => m && { ...m, conversations: m.conversations.map((x) => (x.id === convId ? fn(x) : x)) })

  // Someone shows as typing for 6 s after their last signal, or until their message lands.
  const setTyper = (convId: string, userId: string, on: boolean) => {
    const k = `${convId} ${userId}`
    clearTimeout(typingTimers.current.get(k))
    if (on) typingTimers.current.set(k, window.setTimeout(() => setTyper(convId, userId, false), 6000))
    setTypers((p) => {
      if (!on && !p[convId]?.includes(userId)) return p
      const rest = (p[convId] ?? []).filter((u) => u !== userId)
      return { ...p, [convId]: on ? [...rest, userId] : rest }
    })
  }

  const setQueue = (next: Pending[]) => {
    queue.current = next
    setPending(next)
  }
  // null drops the item.
  const patch = (p: Pending, change: Partial<Pending> | null) =>
    setQueue(queue.current.flatMap((x) => (x.cid !== p.cid ? [x] : change ? [{ ...x, ...change }] : [])))

  // One at a time, oldest first, so messages land in the order they were written. Nothing goes out
  // offline: socket.io would buffer it and flush it on reconnect ahead of older messages.
  const drain = useCallback(async () => {
    if (draining.current) return
    draining.current = true
    let p: Pending | undefined
    while (socket.connected && (p = queue.current.find((x) => !x.error))) {
      const { convId, body, quiet, seen, cid, content } = p
      try {
        const r = await socket.timeout(15_000).emitWithAck('send', { convId, body, quiet, seen, cid })
        if (r.error) patch(p, { sending: false, error: r.error })
        else {
          merge(convId, [{ ...r.message, content, forged: false, system: !!content.system }])
          patch(p, null)
        }
      } catch {
        // No answer in time, or the socket dropped. Online, the loop resends it; the cid stores it once.
      }
    }
    setQueue(queue.current.map((x) => (x.error ? x : { ...x, sending: false })))
    draining.current = false
  }, [])

  const fetchPage = useCallback(
    async (convId: string, before?: number) => {
      const page = await api<Message[]>('GET', `/api/conversations/${convId}/messages${before ? `?before=${before}` : ''}`)
      merge(convId, await Promise.all(page.map(decrypt)))
      if (before || !loaded.current.has(convId)) setHasOlder((p) => ({ ...p, [convId]: page.length === PAGE }))
      loaded.current.add(convId)
    },
    [decrypt],
  )

  useEffect(() => {
    load().catch(() => {})
    const onMessage = async (msg: Message) => {
      heard.current++
      const d = await decrypt(msg)
      merge(msg.convId, [d])
      setTyper(msg.convId, msg.senderId, false)
      const mine = msg.senderId === meRef.current?.user.id
      const seen = (activeRef.current === msg.convId && !document.hidden) || !!d.content?.call?.ms || d.system
      setMe((m) => m && { ...m, conversations: bump(m.conversations, msg, !mine && !seen) })
    }
    const onReaction = async ({ messageId, convId, userId, body }: { messageId: number; convId: string; userId: string; body: string | null }) => {
      const emoji = body && (await openReaction((await keyFor(convId)).key, convId, messageId, { userId, body }))
      update(convId, messageId, (m) => ({ ...m, reacts: withReaction(m.reacts, userId, emoji || null) }))
    }
    const onUnsend = ({ id, convId }: { id: number; convId: string }) => update(convId, id, () => null)
    const onRead = ({ convId, userId, upTo }: { convId: string; userId: string; upTo: number }) =>
      patchConv(convId, (x) => ({ ...x, reads: { ...x.reads, [userId]: upTo } }))
    const onTyping = ({ convId, userId }: { convId: string; userId: string }) => setTyper(convId, userId, true)
    const onSync = () => void load().catch(() => {})
    const onCall = ({ convId, call }: { convId: string; call: GroupCall | null }) => patchConv(convId, (x) => ({ ...x, call: call ?? undefined }))
    // Reconnects (phones drop sockets constantly) refetch what we may have missed.
    const onConnect = () => {
      socket.emit('active', !document.hidden)
      onSync()
      for (const id of loaded.current) fetchPage(id).catch(() => {})
      setQueue(queue.current.map((x) => (x.error ? x : { ...x, sending: true })))
      drain()
    }
    const onError = (e: Error) => e.message === 'signed out' && onSignedOut()
    const onVisibility = () => socket.emit('active', !document.hidden)

    socket.on('message', onMessage)
    socket.on('edit', applyEdit)
    socket.on('reaction', onReaction)
    socket.on('unsend', onUnsend)
    socket.on('read', onRead)
    socket.on('typing', onTyping)
    socket.on('sync', onSync)
    socket.on('call:update', onCall)
    socket.on('connect', onConnect)
    socket.on('connect_error', onError)
    document.addEventListener('visibilitychange', onVisibility)
    socket.connect()
    return () => {
      socket.off('message', onMessage)
      socket.off('edit', applyEdit)
      socket.off('reaction', onReaction)
      socket.off('unsend', onUnsend)
      socket.off('read', onRead)
      socket.off('typing', onTyping)
      socket.off('sync', onSync)
      socket.off('call:update', onCall)
      socket.off('connect', onConnect)
      socket.off('connect_error', onError)
      document.removeEventListener('visibilitychange', onVisibility)
      socket.disconnect()
    }
  }, [load, keyFor, decrypt, applyEdit, fetchPage, drain, onSignedOut])

  // Mark the open conversation read whenever its newest message changes.
  const lastId = activeId ? messages[activeId]?.at(-1)?.id : undefined
  useEffect(() => {
    if (!activeId || !lastId) return
    const markRead = () => {
      if (document.hidden) return
      api('POST', `/api/conversations/${activeId}/read`, { upTo: lastId }).catch(() => {})
      patchConv(activeId, (x) => ({ ...x, unread: 0 }))
    }
    markRead()
    document.addEventListener('visibilitychange', markRead)
    return () => document.removeEventListener('visibilitychange', markRead)
  }, [activeId, lastId])

  const totalUnread = me?.conversations.reduce((n, x) => n + x.unread, 0) ?? 0
  useEffect(() => {
    document.title = totalUnread ? `(${totalUnread}) Talk` : 'Talk'
    if (totalUnread) navigator.setAppBadge?.(totalUnread).catch(() => {})
    else navigator.clearAppBadge?.().catch(() => {})
  }, [totalUnread])

  const open = useCallback(
    (convId: string | null) => {
      setActiveId(convId)
      if (convId && !loaded.current.has(convId)) fetchPage(convId).catch(() => {})
    },
    [fetchPage],
  )

  // Scrolling up after a jump takes the archive below the chat before asking the server again.
  const loadOlder = async (convId: string) => {
    const first = messages[convId]?.[0]
    if (!first) return
    const next = archive.current.get(convId)?.list.filter((m) => m.id < first.id).slice(0, PAGE)
    if (next?.length) merge(convId, next)
    else await fetchPage(convId, first.id)
  }

  // One more page of a chat's history into the archive; true once it holds the first message.
  const older = useCallback((convId: string) => {
    let a = archive.current.get(convId)
    if (!a) archive.current.set(convId, (a = { list: [], done: false }))
    if (a.done) return Promise.resolve(true)
    const arch = a
    return (arch.busy ??= (async () => {
      try {
        const from = arch.list.at(-1)?.id ?? msgRef.current[convId]?.[0]?.id
        const page = await api<Message[]>('GET', `/api/conversations/${convId}/messages?limit=${ARCHIVE_PAGE}${from ? `&before=${from}` : ''}`)
        const list = await Promise.all(page.map(decrypt))
        if (archive.current.get(convId) !== arch) return true // dropped meanwhile (left, unblocked)
        arch.list.push(...list.reverse()) // pages come oldest first
        arch.done = page.length < ARCHIVE_PAGE
        return arch.done
      } finally {
        arch.busy = undefined
      }
    })())
  }, [decrypt])

  // Pages chats' history into the archive, 3 chats at a time. onPage runs as pages land (at most every
  // 300 ms), then once with true when all are in; a chat whose page fails counts as done. Returns a stop.
  const backfill = useCallback(
    (ids: string[], onPage: (finished: boolean) => void) => {
      let stop = false
      let last = 0
      const todo = [...ids]
      const worker = async () => {
        for (let id; !stop && (id = todo.shift()); )
          while (!stop && !(await older(id).catch(() => true)))
            if (Date.now() - last >= 300) {
              last = Date.now()
              onPage(false)
            }
      }
      void Promise.all([worker(), worker(), worker()]).then(() => stop || onPage(true))
      return () => {
        stop = true
      }
    },
    [older],
  )

  // All of a chat we hold, newest first: what the chat shows, then the archive below it.
  const history = useCallback((convId: string) => {
    const shown = msgRef.current[convId] ?? []
    const a = archive.current.get(convId)
    const floor = shown[0]?.id ?? Infinity
    return { list: shown.toReversed().concat(a?.list.filter((m) => m.id < floor) ?? []), done: !!a?.done }
  }, [])

  // Opens a chat at a message (from search or shared media): the archive from it up joins the chat, which scrolls to it.
  // shortcut: the chat then renders everything from that message down; window the list if far jumps get slow.
  const openAt = (convId: string, id: number) => {
    const a = archive.current.get(convId)?.list
    const i = a?.findIndex((m) => m.id === id) ?? -1
    if (i >= 0) merge(convId, a!.slice(0, i + 1))
    setFocus({ convId, id })
    open(convId)
  }

  const seal = async (convId: string, plain: MessageBody | ReactionBody) => {
    if ('preview' in plain && plain.preview && !fits(plain.preview, plain.text)) plain = { ...plain, preview: undefined }
    const { key } = await keyFor(convId)
    const body = await c.sealMessage(key, convId, plain)
    // The server's limit; caught here, so the draft comes back instead of a row that can never send.
    if (body.length > 64 * 1024) throw new Error('That message is too long to send.')
    return body
  }

  // Sealed and queued; resolves before the server hears, and a failure shows on the pending row.
  const send = async (convId: string, content: Omit<MessageBody, 'from'>, quiet?: boolean, seen?: boolean) => {
    const full = { ...content, from: meRef.current!.user.id }
    const body = await seal(convId, full)
    const p: Pending = { cid: crypto.randomUUID(), convId, body, content: full, createdAt: Date.now(), quiet, seen, sending: socket.connected }
    setQueue([...queue.current, p])
    lastTyping.current = 0 // receivers drop us when this lands, so the next draft signals at once
    drain()
  }

  const retry = (p: Pending) => {
    patch(p, { sending: socket.connected, error: undefined })
    drain()
  }
  const discard = (p: Pending) => patch(p, null)

  const sendWithFiles = async (convId: string, text: string, files: File[], voice?: Voice, extra?: Pick<MessageBody, 'reply' | 'forwarded' | 'preview'>) => {
    const { key } = await keyFor(convId)
    const refs: FileRef[] = []
    for (const f of files) {
      if (f.size > MAX_FILE) throw new Error(`${f.name} is over 50 MB`)
      const sealed = await c.sealFile(key, convId, new Uint8Array(await f.arrayBuffer()))
      const { id } = await api<{ id: string }>('POST', `/api/conversations/${convId}/attachments`, sealed)
      refs.push({ id, name: f.name, type: f.type || 'application/octet-stream', size: f.size, ...(voice && { voice }) })
    }
    await send(convId, { ...extra, text: text || undefined, files: refs.length ? refs : undefined })
  }

  // Decrypted attachment as a blob: URL, fetched once per session.
  const fileUrl = (convId: string, ref: FileRef) => {
    let p = blobs.current.get(ref.id)
    if (!p) {
      p = (async () => {
        const { key } = await keyFor(convId)
        const data = new Uint8Array(await api<ArrayBuffer>('GET', `/api/attachments/${ref.id}`))
        const plain = await c.openFile(key, convId, data)
        return URL.createObjectURL(new Blob([plain as BlobPart], { type: ref.type }))
      })()
      blobs.current.set(ref.id, p)
      p.catch(() => blobs.current.delete(ref.id))
    }
    return p
  }

  // One user id makes (or reuses) a DM; more make a group. `pins` are keys to wrap for in place of the listed ones.
  const createConversation = async (userIds: string[], title?: string, pins?: Record<string, string>) => {
    const m = meRef.current!
    if (userIds.length === 1) {
      const existing = m.conversations.find((x) => x.kind === 'dm' && x.members.includes(userIds[0]))
      if (existing) return existing.id
    }
    const id = crypto.randomUUID()
    const raw = c.newConvKeyBytes()
    const ids = [m.user.id, ...userIds]
    const members = await Promise.all(
      ids.map(async (uid) => ({
        userId: uid,
        wrappedKey: await c.wrapConvKey(raw, privateKey, pins?.[uid] ?? m.users.find((u) => u.id === uid)!.pubkey, id, uid),
      })),
    )
    const kind = userIds.length === 1 ? 'dm' : 'group'
    await api('POST', '/api/conversations', { id, kind, title: kind === 'group' ? title : undefined, members })
    await load()
    return id
  }

  // My public key from my private key, X25519(priv, 9): never the server's copy, which it could swap.
  const ownPubkey = async () => {
    const base = new Uint8Array(32)
    base[0] = 9 // the X25519 base point
    const pt = await crypto.subtle.importKey('raw', base, { name: 'X25519' }, false, [])
    return c.b64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: pt }, privateKey, 256)))
  }

  // A 10-minute, one-use helper link. Its fragment (never sent to the server) pins my id, my key and
  // a secret that talkline proves it holds; this browser keeps the secret to check that proof at Allow.
  const linkAgent = async () => {
    const m = meRef.current!
    const k = await ownPubkey()
    if (k !== m.user.pubkey) throw new Error('This server has a different key for you. Don’t link a helper here.')
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const { code, expiresAt } = await api<{ code: string; expiresAt: number }>('POST', '/api/invites', { agent: true, tz })
    const s = c.b64(crypto.getRandomValues(new Uint8Array(32)))
    // shortcut: only the browser that made the link can Allow, and unused entries stay; sync the secret across devices if owners link on one and allow on another.
    localStorage.setItem(`talk:agent-link:${code}`, s)
    return { link: `${location.origin}/?agent=${code}#o=${m.user.id}&k=${k}&s=${s}`, expiresAt }
  }

  // Allow: the DM is the approval. Its key is wrapped for the helper key whose proof just checked and for
  // my key from my private key, never for keys from `users` or a reloaded `me`, where the server could swap one.
  const allowAgent = async (a: Agent) => {
    if ((await checkAgent(a)) !== 'ok') throw new Error('This helper didn’t prove it has your link. Deny it.')
    await createConversation([a.id], undefined, { [meRef.current!.user.id]: await ownPubkey(), [a.id]: a.pubkey })
    localStorage.removeItem(`talk:agent-link:${a.invite}`)
  }

  // A group event as a centered line ("Alice added Bob"), sealed like any message.
  const announce = (convId: string, sentence: string) =>
    send(convId, { system: true, text: `${meRef.current!.user.name} ${sentence}` }, true, true)

  const addMembers = async (convId: string, userIds: string[]) => {
    const { raw } = await keyFor(convId)
    const m = meRef.current!
    for (const userId of userIds) {
      const user = m.users.find((u) => u.id === userId)!
      const wrappedKey = await c.wrapConvKey(raw, privateKey, user.pubkey, convId, userId)
      await api('POST', `/api/conversations/${convId}/members`, { userId, wrappedKey })
    }
    await announce(convId, `added ${names(userIds.map((id) => userName(m, id)))}`)
    await load()
  }

  // Picking your current emoji again takes it off.
  const react = async (m: Decrypted, emoji: string) => {
    const myId = meRef.current!.user.id
    const off = m.reacts?.[myId] === emoji
    if (off) await api('DELETE', `/api/messages/${m.id}/reaction`)
    else await api('PUT', `/api/messages/${m.id}/reaction`, { body: await seal(m.convId, { from: myId, to: m.id, emoji }) })
    update(m.convId, m.id, (x) => ({ ...x, reacts: withReaction(x.reacts, myId, off ? null : emoji) }))
  }

  // New text, everything else (reply, files, forwarded) kept; seal() drops a card whose link is gone.
  const edit = async (m: Decrypted, text: string) => {
    const body = await seal(m.convId, { ...m.content, text, from: meRef.current!.user.id })
    const { message } = await api<{ message: Message }>('PATCH', `/api/messages/${m.id}`, { body })
    await applyEdit(message)
  }

  const unsend = async (m: Decrypted) => {
    await api('DELETE', `/api/messages/${m.id}`)
    update(m.convId, m.id, () => null)
  }

  // Files are decrypted here and sealed again with the other chat's key.
  const forward = async (m: Decrypted, convId: string) => {
    const { text, files, preview } = m.content!
    if (!files?.length) return send(convId, { text, preview, forwarded: true })
    const plain = await Promise.all(
      files.map(async (f) => new File([await (await fetch(await fileUrl(m.convId, f))).blob()], f.name, { type: f.type })),
    )
    await sendWithFiles(convId, text ?? '', plain, files[0].voice, { forwarded: true, preview })
  }

  const typing = (convId: string) => {
    if (Date.now() - lastTyping.current < 3000) return
    lastTyping.current = Date.now()
    socket.emit('typing', { convId })
  }

  // These endpoints send us `sync`, which reloads; local patches only make the change show at once.
  const setMine = async (convId: string, change: { muted?: boolean; pinned?: boolean }) => {
    await api('PATCH', `/api/conversations/${convId}/me`, change)
    patchConv(convId, (x) => ({ ...x, ...change }))
  }

  const rename = async (convId: string, title: string) => {
    await api('PATCH', `/api/conversations/${convId}`, { title })
    patchConv(convId, (x) => ({ ...x, title }))
    await announce(convId, `named the group “${title}”`)
  }

  const removeMember = async (convId: string, userId: string) => {
    await api('DELETE', `/api/conversations/${convId}/members/${userId}`)
    patchConv(convId, (x) => ({ ...x, members: x.members.filter((u) => u !== userId) }))
    await announce(convId, `removed ${userName(meRef.current!, userId)}`)
  }

  // The line goes out first, since the server refuses a non-member's message. Emitted
  // directly (with a cid) instead of queued, so it has landed before we leave.
  const leave = async (convId: string) => {
    const m = meRef.current!
    const body = await seal(convId, { from: m.user.id, system: true, text: `${m.user.name} left` })
    await socket.timeout(15_000).emitWithAck('send', { convId, body, quiet: true, seen: true, cid: crypto.randomUUID() }).catch(() => {})
    await api('DELETE', `/api/conversations/${convId}/members/${m.user.id}`)
    if (activeRef.current === convId) setActiveId(null)
  }

  // The server hides a blocked person's messages from now on; drop the ones on screen too.
  const hideFrom = (userId: string) => {
    for (const a of archive.current.values()) a.list = a.list.filter((x) => x.senderId !== userId)
    setMessages((prev) => Object.fromEntries(Object.entries(prev).map(([k, list]) => [k, list.filter((x) => x.senderId !== userId)])))
  }

  const block = async (userId: string, on: boolean) => {
    await api(on ? 'PUT' : 'DELETE', `/api/blocks/${userId}`)
    if (on) return hideFrom(userId)
    // shortcut: unblocking restores only the newest page of each loaded chat; older ones come back on scroll-up.
    for (const id of loaded.current) fetchPage(id).catch(() => {})
    archive.current.clear() // their messages are back; search and shared media page again
  }

  // Reporting blocks too (server side).
  const report = async (userId: string, convId: string, note: string) => {
    await api('POST', '/api/reports', { userId, convId, note: note.trim() || undefined })
    hideFrom(userId)
  }

  return {
    me, messages, pending, hasOlder, activeId, totalUnread, typers, focus, setFocus,
    open, loadOlder, backfill, history, openAt, send, retry, discard, sendWithFiles, fileUrl, createConversation, addMembers,
    react, edit, unsend, forward, typing, setMine, rename, removeMember, leave, block, report, linkAgent, checkAgent, allowAgent,
  }
}

export type Talk = ReturnType<typeof useTalk>
