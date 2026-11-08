// One live call: ringing, a WebRTC connection to each other person and
// everyone's media. A DM call has one peer; a group call is a mesh, with a
// connection to everyone in it. Signaling rides our socket (server/calls.ts);
// audio and video go peer to peer, or through Cloudflare TURN when a direct
// path can't be found.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, socket } from './api.ts'
import type { CallEnd, CallKind, CallRing, GroupCall } from '../../shared/types.ts'

export type Phase = 'incoming' | 'calling' | 'ringing' | 'connecting' | 'live' | 'reconnecting' | 'ended'
type Facing = 'user' | 'environment'

// Someone else in the call, as the screen shows them.
export interface Remote {
  user: string
  stream?: MediaStream
  muted: boolean
  camera: boolean
}

export interface CallView {
  convId: string
  group: boolean
  peer: string // DM: the other person; group: who started it ('' when we did)
  kind: CallKind
  phase: Phase
  since?: number // when media first connected
  note?: string // why it ended
  local?: MediaStream
  peers: Remote[] // a DM's other person from the start; in a group, whoever we connect to
  muted: boolean
  camera: boolean
  facing: Facing
}

interface Signal {
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
  state?: { muted: boolean; camera: boolean }
}

// Our connection to one other person.
interface Peer extends Remote {
  polite: boolean // yields on an offer collision: the DM callee, the group joiner
  pc?: RTCPeerConnection
  video?: RTCRtpSender
  queue: Signal[] // signals that arrive before our peer connection exists
  makingOffer: boolean
  ignoreOffer: boolean
  lost?: ReturnType<typeof setTimeout>
}

interface Session {
  id: string | null
  convId: string
  kind: CallKind
  group: boolean
  outgoing: boolean // we started it, so we post the log
  ice: Promise<RTCIceServer[]>
  local: MediaStream
  peers: Map<string, Peer> // by user id
  accepting: boolean
  joined: boolean // the server acked our start, accept or join
  since?: number
  muted: boolean
  camera: boolean
  facing: Facing
  timers: ReturnType<typeof setTimeout>[]
  stopTone?: () => void
  wake?: Promise<WakeLockSentinel | undefined>
  done: boolean
}

const LOST_MS = 30_000
const STUN: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]
const fetchIce = () => api<RTCIceServer[]>('GET', '/api/ice').catch(() => STUN)
// A socket request that answers within 10 s, or reads as a lost connection.
const ask = <T = object>(event: string, data: unknown): Promise<T & { error?: string }> =>
  socket.timeout(10_000).emitWithAck(event, data).catch(() => ({ error: "Couldn't reach the server. Check your connection." }))

const VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 } }
const getMedia = (video: boolean) =>
  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: video && { facingMode: 'user', ...VIDEO },
  })
const getCamera = (facing: Facing) =>
  navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, ...VIDEO } }).then((s) => s.getVideoTracks()[0])

const mediaError = (e: unknown, kind: CallKind) =>
  (e as Error).name === 'NotAllowedError'
    ? `Allow ${kind === 'video' ? 'camera and microphone' : 'microphone'} access for Talk in your settings.`
    : (e as Error).name === 'NotFoundError'
      ? `No ${kind === 'video' ? 'camera or microphone' : 'microphone'} found.`
      : `Couldn't start the ${kind === 'video' ? 'camera' : 'microphone'}.`

const endNote = (reason: CallEnd, outgoing: boolean): string | undefined =>
  ({
    hangup: 'Call ended',
    lost: 'Connection lost',
    declined: outgoing ? 'Declined' : undefined,
    missed: outgoing ? 'No answer' : undefined,
    cancelled: undefined,
    elsewhere: undefined,
  })[reason]

