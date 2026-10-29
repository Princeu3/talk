// All app data and actions in one hook; components only render what it returns.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, socket } from './api.ts'
import * as c from './crypto.ts'
import type { Conversation, FileRef, Me, Message, MessageBody, Voice } from '../../shared/types.ts'

export interface Decrypted extends Message {
  content: MessageBody | null // null: could not decrypt
  forged: boolean // inner sender differs from the one the server claims
}

export interface Incoming {
  convId: string
  room: string
  from: string
}

const PAGE = 50
export const MAX_FILE = 50 * 1024 * 1024

const randomRoom = () => {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789'
  const r = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(r, (b) => a[b % a.length]).join('').replace(/(.{4})(?!$)/g, '$1-')
}

const bump = (list: Conversation[], msg: Message, unread: boolean) =>
  list
    .map((x) => (x.id === msg.convId ? { ...x, lastMessageAt: msg.createdAt, unread: x.unread + (unread ? 1 : 0) } : x))
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))

export function useTalk(privateKey: CryptoKey, onSignedOut: () => void) {
  const [me, setMe] = useState<Me | null>(null)
  const [messages, setMessages] = useState<Record<string, Decrypted[]>>({})
  const [hasOlder, setHasOlder] = useState<Record<string, boolean>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [incoming, setIncoming] = useState<Incoming | null>(null)

  const meRef = useRef(me)
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const keys = useRef(new Map<string, { key: CryptoKey; raw: Uint8Array<ArrayBuffer> }>())
  const loaded = useRef(new Set<string>())
  const blobs = useRef(new Map<string, Promise<string>>())
  // load() needs decrypt(), which needs keyFor(), which needs load(): break the cycle with a ref.
  const decryptRef = useRef<(m: Message) => Promise<Decrypted>>(null!)

  const load = useCallback(async () => {
    try {
      const m = await api<Me>('GET', '/api/me')
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
      const seen = activeRef.current === msg.convId && !document.hidden
      setMe((m) => m && { ...m, conversations: bump(m.conversations, msg, !mine && !seen) })
      if (!mine && d.content?.call && Date.now() - msg.createdAt < 60_000)
        setIncoming({ convId: msg.convId, room: d.content.call.room, from: msg.senderId })
    }
    const onSync = () => void load().catch(() => {})
    // Reconnects (phones drop sockets constantly) refetch what we may have missed.
    const onConnect = () => {
      socket.emit('active', !document.hidden)
      onSync()
      for (const id of loaded.current) fetchPage(id).catch(() => {})
    }
    const onError = (e: Error) => e.message === 'signed out' && onSignedOut()
    const onVisibility = () => socket.emit('active', !document.hidden)

    socket.on('message', onMessage)
    socket.on('sync', onSync)
    socket.on('connect', onConnect)
    socket.on('connect_error', onError)
    document.addEventListener('visibilitychange', onVisibility)
    socket.connect()
    return () => {
      socket.off('message', onMessage)
      socket.off('sync', onSync)
      socket.off('connect', onConnect)
      socket.off('connect_error', onError)
      document.removeEventListener('visibilitychange', onVisibility)
      socket.disconnect()
    }
  }, [load, decrypt, fetchPage, onSignedOut])

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

  const send = async (convId: string, content: Omit<MessageBody, 'from'>, notify?: 'call') => {
    const { key } = await keyFor(convId)
    const body = await c.sealMessage(key, convId, { ...content, from: meRef.current!.user.id })
    const r = await socket.timeout(15_000).emitWithAck('send', { convId, body, notify })
    if (r.error) throw new Error(r.error)
  }

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

  const startCall = async (convId: string) => {
    const room = randomRoom()
    await send(convId, { call: { room } }, 'call')
    return room
  }

  return {
    me, messages, hasOlder, activeId, incoming, totalUnread,
    open, loadOlder, send, sendWithFiles, fileUrl, createConversation, addMember, startCall,
    dismissIncoming: () => setIncoming(null),
  }
}

export type Talk = ReturnType<typeof useTalk>
