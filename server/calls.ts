// 1:1 call signaling. The server rings, relays WebRTC offers and ICE
// candidates between the two devices, and forgets the call when it ends;
// audio and video flow peer to peer (or through Cloudflare TURN).
import { randomUUID } from 'node:crypto'
import type { Server, Socket } from 'socket.io'
import { db, blocks, isMember, memberIds } from './db.ts'
import { apns, notifyIfAway } from './push.ts'
import type { CallEnd, CallKind, CallRing } from '../shared/types.ts'

interface Call extends CallRing {
  to: string
  device: Record<string, string | null> // socket each side talks on; callee's is null until answered
  answered: boolean
  timer?: ReturnType<typeof setTimeout>
}

const RING_MS = 45_000
const GRACE_MS = 30_000 // phones drop sockets; media keeps flowing P2P while one comes back
const calls = new Map<string, Call>()

const nameOf = (id: string) => (db.prepare('select name from users where id = ?').get(id) as { name: string }).name
const inCall = (u: string) => [...calls.values()].some((c) => c.from === u || c.to === u)
const label = (k: CallKind) => (k === 'video' ? 'video call' : 'voice call')

type Ack = (r: { id?: string; error?: string }) => void

// For the phone woken by a call push: is this call still ringing for me?
export function callState(id: string, userId: string) {
  const c = calls.get(id)
  if (!c || (c.from !== userId && c.to !== userId)) return null
  return { ...ring(c), state: c.answered ? 'answered' : 'ringing' }
}
const ring = ({ id, convId, from, kind }: Call): CallRing => ({ id, convId, from, kind })

export function callHandlers(io: Server) {
  const end = (c: Call, reason: CallEnd) => {
    clearTimeout(c.timer)
    calls.delete(c.id)
    io.to([`user:${c.from}`, `user:${c.to}`]).emit('call:end', { id: c.id, reason })
    if (reason === 'missed')
      notifyIfAway(io, c.to, { title: nameOf(c.from), body: `Missed ${label(c.kind)}`, convId: c.convId }, {
        apns: { type: 'missed', convId: c.convId, callId: c.id, kind: c.kind },
      })
  }
  const ringFor = (c: Call) => {
    clearTimeout(c.timer)
    c.timer = setTimeout(() => end(c, 'missed'), RING_MS)
  }

  return (socket: Socket) => {
    const me = socket.data.userId as string
    const mine = (id: unknown) => {
      const c = typeof id === 'string' ? calls.get(id) : undefined
      return c && (c.from === me || c.to === me) ? c : undefined
    }
    const peer = (c: Call) => (c.from === me ? c.to : c.from)

    // Opening the app from a call notification: it's still ringing, show it.
    for (const c of calls.values()) if (c.to === me && !c.answered) socket.emit('call:ring', ring(c))

    socket.on('call:start', (p: { convId?: unknown; kind?: unknown }, ack: Ack) => {
      if (typeof ack !== 'function') return
      const { convId, kind } = p ?? {}
      const conv = typeof convId === 'string' && db.prepare('select kind from conversations where id = ?').get(convId) as { kind: string } | undefined
      if (!conv || conv.kind !== 'dm' || !isMember(convId as string, me) || (kind !== 'audio' && kind !== 'video'))
        return ack({ error: 'bad request' })
      const to = memberIds(convId as string).find((u) => u !== me)
      if (!to) return ack({ error: 'This account was deleted.' })
      if (blocks(me, to)) return ack({ error: `Unblock ${nameOf(to)} to call them.` })
      if (blocks(to, me)) return ack({ error: `${nameOf(to)} isn't taking calls from you.` })
      if (inCall(me)) return ack({ error: 'You are already in a call.' })
      if (inCall(to)) return ack({ error: `${nameOf(to)} is on another call.` })
      const c: Call = { id: randomUUID(), convId: convId as string, from: me, kind, to, device: { [me]: socket.id, [to]: null }, answered: false }
      calls.set(c.id, c)
      ringFor(c)
      io.to(`user:${to}`).emit('call:ring', ring(c))
      ack({ id: c.id })
      notifyIfAway(io, to, { title: nameOf(me), body: `Incoming ${label(kind)}`, convId: c.convId }, { ttl: 45 })
      // Always, even with the app open: the app shows every call through CallKit
      // and drops the duplicate by call id.
      apns(to, { type: 'call', convId: c.convId, callId: c.id, kind, from: me })
    })

    socket.on('call:accept', (p: { id?: unknown }, ack: Ack) => {
      if (typeof ack !== 'function') return
      const c = mine(p?.id)
      if (!c || c.to !== me || c.answered) return ack({ error: 'This call has ended.' })
      c.answered = true
      c.device[me] = socket.id
      clearTimeout(c.timer)
      // Ack first: this socket must have its peer connection ready before the caller's offer lands.
      ack({ id: c.id })
      socket.to(`user:${me}`).emit('call:end', { id: c.id, reason: 'elsewhere' })
      const caller = c.device[c.from]
      if (caller) io.to(caller).emit('call:accepted', { id: c.id })
    })

    socket.on('call:hangup', (p: { id?: unknown }) => {
      const c = mine(p?.id)
      if (c) end(c, c.answered ? 'hangup' : c.from === me ? 'cancelled' : 'declined')
    })

    socket.on('call:signal', (p: { id?: unknown; data?: unknown }) => {
      const c = mine(p?.id)
      const to = c && c.device[peer(c)]
      if (to) io.to(to).emit('call:signal', { id: c.id, data: p.data })
    })

    socket.on('call:rejoin', (p: { id?: unknown }, ack: Ack) => {
      if (typeof ack !== 'function') return
      const c = mine(p?.id)
      if (!c || (c.to === me && !c.answered)) return ack({ error: 'This call has ended.' })
      c.device[me] = socket.id
      if (c.answered) clearTimeout(c.timer)
      else ringFor(c)
      ack({ id: c.id })
    })

    socket.on('disconnect', () => {
      for (const c of calls.values()) {
        if (c.device[me] !== socket.id) continue
        c.device[me] = null
        clearTimeout(c.timer)
        c.timer = setTimeout(() => end(c, 'lost'), GRACE_MS)
      }
    })
  }
}