// Ring and ringback from Web Audio, so there are no sound files to ship.
// iOS may keep it silent before the first tap; the screen still shows the call.
function tone(kind: 'ring' | 'back') {
  let ctx: AudioContext
  try {
    ctx = new AudioContext()
  } catch {
    return () => {}
  }
  const beep = (f: number, at: number, len: number, gain: number) => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    const t = ctx.currentTime + at
    o.frequency.value = f
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + 0.03)
    g.gain.setValueAtTime(gain, t + len - 0.06)
    g.gain.exponentialRampToValueAtTime(0.0001, t + len)
    o.connect(g).connect(ctx.destination)
    o.start(t)
    o.stop(t + len)
  }
  const play =
    kind === 'ring'
      ? () => (beep(660, 0, 0.35, 0.18), beep(880, 0.4, 0.35, 0.18))
      : () => (beep(440, 0, 1.6, 0.04), beep(480, 0, 1.6, 0.04)) // the familiar US ringback
  play()
  const t = setInterval(play, kind === 'ring' ? 2500 : 4000)
  return () => {
    clearInterval(t)
    void ctx.close()
  }
}

// A mesh sends each person their own copy of our video, so each copy shrinks as a group call grows
// (docs/chat-features.md, "Group call video"). Rows: up to this many others, maxBitrate, scaleResolutionDownBy, maxFramerate.
const CAPS = [[1, 1_500_000, 1, 30], [2, 900_000, 1, 30], [3, 600_000, 1.5, 30], [5, 400_000, 2, 24], [7, 250_000, 2.5, 15]] as const
// Applied to every video sender without renegotiating. A 1:1 call gets the first row too: uncapped, a 720p
// sender climbs to ~2.5 Mbps and overshoots a cellular upload, which costs audio as well as video.
function cap(s: Session) {
  const [, maxBitrate, scaleResolutionDownBy, maxFramerate] = CAPS.find(([n]) => s.peers.size <= n) ?? CAPS[CAPS.length - 1]
  for (const p of s.peers.values()) {
    if (!p.video) continue
    const params = p.video.getParameters()
    if (!params.encodings?.length) continue // not negotiated yet; capped again once connected
    Object.assign(params.encodings[0], { maxBitrate, scaleResolutionDownBy, maxFramerate })
    p.video.setParameters(params).catch(() => {})
  }
}

// What a call's stats summary keeps, by stats type (w3.org/TR/webrtc-stats). Same table as callStats in ios/App/PeerConfig.swift.
const PICK: Record<string, string[]> = {
  'outbound-rtp': ['frameWidth', 'frameHeight', 'framesPerSecond', 'qualityLimitationReason', 'qualityLimitationDurations', 'encoderImplementation', 'packetsSent', 'retransmittedPacketsSent', 'nackCount', 'pliCount', 'targetBitrate'],
  'inbound-rtp': ['frameWidth', 'frameHeight', 'framesPerSecond', 'packetsReceived', 'packetsLost', 'jitter', 'freezeCount', 'totalFreezesDuration', 'framesDropped', 'concealedSamples', 'totalSamplesReceived', 'jitterBufferDelay', 'jitterBufferEmittedCount'],
  'remote-inbound-rtp': ['packetsLost', 'fractionLost', 'roundTripTime'],
}
// One connection's end-of-call numbers, keyed like "inbound-rtp video", plus the network path. No addresses.
function summarize(r: RTCStatsReport) {
  const all = [...r.values()] as Record<string, any>[]
  const get = (id?: string) => (id ? r.get(id) : undefined)
  const out: Record<string, unknown> = {}
  for (const o of all) {
    const fields = PICK[o.type]
    if (fields) out[`${o.type} ${o.kind}`] = { codec: get(o.codecId)?.mimeType, ...Object.fromEntries(fields.filter((f) => o[f] !== undefined).map((f) => [f, o[f]])) }
  }
  const pair = get(all.find((o) => o.type === 'transport')?.selectedCandidatePairId) ?? all.find((o) => o.type === 'candidate-pair' && o.nominated && o.state === 'succeeded')
  if (pair) {
    const l = get(pair.localCandidateId)
    out.path = {
      local: l && [l.candidateType, l.protocol, l.relayProtocol, l.networkType].filter(Boolean).join('/'),
      remote: get(pair.remoteCandidateId)?.candidateType,
      rtt: pair.currentRoundTripTime,
      rttAvg: pair.responsesReceived ? pair.totalRoundTripTime / pair.responsesReceived : undefined,
      outBitrate: pair.availableOutgoingBitrate,
    }
  }
  return out
}
// Posts every connection's summary in one log line, so a bad call can be read later.
async function report(s: Session) {
  const pcs = [...s.peers.values()].flatMap((p) => (p.pc ? [p.pc] : []))
  if (!s.id || !pcs.length) return
  const peers = await Promise.all(pcs.map((pc) => pc.getStats().then(summarize)))
  const secs = s.since ? Math.round((Date.now() - s.since) / 1000) : 0
  await api('POST', '/api/call-stats', { id: s.id, kind: s.kind, group: s.group, platform: 'web', secs, peers })
}

