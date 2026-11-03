// Call signaling. The server rings, relays WebRTC offers and ICE candidates
// between devices, and forgets the call when it ends; audio and video flow
// peer to peer (or through Cloudflare TURN).
//
// DMs use the 1:1 protocol (call:start/accept/accepted/signal/hangup/rejoin),
// which every app version speaks. Groups use a mesh: everyone in the call
// connects to everyone else. A group call rings the members, keeps going while
// two or more are in it, and anyone in the chat can join until it ends:
//   call:start {convId, kind}   -> ack {id}; rings the group; call:update to members
//   call:join {id}              -> ack {id, peers}; the joiner connects to each peer
//                                  (and is the polite side); peers get call:joined {id, user}
//   call:signal {id, to, data}  -> to's device gets call:signal {id, from, data}
//   call:hangup {id}            -> leave (peers get call:left {id, user}), or decline a ring
//   call:rejoin {id}            -> after a socket reconnect; ack {id, peers}
//   call:update {convId, call}  <- the chat's live call (GroupCall), or null once over
// Only sockets and phones on protocol v2 hear group rings; older apps don't know them.
import { randomUUID } from 'node:crypto'
import type { Server, Socket } from 'socket.io'
import { db, blocks, isMember, memberIds, mutedIds } from './db.ts'
import { apns, notifyIfAway } from './push.ts'
import type { CallEnd, CallKind, CallRing, GroupCall } from '../shared/types.ts'

interface Call extends CallRing {
  to: string
  device: Record<string, string | null> // socket each side talks on; callee's is null until answered
  answered: boolean
  timer?: ReturnType<typeof setTimeout>
}

interface Group extends CallRing {
  peers: Map<string, string | null> // who's in: user -> socket, null while it reconnects
  ringing: Set<string> // rung and hasn't joined or declined
  answered: boolean // someone besides the starter joined
  timer?: ReturnType<typeof setTimeout>
  lost: Map<string, ReturnType<typeof setTimeout>>
}

const RING_MS = 45_000
const GRACE_MS = 30_000 // phones drop sockets; media keeps flowing P2P while one comes back
const MAX_PEERS = 8 // a mesh sends every stream to every peer; past this, phones struggle
const calls = new Map<string, Call>()
const groups = new Map<string, Group>()

const nameOf = (id: string) => (db.prepare('select name from users where id = ?').get(id) as { name: string }).name
const inCall = (u: string) => [...calls.values()].some((c) => c.from === u || c.to === u) || [...groups.values()].some((g) => g.peers.has(u))
const label = (k: CallKind) => (k === 'video' ? 'video call' : 'voice call')
const view = (g: Group): GroupCall => ({ id: g.id, kind: g.kind, from: g.from, peers: [...g.peers.keys()] })

// The live group call in a chat, for /api/me.
export const groupCall = (convId: string) => {
  const g = [...groups.values()].find((x) => x.convId === convId)
  return g && view(g)
}

type Ack = (r: { id?: string; error?: string }) => void

