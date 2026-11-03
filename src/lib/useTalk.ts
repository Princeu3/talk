// All app data and actions in one hook; components only render what it returns.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, socket } from './api.ts'
import * as c from './crypto.ts'
import type { Conversation, FileRef, GroupCall, Me, Message, MessageBody, Voice } from '../../shared/types.ts'

export interface Decrypted extends Message {
  content: MessageBody | null // null: could not decrypt
  forged: boolean // inner sender differs from the one the server claims
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
export const MAX_FILE = 50 * 1024 * 1024

const bump = (list: Conversation[], msg: Message, unread: boolean) =>
  list
    .map((x) => (x.id === msg.convId ? { ...x, lastMessageAt: msg.createdAt, unread: x.unread + (unread ? 1 : 0) } : x))
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))

export function useTalk(privateKey: CryptoKey, onSignedOut: () => void) {
  const [me, setMe] = useState<Me | null>(null)
  const [messages, setMessages] = useState<Record<string, Decrypted[]>>({})
  const [hasOlder, setHasOlder] = useState<Record<string, boolean>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  // Unsent, oldest first, all chats. The ref is the truth (drain reads it between awaits); state mirrors it.
  // shortcut: in memory, so a reload drops unsent messages; IndexedDB if that bites.
  const queue = useRef<Pending[]>([])
  const [pending, setPending] = useState<Pending[]>([])

  const meRef = useRef(me)
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const draining = useRef(false)
  const keys = useRef(new Map<string, { key: CryptoKey; raw: Uint8Array<ArrayBuffer> }>())
  const loaded = useRef(new Set<string>())
  const blobs = useRef(new Map<string, Promise<string>>())
  // load() needs decrypt(), which needs keyFor(), which needs load(): break the cycle with a ref.
  const decryptRef = useRef<(m: Message) => Promise<Decrypted>>(null!)

  const load = useCallback(async () => {
    try {
      const m = await api<Me>('GET', '/api/me')
      // The open chat is read even if the server hasn't heard yet (that request may still be in flight).
      const shown = activeRef.current && !document.hidden ? activeRef.current : null
      m.conversations = m.conversations.map((x) => (x.id === shown ? { ...x, unread: 0 } : x))
      meRef.current = m
      setMe(m)
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
        return { ...msg, content, forged: content.from !== msg.senderId }
      } catch {
        return { ...msg, content: null, forged: false }
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
          merge(convId, [{ ...r.message, content, forged: false }])
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
      const d = await decrypt(msg)
      merge(msg.convId, [d])
      const mine = msg.senderId === meRef.current?.user.id
      const seen = (activeRef.current === msg.convId && !document.hidden) || !!d.content?.call?.ms
      setMe((m) => m && { ...m, conversations: bump(m.conversations, msg, !mine && !seen) })
    }
    const onSync = () => void load().catch(() => {})
    const onCall = ({ convId, call }: { convId: string; call: GroupCall | null }) =>
      setMe((m) => m && { ...m, conversations: m.conversations.map((x) => (x.id === convId ? { ...x, call: call ?? undefined } : x)) })
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
    socket.on('sync', onSync)
    socket.on('call:update', onCall)
    socket.on('connect', onConnect)
    socket.on('connect_error', onError)
    document.addEventListener('visibilitychange', onVisibility)
    socket.connect()
    return () => {
      socket.off('message', onMessage)
      socket.off('sync', onSync)
      socket.off('call:update', onCall)
      socket.off('connect', onConnect)
      socket.off('connect_error', onError)
      document.removeEventListener('visibilitychange', onVisibility)
      socket.disconnect()
    }
  }, [load, decrypt, fetchPage, drain, onSignedOut])

  // Mark the open conversation read whenever its newest message changes.
  const lastId = activeId ? messages[activeId]?.at(-1)?.id : undefined
  useEffect(() => {
    if (!activeId || !lastId) return
    const markRead = () => {
      if (document.hidden) return
      api('POST', `/api/conversations/${activeId}/read`, { upTo: lastId }).catch(() => {})
      setMe((m) => m && { ...m, conversations: m.conversations.map((x) => (x.id === activeId ? { ...x, unread: 0 } : x)) })
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

  const loadOlder = (convId: string) => {
    const first = messages[convId]?.[0]
    if (first) return fetchPage(convId, first.id)
  }

  // Sealed and queued; resolves before the server hears, and a failure shows on the pending row.
  const send = async (convId: string, content: Omit<MessageBody, 'from'>, quiet?: boolean, seen?: boolean) => {
    const { key } = await keyFor(convId)
    const full = { ...content, from: meRef.current!.user.id }
    const body = await c.sealMessage(key, convId, full)
    // The server's limit; caught here, so the draft comes back instead of a row that can never send.
    if (body.length > 64 * 1024) throw new Error('That message is too long to send.')
    const p: Pending = { cid: crypto.randomUUID(), convId, body, content: full, createdAt: Date.now(), quiet, seen, sending: socket.connected }
    setQueue([...queue.current, p])
    drain()
  }

  const retry = (p: Pending) => {
    patch(p, { sending: socket.connected, error: undefined })
    drain()
  }
  const discard = (p: Pending) => patch(p, null)

  const sendWithFiles = async (convId: string, text: string, files: File[], voice?: Voice) => {
    const { key } = await keyFor(convId)
    const refs: FileRef[] = []
    for (const f of files) {
      if (f.size > MAX_FILE) throw new Error(`${f.name} is over 50 MB`)
      const sealed = await c.sealFile(key, convId, new Uint8Array(await f.arrayBuffer()))
      const { id } = await api<{ id: string }>('POST', `/api/conversations/${convId}/attachments`, sealed)
      refs.push({ id, name: f.name, type: f.type || 'application/octet-stream', size: f.size, ...(voice && { voice }) })
    }
    await send(convId, { text: text || undefined, files: refs.length ? refs : undefined })
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

  // One user id makes (or reuses) a DM; more make a group.
  const createConversation = async (userIds: string[], title?: string) => {
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
        wrappedKey: await c.wrapConvKey(raw, privateKey, m.users.find((u) => u.id === uid)!.pubkey, id, uid),
      })),
    )
    const kind = userIds.length === 1 ? 'dm' : 'group'
    await api('POST', '/api/conversations', { id, kind, title: kind === 'group' ? title : undefined, members })
    await load()
    return id
  }

  const addMember = async (convId: string, userId: string) => {
    const { raw } = await keyFor(convId)
    const user = meRef.current!.users.find((u) => u.id === userId)!
    const wrappedKey = await c.wrapConvKey(raw, privateKey, user.pubkey, convId, userId)
    await api('POST', `/api/conversations/${convId}/members`, { userId, wrappedKey })
    await load()
  }

  return {
    me, messages, pending, hasOlder, activeId, totalUnread,
    open, loadOlder, send, retry, discard, sendWithFiles, fileUrl, createConversation, addMember,
  }
}

export type Talk = ReturnType<typeof useTalk>