const newPeer = (user: string, polite: boolean, kind: CallKind): Peer =>
  ({ user, polite, muted: false, camera: kind === 'video', queue: [], makingOffer: false, ignoreOffer: false })
const tiles = (s: Session): Remote[] => [...s.peers.values()].map(({ user, stream, muted, camera }) => ({ user, stream, muted, camera }))
const only = (s: Session) => [...s.peers.values()][0] // a DM's one peer

export function useCall(onLog: (convId: string, kind: CallKind, ms: number, group: boolean) => void) {
  const [call, setCall] = useState<CallView | null>(null)
  const ref = useRef<Session | null>(null)
  const logRef = useRef(onLog)
  logRef.current = onLog
  const patch = (p: Partial<CallView>) => setCall((v) => v && { ...v, ...p })
  const show = (s: Session) => ref.current === s && patch({ peers: tiles(s) })

  // `peer` is a DM's other person (the caller is the impolite side); a group's peers come and go.
  const session = (convId: string, kind: CallKind, outgoing: boolean, id: string | null, peer?: string): Session => ({
    id, convId, kind, group: !peer, outgoing, ice: fetchIce(), local: new MediaStream(), accepting: false, joined: false,
    peers: new Map(peer ? [[peer, newPeer(peer, !outgoing, kind)]] : []), muted: false, camera: kind === 'video', facing: 'user', timers: [], done: false,
  })
  const view = (s: Session, peer: string, phase: Phase): CallView => ({
    convId: s.convId, group: s.group, peer, kind: s.kind, phase, peers: tiles(s), muted: false, camera: s.camera, facing: 'user',
  })

  // DM signals go to the other side's device; group signals name who they're for.
  const signal = (s: Session, p: Peer, data: Signal) => s.id && socket.emit('call:signal', { id: s.id, data, ...(s.group && { to: p.user }) })
  const state = (s: Session): Signal => ({ state: { muted: s.muted, camera: s.camera } })
  const sendState = (s: Session) => s.peers.forEach((p) => signal(s, p, state(s)))

  const finish = useCallback((note?: string) => {
    const s = ref.current
    if (!s) return
    s.done = true
    ref.current = null
    s.stopTone?.()
    s.timers.forEach(clearInterval)
    s.peers.forEach((p) => clearTimeout(p.lost))
    s.local.getTracks().forEach((t) => t.stop())
    // A closed connection has no stats, so read them first; it closes either way.
    void report(s).catch(() => {}).finally(() => s.peers.forEach((p) => p.pc?.close()))
    void s.wake?.then((w) => w?.release().catch(() => {}))
    if (s.outgoing && s.id) logRef.current(s.convId, s.kind, s.since ? Date.now() - s.since : 0, s.group)
    if (!note) return setCall(null)
    setCall((v) => v && { ...v, phase: 'ended', note })
    setTimeout(() => setCall((v) => (v?.phase === 'ended' ? null : v)), 1600)
  }, [])

  const hangup = useCallback(() => {
    const s = ref.current
    if (!s) return setCall(null)
    if (s.id) socket.emit('call:hangup', { id: s.id })
    finish(s.outgoing || s.since ? 'Call ended' : undefined)
  }, [finish])

  // Someone left the group call, or we couldn't reach them: close just that connection.
  const drop = (s: Session, user: string) => {
    const p = s.peers.get(user)
    if (!p) return
    clearTimeout(p.lost)
    p.pc?.close()
    s.peers.delete(user)
    cap(s)
    show(s)
  }
  // Connect to someone in the group call, replacing any connection we had to them.
  const add = (s: Session, user: string, polite: boolean) => {
    drop(s, user)
    const p = newPeer(user, polite, s.kind)
    s.peers.set(user, p)
    cap(s)
    show(s)
    void connect(s, p)
    return p
  }

  const lostAfter = (s: Session, p: Peer) => {
    p.lost ??= setTimeout(() => {
      // In a group, one connection that won't come back costs that person, not the call.
      if (s.group && s.peers.size > 1) return drop(s, p.user)
      if (s.id) socket.emit('call:hangup', { id: s.id })
      if (ref.current === s) finish(s.since ? 'Connection lost' : "Couldn't connect")
    }, LOST_MS)
  }

  const handle = async (s: Session, p: Peer, d: Signal) => {
    const pc = p.pc!
    if (d.state) {
      p.muted = d.state.muted
      p.camera = d.state.camera
      show(s)
    }
    try {
      if (d.description) {
        // Perfect negotiation: on an offer collision the polite side yields.
        const collision = d.description.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable')
        p.ignoreOffer = !p.polite && collision
        if (p.ignoreOffer) return
        await pc.setRemoteDescription(d.description)
        if (d.description.type === 'offer') {
          await pc.setLocalDescription()
          signal(s, p, { description: pc.localDescription!.toJSON() })
        }
      } else if (d.candidate) {
        await pc.addIceCandidate(d.candidate).catch((e) => {
          if (!p.ignoreOffer) throw e
        })
      }
    } catch (e) {
      console.error('[call]', e)
    }
  }

  const connect = async (s: Session, p: Peer) => {
    const pc = new RTCPeerConnection({ iceServers: await s.ice })
    if (s.done || s.peers.get(p.user) !== p) return pc.close()
    p.pc = pc
    lostAfter(s, p)
    for (const t of s.local.getTracks()) {
      const sender = pc.addTrack(t, s.local)
      if (t.kind === 'video') p.video = sender
    }
    pc.ontrack = ({ track }) => {
      p.stream = new MediaStream([...(p.stream?.getTracks() ?? []), track])
      show(s)
    }
    pc.onnegotiationneeded = async () => {
      // In a group the polite side waits for the first offer: after two offers
      // cross, Chrome's rollback can leave a connection gathering no candidates.
      if (s.group && p.polite && !pc.remoteDescription) return
      try {
        p.makingOffer = true
        await pc.setLocalDescription()
        signal(s, p, { description: pc.localDescription!.toJSON() })
      } catch (e) {
        console.error('[call]', e)
      } finally {
        p.makingOffer = false
      }
    }
    pc.onicecandidate = ({ candidate }) => candidate && signal(s, p, { candidate: candidate.toJSON() })
    pc.onconnectionstatechange = () => {
      if (s.done) return // still open for a moment after hangup, while finish reads its stats
      const st = pc.connectionState
      if (st === 'connected') {
        clearTimeout(p.lost)
        p.lost = undefined
        cap(s)
        s.since ??= Date.now()
        patch({ phase: 'live', since: s.since })
      } else if (st === 'disconnected' || st === 'failed') {
        // A group call is only reconnecting once nobody is connected.
        if (s.since && ![...s.peers.values()].some((x) => x.pc?.connectionState === 'connected')) patch({ phase: 'reconnecting' })
        // Network change (wifi to cellular): find a new path instead of dropping the call.
        if (st === 'failed') pc.restartIce()
        else s.timers.push(setTimeout(() => pc.connectionState === 'disconnected' && pc.restartIce(), 3000))
        lostAfter(s, p)
      }
    }
    // An offer can be lost while the other side's socket reconnects; resend it
    // until answered. ICE that's merely slow (TURN) is left alone.
    let tries = 0
    const dog = setInterval(() => {
      if (pc.connectionState === 'connected' || pc.signalingState === 'closed' || ++tries > 6) return clearInterval(dog)
      if (pc.signalingState === 'have-local-offer' && pc.localDescription) signal(s, p, { description: pc.localDescription.toJSON() })
    }, 3000)
    s.timers.push(dog)
    s.wake ??= navigator.wakeLock?.request('screen').catch(() => undefined)
    for (const d of p.queue.splice(0)) await handle(s, p, d)
    signal(s, p, state(s))
  }

  // No peer: a group call.
  const start = useCallback(
    async (convId: string, kind: CallKind, peer?: string) => {
      if (ref.current) return
      const s = session(convId, kind, true, null, peer)
      ref.current = s
      setCall(view(s, peer ?? '', 'calling'))
      try {
        s.local = await getMedia(kind === 'video')
      } catch (e) {
        return finish(mediaError(e, kind))
      }
      if (s.done) return s.local.getTracks().forEach((t) => t.stop())
      patch({ local: s.local })
      const r = await ask<{ id?: string }>('call:start', { convId, kind })
      if (s.done) return void (r.id && socket.emit('call:hangup', { id: r.id }))
      if (!r.id) return finish(r.error)
      s.id = r.id
      s.joined = true
      patch({ phase: 'ringing' })
      s.stopTone = tone('back')
    },
    [finish],
  )

  // Answers a DM ring, or joins a group call (rung or from the chat).
  const accept = useCallback(async () => {
    const s = ref.current
    if (!s || s.outgoing || s.accepting) return
    s.accepting = true
    s.stopTone?.()
    patch({ phase: 'connecting' })
    try {
      s.local = await getMedia(s.kind === 'video')
    } catch (e) {
      socket.emit('call:hangup', { id: s.id })
      return finish(mediaError(e, s.kind))
    }
    if (s.done) return s.local.getTracks().forEach((t) => t.stop())
    patch({ local: s.local })
    const r = await ask<{ id?: string; peers?: string[] }>(s.group ? 'call:join' : 'call:accept', { id: s.id })
    if (s.done) return
    if (!r.id) return finish(r.error)
    s.joined = true
    // The joiner is the polite side to everyone already in.
    if (s.group) r.peers!.forEach((u) => add(s, u, true))
    else void connect(s, only(s))
  }, [finish])

  const join = useCallback(
    (convId: string, c: GroupCall) => {
      if (ref.current) return
      ref.current = session(convId, c.kind, false, c.id)
      setCall(view(ref.current, c.from, 'connecting'))
      void accept()
    },
    [accept],
  )

  // Rings a member of the group who isn't in the call (again, if they were). Resolves to the server's error, if any.
  const ring = useCallback(async (user: string) => {
    const s = ref.current
    if (!s?.group || !s.id) return 'This call has ended.'
    return (await ask('call:add', { id: s.id, users: [user] })).error
  }, [])

  const toggleMute = useCallback(() => {
    const s = ref.current
    if (!s) return
    s.muted = !s.muted
    s.local.getAudioTracks().forEach((t) => (t.enabled = !s.muted))
    patch({ muted: s.muted })
    sendState(s)
  }, [])

  // Our video on every connection, or none. Adding it where a voice call had
  // none renegotiates that connection.
  const setVideo = async (s: Session, t: MediaStreamTrack | null) => {
    if (t) s.local.addTrack(t)
    for (const p of s.peers.values()) {
      if (p.video) await p.video.replaceTrack(t)
      else if (t && p.pc) p.video = p.pc.addTrack(t, s.local)
    }
    cap(s)
    s.camera = !!t
    patch({ camera: s.camera, facing: s.facing, local: new MediaStream(s.local.getTracks()) })
    sendState(s)
  }

  // Off stops the camera (its light goes out); on starts it again.
  const toggleCamera = useCallback(async () => {
    const s = ref.current
    if (!s) return
    const cur = s.local.getVideoTracks()[0]
    if (cur) {
      cur.stop()
      s.local.removeTrack(cur)
      return setVideo(s, null)
    }
    const t = await getCamera(s.facing).catch(() => null)
    if (!t || s.done) return t?.stop()
    await setVideo(s, t)
  }, [])

  const flip = useCallback(async () => {
    const s = ref.current
    const cur = s?.local.getVideoTracks()[0]
    if (!s || !cur) return
    // iPhones run one camera at a time, so stop this one before asking for the other.
    cur.stop()
    s.local.removeTrack(cur)
    const want = s.facing === 'user' ? 'environment' : 'user'
    const t = await getCamera(want).catch(() => getCamera(s.facing)).catch(() => null)
    if (!t || s.done) {
      t?.stop()
      return setVideo(s, null)
    }
    s.facing = t.getSettings().facingMode === 'environment' ? 'environment' : 'user'
    await setVideo(s, t)
  }, [])

  useEffect(() => {
    const onRing = (r: CallRing) => {
      if (ref.current) return // the server won't ring someone in a call; this is a replay
      const s = session(r.convId, r.kind, false, r.id, r.group ? undefined : r.from)
      ref.current = s
      s.stopTone = tone('ring')
      setCall(view(s, r.from, 'incoming'))
    }
    const onAccepted = ({ id }: { id: string }) => {
      const s = ref.current
      if (s?.id !== id || s.group || only(s).pc) return
      s.stopTone?.()
      patch({ phase: 'connecting' })
      void connect(s, only(s))
    }
    const onSignal = ({ id, from, data }: { id: string; from?: string; data: Signal }) => {
      const s = ref.current
      if (s?.id !== id) return
      let p = s.group ? s.peers.get(from!) : only(s)
      // An offer from someone we dropped or never heard join (our socket was away): take it.
      if (!p && s.joined && data.description?.type === 'offer') p = add(s, from!, true)
      if (!p) return
      if (p.pc) void handle(s, p, data)
      else p.queue.push(data)
    }
    const onJoined = ({ id, user }: { id: string; user: string }) => {
      const s = ref.current
      if (s?.id !== id) return
      s.stopTone?.()
      if (!s.since) patch({ phase: 'connecting' })
      add(s, user, false)
    }
    const onLeft = ({ id, user }: { id: string; user: string }) => {
      const s = ref.current
      if (s?.id === id) drop(s, user)
    }
    const onEnd = ({ id, reason }: { id: string; reason: CallEnd }) => {
      const s = ref.current
      if (s?.id === id) finish(endNote(reason, s.outgoing))
    }
    // Our socket came back (phones drop it): tell the server which device we are
    // again, and in a group catch up on who left or joined meanwhile.
    const onConnect = () => {
      const s = ref.current
      if (!s?.joined) return
      socket
        .timeout(10_000)
        .emitWithAck('call:rejoin', { id: s.id })
        .then((r: { error?: string; peers?: string[] }) => {
          if (ref.current !== s) return
          if (r.error) return finish('Call ended')
          if (!s.group) return
          for (const u of s.peers.keys()) if (!r.peers!.includes(u)) drop(s, u)
          // They joined while we were away and wait, as the polite side, for our offer.
          for (const u of r.peers!) if (!s.peers.has(u)) add(s, u, false)
        }, () => {})
    }
    const onLeave = () => {
      const s = ref.current
      if (s?.id) socket.emit('call:hangup', { id: s.id })
    }
    socket.on('call:ring', onRing)
    socket.on('call:accepted', onAccepted)
    socket.on('call:signal', onSignal)
    socket.on('call:joined', onJoined)
    socket.on('call:left', onLeft)
    socket.on('call:end', onEnd)
    socket.on('connect', onConnect)
    addEventListener('pagehide', onLeave)
    return () => {
      socket.off('call:ring', onRing)
      socket.off('call:accepted', onAccepted)
      socket.off('call:signal', onSignal)
      socket.off('call:joined', onJoined)
      socket.off('call:left', onLeft)
      socket.off('call:end', onEnd)
      socket.off('connect', onConnect)
      removeEventListener('pagehide', onLeave)
      onLeave()
      finish()
    }
    // connect and handle only read refs and stable setters
  }, [finish])

  return { call, start, join, accept, hangup, ring, toggleMute, toggleCamera, flip }
}

export type Calls = ReturnType<typeof useCall>
