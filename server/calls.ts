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
//   call:add {id, users}        -> from someone in the call: ring these members (again); ack {error?}
//   call:update {convId, call}  <- the chat's live call (GroupCall), or null once over
// Only sockets and phones on protocol v2 hear group rings; older apps don't know them.
import { randomUUID } from 'node:crypto'
import type { Server, Socket } from 'socket.io'
import { db, audience, blocks, isMember, kindOf, memberIds, mutedIds, userExists } from './db.ts'
import { apns, notifyIfAway, toUsers } from './push.ts'
import { noteDecline, ringRefusal } from './agents.ts'
import type { CallEnd, CallKind, CallRing, GroupCall } from '../shared/types.ts'

interface Call extends CallRing {
  to: string
  device: Record<string, string | null> // socket each side talks on; callee's is null until answered
  answered: boolean
  until: number // when an unanswered ring stops, however often the caller rejoins
  timer?: ReturnType<typeof setTimeout>
}

interface Group extends CallRing {
  peers: Map<string, string | null> // who's in: user -> socket, null while it reconnects
  ringing: Map<string, ReturnType<typeof setTimeout>> // rung and hasn't joined or declined: user -> ring timeout
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
const titleOf = (convId: string) => (db.prepare('select title from conversations where id = ?').get(convId) as { title: string }).title
const group = (id: unknown) => (typeof id === 'string' ? groups.get(id) : undefined)
// They're connected again (or gone): stop the timer that drops them.
const back = (g: Group, u: string) => {
  clearTimeout(g.lost.get(u))
  g.lost.delete(u)
}
// Either blocked the other: they never share a call.
const apart = (a: string, b: string) => blocks(a, b) || blocks(b, a)
const inCall = (u: string) => [...calls.values()].some((c) => c.from === u || c.to === u) || [...groups.values()].some((g) => g.peers.has(u))
const label = (k: CallKind) => (k === 'video' ? 'video call' : 'voice call')
const view = (g: Group): GroupCall => ({ id: g.id, kind: g.kind, from: g.from, peers: [...g.peers.keys()], ringing: [...g.ringing.keys()] })

// The live group call in a chat, for /api/me.
export const groupCall = (convId: string) => {
  const g = [...groups.values()].find((x) => x.convId === convId)
  return g && view(g)
}

type Ack = (r: { id?: string; peers?: string[]; error?: string }) => void

// For the phone woken by a call push: is this call still ringing for me?
export function callState(id: string, userId: string) {
  const g = groups.get(id)
  if (g) return isMember(g.convId, userId) ? { ...groupRing(g), state: g.ringing.has(userId) ? 'ringing' : 'answered' } : null
  const c = calls.get(id)
  if (!c || (c.from !== userId && c.to !== userId)) return null
  return { ...ring(c), state: c.answered ? 'answered' : 'ringing' }
}
const ring = ({ id, convId, from, kind }: CallRing): CallRing => ({ id, convId, from, kind })
const groupRing = (g: Group): CallRing => ({ ...ring(g), group: true })

export function callHandlers(io: Server) {
  const end = (c: Call, reason: CallEnd) => {
    clearTimeout(c.timer)
    calls.delete(c.id)
    io.to([`user:${c.from}`, `user:${c.to}`]).emit('call:end', { id: c.id, reason })
    // Helpers' ring rules read this. shortcut: an unanswered ring counts as a decline, because build 10
    // reports a lock-screen decline as 'missed'; count only 'declined' once build 10 is gone.
    if (reason === 'declined' || reason === 'missed') noteDecline(c.from)
    if (reason === 'missed')
      notifyIfAway(io, c.to, { title: nameOf(c.from), body: `Missed ${label(c.kind)}`, convId: c.convId }, {
        apns: { type: 'missed', convId: c.convId, callId: c.id, kind: c.kind },
      })
  }
  const ringFor = (c: Call) => {
    clearTimeout(c.timer)
    c.timer = setTimeout(() => end(c, 'missed'), c.until - Date.now())
  }
  // A removed or paused helper: end its 1:1 calls now, not 30 s after its socket drops.
  const hangUp = (u: string) => {
    for (const c of calls.values()) if (c.from === u || c.to === u) end(c, 'cancelled')
  }

  // --- group calls ---
  const update = (g: Group, live = true) =>
    toUsers(io, memberIds(g.convId)).emit('call:update', { convId: g.convId, call: live ? view(g) : null })
  const ringOne = (g: Group, u: string, by: string) => {
    g.ringing.set(u, setTimeout(() => (miss(g, u), update(g)), RING_MS))
    io.to(`v2:${u}`).emit('call:ring', groupRing(g))
    notifyIfAway(io, u, { title: titleOf(g.convId), body: `${nameOf(by)} · Group ${label(g.kind)}`, convId: g.convId }, { ttl: 45 })
    apns(u, { type: 'call', convId: g.convId, callId: g.id, kind: g.kind, from: by }, 2)
  }
  // Stop ringing u: they joined, declined or left the chat.
  const unring = (g: Group, u: string) => {
    clearTimeout(g.ringing.get(u))
    return g.ringing.delete(u)
  }
  const miss = (g: Group, u: string) => {
    if (!unring(g, u)) return
    io.to(`user:${u}`).emit('call:end', { id: g.id, reason: 'missed' })
    notifyIfAway(io, u, { title: titleOf(g.convId), body: `Missed group ${label(g.kind)}`, convId: g.convId }, {
      apns: { type: 'missed', convId: g.convId, callId: g.id, kind: g.kind },
    })
  }
  const endGroup = (g: Group, reason: CallEnd) => {
    clearTimeout(g.timer)
    g.lost.forEach(clearTimeout)
    groups.delete(g.id)
    for (const u of [...g.ringing.keys()]) {
      if (reason === 'cancelled') unring(g, u)
      else miss(g, u)
    }
    toUsers(io, memberIds(g.convId)).emit('call:end', { id: g.id, reason })
    update(g, false)
  }
  const leave = (g: Group, u: string, reason: CallEnd) => {
    g.peers.delete(u)
    back(g, u)
    io.to(`user:${u}`).emit('call:end', { id: g.id, reason })
    for (const s of g.peers.values()) if (s) io.to(s).emit('call:left', { id: g.id, user: u })
    if (!g.answered && u === g.from) endGroup(g, 'cancelled')
    else if (!g.peers.size || (g.answered && g.peers.size < 2)) endGroup(g, 'hangup')
    else update(g)
  }
  const startGroup = (socket: Socket, me: string, convId: string, kind: CallKind, ack: Ack) => {
    if (inCall(me)) return ack({ error: 'You are already in a call.' })
    if (groupCall(convId)) return ack({ error: 'A call is already on in this chat. Join it instead.' })
    const g: Group = { id: randomUUID(), convId, from: me, kind, peers: new Map([[me, socket.id]]), ringing: new Map(), answered: false, lost: new Map() }
    const muted = mutedIds(convId)
    groups.set(g.id, g)
    // Set before the rings' own timers, so it fires first: unanswered, the call ends in one go.
    g.timer = setTimeout(() => g.answered || endGroup(g, 'missed'), RING_MS)
    for (const u of audience(convId, me)) if (u !== me && !muted.has(u) && !inCall(u) && !blocks(me, u)) ringOne(g, u, me)
    ack({ id: g.id })
    update(g)
  }

  // Left or removed from the chat: out of its call too (or no longer rung).
  const drop = (convId: string, u: string) => {
    const g = [...groups.values()].find((x) => x.convId === convId)
    if (g?.peers.has(u)) leave(g, u, 'hangup')
    else if (g && unring(g, u)) {
      io.to(`user:${u}`).emit('call:end', { id: g.id, reason: 'cancelled' })
      update(g)
    }
  }

  const handlers = (socket: Socket) => {
    const me = socket.data.userId as string
    const mine = (id: unknown) => {
      const c = typeof id === 'string' ? calls.get(id) : undefined
      return c && (c.from === me || c.to === me) ? c : undefined
    }
    const peer = (c: Call) => (c.from === me ? c.to : c.from)

    // Opening the app from a call notification: it's still ringing, show it.
    for (const c of calls.values()) if (c.to === me && !c.answered) socket.emit('call:ring', ring(c))
    if (socket.data.v >= 2) for (const g of groups.values()) if (g.ringing.has(me)) socket.emit('call:ring', groupRing(g))
    const others = (g: Group) => [...g.peers.keys()].filter((u) => u !== me)

    socket.on('call:start', (p: { convId?: unknown; kind?: unknown; ask?: unknown }, ack: Ack) => {
      if (typeof ack !== 'function') return
      const { convId, kind } = p ?? {}
      const convKind = typeof convId === 'string' && kindOf(convId)
      if (!convKind || !isMember(convId as string, me) || (kind !== 'audio' && kind !== 'video')) return ack({ error: 'bad request' })
      if (convKind === 'group') return startGroup(socket, me, convId as string, kind, ack)
      const to = memberIds(convId as string).find((u) => u !== me)
      if (!to || !userExists(to)) return ack({ error: 'This account was deleted.' })
      if (blocks(me, to)) return ack({ error: `Unblock ${nameOf(to)} to call them.` })
      if (blocks(to, me)) return ack({ error: `${nameOf(to)} isn't taking calls from you.` })
      if (inCall(me)) return ack({ error: 'You are already in a call.' })
      if (inCall(to)) return ack({ error: `${nameOf(to)} is on another call.` })
      const refused = ringRefusal(me, convId as string, p.ask)
      if (refused) return ack({ error: refused })
      const c: Call = { id: randomUUID(), convId: convId as string, from: me, kind, to, device: { [me]: socket.id, [to]: null }, answered: false, until: Date.now() + RING_MS }
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

    socket.on('call:join', (p: { id?: unknown }, ack: Ack) => {
      if (typeof ack !== 'function') return
      const g = group(p?.id)
      if (!g || !isMember(g.convId, me)) return ack({ error: 'This call has ended.' })
      if (!g.peers.has(me)) {
        if (inCall(me)) return ack({ error: 'You are already in a call.' })
        if (g.peers.size >= MAX_PEERS) return ack({ error: 'This call is full.' })
        const blocked = [...g.peers.keys()].find((u) => blocks(me, u))
        if (blocked) return ack({ error: `Unblock ${nameOf(blocked)} to join this call.` })
        if ([...g.peers.keys()].some((u) => blocks(u, me))) return ack({ error: "You can't join this call." })
      }
      unring(g, me)
      back(g, me)
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
      const g = group(p?.id)
      if (g) {
        if (g.peers.has(me)) leave(g, me, 'hangup')
        else if (unring(g, me)) {
          io.to(`user:${me}`).emit('call:end', { id: g.id, reason: 'declined' })
          if (!g.answered && !g.ringing.size) endGroup(g, 'declined')
          else update(g)
        }
        return
      }
      const c = mine(p?.id)
      if (c) end(c, c.answered ? 'hangup' : c.from === me ? 'cancelled' : 'declined')
    })

    socket.on('call:add', (p: { id?: unknown; users?: unknown }, ack: Ack) => {
      if (typeof ack !== 'function') return
      const g = group(p?.id)
      if (!g || g.peers.get(me) !== socket.id) return ack({ error: 'This call has ended.' })
      if (!Array.isArray(p.users)) return ack({ error: 'bad request' })
      if (g.peers.size >= MAX_PEERS) return ack({ error: 'This call is full.' })
      const peers = [...g.peers.keys()]
      const users = (p.users.slice(0, 32) as unknown[]).filter(
        (u): u is string => typeof u === 'string' && !g.peers.has(u) && isMember(g.convId, u) && !inCall(u) && !peers.some((x) => apart(x, u)),
      )
      if (!users.length) return ack({ error: "They can't be rung right now." })
      for (const u of users) {
        unring(g, u)
        ringOne(g, u, me)
      }
      ack({})
      update(g)
    })

    socket.on('call:signal', (p: { id?: unknown; to?: unknown; data?: unknown }) => {
      const g = group(p?.id)
      if (g) {
        const to = g.peers.get(me) === socket.id && typeof p.to === 'string' ? g.peers.get(p.to) : undefined
        if (to) io.to(to).emit('call:signal', { id: g.id, from: me, data: p.data })
        return
      }
      const c = mine(p?.id)
      const to = c && c.device[peer(c)]
      if (to) io.to(to).emit('call:signal', { id: c.id, data: p.data })
    })

    socket.on('call:rejoin', (p: { id?: unknown }, ack: Ack) => {
      if (typeof ack !== 'function') return
      const g = group(p?.id)
      if (g) {
        if (!g.peers.has(me)) return ack({ error: 'This call has ended.' })
        g.peers.set(me, socket.id)
        back(g, me)
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
        // An unanswered ring still stops at `until` when that comes before the grace runs out.
        if (!c.answered && c.until < Date.now() + GRACE_MS) ringFor(c)
        else c.timer = setTimeout(() => end(c, 'lost'), GRACE_MS)
      }
      for (const g of groups.values()) {
        if (g.peers.get(me) !== socket.id) continue
        g.peers.set(me, null)
        g.lost.set(me, setTimeout(() => leave(g, me, 'lost'), GRACE_MS))
      }
    })
  }
  return Object.assign(handlers, { drop, hangUp })
}