// For the phone woken by a call push: is this call still ringing for me?
export function callState(id: string, userId: string) {
  const g = groups.get(id)
  if (g) return isMember(g.convId, userId) ? { ...ring(g), state: g.ringing.has(userId) ? 'ringing' : 'answered' } : null
  const c = calls.get(id)
  if (!c || (c.from !== userId && c.to !== userId)) return null
  return { ...ring(c), state: c.answered ? 'answered' : 'ringing' }
}
const ring = ({ id, convId, from, kind }: CallRing): CallRing => ({ id, convId, from, kind })

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

  // --- group calls ---
  const update = (g: Group, live = true) =>
    io.to(memberIds(g.convId).map((u) => `user:${u}`)).emit('call:update', { convId: g.convId, call: live ? view(g) : null })
  const missed = (g: Group) => {
    const title = (db.prepare('select title from conversations where id = ?').get(g.convId) as { title: string }).title
    for (const u of g.ringing) {
      io.to(`user:${u}`).emit('call:end', { id: g.id, reason: 'missed' })
      notifyIfAway(io, u, { title, body: `Missed group ${label(g.kind)}`, convId: g.convId }, {
        apns: { type: 'missed', convId: g.convId, callId: g.id, kind: g.kind },
      })
    }
    g.ringing.clear()
  }
  const endGroup = (g: Group, reason: CallEnd) => {
    clearTimeout(g.timer)
    g.lost.forEach(clearTimeout)
    groups.delete(g.id)
    if (reason !== 'cancelled') missed(g)
    io.to(memberIds(g.convId).map((u) => `user:${u}`)).emit('call:end', { id: g.id, reason })
    update(g, false)
  }
  const leave = (g: Group, u: string, reason: CallEnd) => {
    g.peers.delete(u)
    clearTimeout(g.lost.get(u))
    g.lost.delete(u)
    io.to(`user:${u}`).emit('call:end', { id: g.id, reason })
    for (const s of g.peers.values()) if (s) io.to(s).emit('call:left', { id: g.id, user: u })
    if (!g.answered && u === g.from) endGroup(g, 'cancelled')
    else if (!g.peers.size || (g.answered && g.peers.size < 2)) endGroup(g, 'hangup')
    else update(g)
  }
  const startGroup = (socket: Socket, me: string, convId: string, kind: CallKind, ack: Ack) => {
    if (inCall(me)) return ack({ error: 'You are already in a call.' })
    if (groupCall(convId)) return ack({ error: 'A call is already on in this chat. Join it instead.' })
    const g: Group = { id: randomUUID(), convId, from: me, kind, peers: new Map([[me, socket.id]]), ringing: new Set(), answered: false, lost: new Map() }
    const muted = mutedIds(convId)
    for (const u of memberIds(convId)) if (u !== me && !blocks(u, me) && !muted.has(u) && !inCall(u)) g.ringing.add(u)
    groups.set(g.id, g)
    g.timer = setTimeout(() => (g.answered ? missed(g) : endGroup(g, 'missed')), RING_MS)
    const title = (db.prepare('select title from conversations where id = ?').get(convId) as { title: string }).title
    for (const u of g.ringing) {
      io.to(`v2:${u}`).emit('call:ring', ring(g))
      notifyIfAway(io, u, { title, body: `${nameOf(me)} · Group ${label(kind)}`, convId }, { ttl: 45 })
      apns(u, { type: 'call', convId, callId: g.id, kind, from: me }, 2)
    }
    ack({ id: g.id })
    update(g)
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
    if (socket.data.v >= 2) for (const g of groups.values()) if (g.ringing.has(me)) socket.emit('call:ring', ring(g))
    const others = (g: Group) => [...g.peers.keys()].filter((u) => u !== me)

    socket.on('call:start', (p: { convId?: unknown; kind?: unknown }, ack: Ack) => {
      if (typeof ack !== 'function') return
      const { convId, kind } = p ?? {}
      const conv = typeof convId === 'string' && db.prepare('select kind from conversations where id = ?').get(convId) as { kind: string } | undefined
      if (!conv || !isMember(convId as string, me) || (kind !== 'audio' && kind !== 'video')) return ack({ error: 'bad request' })
      if (conv.kind === 'group') return startGroup(socket, me, convId as string, kind, ack)
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

    socket.on('call:join', (p: { id?: unknown }, ack: (r: { id?: string; peers?: string[]; error?: string }) => void) => {
      if (typeof ack !== 'function') return
      const g = typeof p?.id === 'string' ? groups.get(p.id) : undefined
      if (!g || !isMember(g.convId, me)) return ack({ error: 'This call has ended.' })
      if (!g.peers.has(me)) {
        if (inCall(me)) return ack({ error: 'You are already in a call.' })
        if (g.peers.size >= MAX_PEERS) return ack({ error: 'This call is full.' })
      }
      g.ringing.delete(me)
      clearTimeout(g.lost.get(me))
      g.lost.delete(me)
      g.peers.set(me, socket.id)
      if (me !== g.from) g.answered = true
      ack({ id: g.id, peers: others(g) })
      socket.to(`user:${me}`).emit('call:end', { id: g.id, reason: 'elsewhere' })
      // Also when I join again from another device: peers replace their connection to me.
      for (const u of others(g)) {
        const s = g.peers.get(u)
        if (s) io.to(s).emit('call:joined', { id: g.id, user: me })
      }
      update(g)
    })

    socket.on('call:hangup', (p: { id?: unknown }) => {
      const g = typeof p?.id === 'string' ? groups.get(p.id) : undefined
      if (g) {
        if (g.peers.has(me)) leave(g, me, 'hangup')
        else if (g.ringing.delete(me)) {
          io.to(`user:${me}`).emit('call:end', { id: g.id, reason: 'declined' })
          if (!g.answered && !g.ringing.size) endGroup(g, 'declined')
        }
        return
      }
      const c = mine(p?.id)
      if (c) end(c, c.answered ? 'hangup' : c.from === me ? 'cancelled' : 'declined')
    })

    socket.on('call:signal', (p: { id?: unknown; to?: unknown; data?: unknown }) => {
      const g = typeof p?.id === 'string' ? groups.get(p.id) : undefined
      if (g) {
        const to = g.peers.get(me) === socket.id && typeof p.to === 'string' ? g.peers.get(p.to) : undefined
        if (to) io.to(to).emit('call:signal', { id: g.id, from: me, data: p.data })
        return
      }
      const c = mine(p?.id)
      const to = c && c.device[peer(c)]
      if (to) io.to(to).emit('call:signal', { id: c.id, data: p.data })
    })

    socket.on('call:rejoin', (p: { id?: unknown }, ack: (r: { id?: string; peers?: string[]; error?: string }) => void) => {
      if (typeof ack !== 'function') return
      const g = typeof p?.id === 'string' ? groups.get(p.id) : undefined
      if (g) {
        if (!g.peers.has(me)) return ack({ error: 'This call has ended.' })
        g.peers.set(me, socket.id)
        clearTimeout(g.lost.get(me))
        g.lost.delete(me)
        return ack({ id: g.id, peers: others(g) })
      }
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
      for (const g of groups.values()) {
        if (g.peers.get(me) !== socket.id) continue
        g.peers.set(me, null)
        g.lost.set(me, setTimeout(() => leave(g, me, 'lost'), GRACE_MS))
      }
    })
  }
}
