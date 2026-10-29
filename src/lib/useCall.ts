// One live 1:1 call: ringing, the WebRTC connection and both sides' media.
// Signaling rides our socket (server/calls.ts); audio and video go peer to
// peer, or through Cloudflare TURN when a direct path can't be found.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, socket } from './api.ts'
import type { CallEnd, CallKind, CallRing } from '../../shared/types.ts'

export type Phase = 'incoming' | 'calling' | 'ringing' | 'connecting' | 'live' | 'reconnecting' | 'ended'
type Facing = 'user' | 'environment'

export interface CallView {
  convId: string
  peer: string // the other person's user id
  kind: CallKind
  phase: Phase
  since?: number // when media first connected
  note?: string // why it ended
  local?: MediaStream
  remote?: MediaStream
  muted: boolean
  camera: boolean
  facing: Facing
  remoteMuted: boolean
  remoteCamera: boolean
}

interface Signal {
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
  state?: { muted: boolean; camera: boolean }
}

interface Session {
  id: string | null
  convId: string
  kind: CallKind
  outgoing: boolean // the caller is the impolite peer in perfect negotiation
  ice: Promise<RTCIceServer[]>
  local: MediaStream
  pc?: RTCPeerConnection
  video?: RTCRtpSender
  queue: Signal[] // signals that arrive before our peer connection exists
  makingOffer: boolean
  ignoreOffer: boolean
  accepting: boolean
  since?: number
  muted: boolean
  camera: boolean
  facing: Facing
  lost?: ReturnType<typeof setTimeout>
  timers: ReturnType<typeof setTimeout>[]
  stopTone?: () => void
  wake?: WakeLockSentinel
  done: boolean
}

const LOST_MS = 30_000
const STUN: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]
const fetchIce = () => api<RTCIceServer[]>('GET', '/api/ice').catch(() => STUN)

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

export function useCall(onLog: (convId: string, kind: CallKind, ms: number) => void) {
  const [call, setCall] = useState<CallView | null>(null)
  const ref = useRef<Session | null>(null)
  const logRef = useRef(onLog)
  logRef.current = onLog
  const patch = (p: Partial<CallView>) => setCall((v) => v && { ...v, ...p })

  const session = (convId: string, kind: CallKind, outgoing: boolean, id: string | null = null): Session => ({
    id, convId, kind, outgoing, ice: fetchIce(), local: new MediaStream(), queue: [], makingOffer: false, ignoreOffer: false,
    accepting: false, muted: false, camera: kind === 'video', facing: 'user', timers: [], done: false,
  })
  const view = (s: Session, peer: string, phase: Phase): CallView => ({
    convId: s.convId, peer, kind: s.kind, phase, muted: false, camera: s.camera, facing: 'user',
    remoteMuted: false, remoteCamera: s.kind === 'video',
  })

  const signal = (s: Session, data: Signal) => s.id && socket.emit('call:signal', { id: s.id, data })
  const sendState = (s: Session) => signal(s, { state: { muted: s.muted, camera: s.camera } })

  const finish = useCallback((note?: string) => {
    const s = ref.current
    if (!s) return
    s.done = true
    ref.current = null
    s.stopTone?.()
    clearTimeout(s.lost)
    s.timers.forEach(clearInterval)
    s.pc?.close()
    s.local.getTracks().forEach((t) => t.stop())
    s.wake?.release().catch(() => {})
    if (s.outgoing && s.id) logRef.current(s.convId, s.kind, s.since ? Date.now() - s.since : 0)
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

  const lostAfter = (s: Session) => {
    s.lost ??= setTimeout(() => {
      if (s.id) socket.emit('call:hangup', { id: s.id })
      if (ref.current === s) finish(s.since ? 'Connection lost' : "Couldn't connect")
    }, LOST_MS)
  }

  const handle = async (s: Session, d: Signal) => {
    const pc = s.pc!
    if (d.state) patch({ remoteMuted: d.state.muted, remoteCamera: d.state.camera })
    try {
      if (d.description) {
        // Perfect negotiation: on an offer collision the callee yields.
        const collision = d.description.type === 'offer' && (s.makingOffer || pc.signalingState !== 'stable')
        s.ignoreOffer = s.outgoing && collision
        if (s.ignoreOffer) return
        await pc.setRemoteDescription(d.description)
        if (d.description.type === 'offer') {
          await pc.setLocalDescription()
          signal(s, { description: pc.localDescription!.toJSON() })
        }
      } else if (d.candidate) {
        await pc.addIceCandidate(d.candidate).catch((e) => {
          if (!s.ignoreOffer) throw e
        })
      }
    } catch (e) {
      console.error('[call]', e)
    }
  }

  const connect = async (s: Session) => {
    const pc = new RTCPeerConnection({ iceServers: await s.ice })
    if (s.done) return pc.close()
    s.pc = pc
    lostAfter(s)
    for (const t of s.local.getTracks()) {
      const sender = pc.addTrack(t, s.local)
      if (t.kind === 'video') s.video = sender
    }
    const remote = new MediaStream()
    pc.ontrack = ({ track }) => {
      remote.addTrack(track)
      patch({ remote: new MediaStream(remote.getTracks()) })
    }
    pc.onnegotiationneeded = async () => {
      try {
        s.makingOffer = true
        await pc.setLocalDescription()
        signal(s, { description: pc.localDescription!.toJSON() })
      } catch (e) {
        console.error('[call]', e)
      } finally {
        s.makingOffer = false
      }
    }
    pc.onicecandidate = ({ candidate }) => candidate && signal(s, { candidate: candidate.toJSON() })
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st === 'connected') {
        clearTimeout(s.lost)
        s.lost = undefined
        s.since ??= Date.now()
        patch({ phase: 'live', since: s.since })
      } else if (st === 'disconnected' || st === 'failed') {
        if (s.since) patch({ phase: 'reconnecting' })
        // Network change (wifi to cellular): find a new path instead of dropping the call.
        if (st === 'failed') pc.restartIce()
        else s.timers.push(setTimeout(() => pc.connectionState === 'disconnected' && pc.restartIce(), 3000))
        lostAfter(s)
      }
    }
    // An offer can be lost while the other side's socket reconnects; resend it
    // until answered. ICE that's merely slow (TURN) is left alone.
    let tries = 0
    const dog = setInterval(() => {
      if (pc.connectionState === 'connected' || pc.signalingState === 'closed' || ++tries > 6) return clearInterval(dog)
      if (pc.signalingState === 'have-local-offer' && pc.localDescription) signal(s, { description: pc.localDescription.toJSON() })
    }, 3000)
    s.timers.push(dog)
    navigator.wakeLock?.request('screen').then((w) => (s.wake = w), () => {})
    for (const d of s.queue.splice(0)) await handle(s, d)
    sendState(s)
  }

  const start = useCallback(
    async (convId: string, peer: string, kind: CallKind) => {
      if (ref.current) return
      const s = session(convId, kind, true)
      ref.current = s
      setCall(view(s, peer, 'calling'))
      try {
        s.local = await getMedia(kind === 'video')
      } catch (e) {
        return finish(mediaError(e, kind))
      }
      if (s.done) return s.local.getTracks().forEach((t) => t.stop())
      patch({ local: s.local })
      const r: { id?: string; error?: string } = await socket
        .timeout(10_000)
        .emitWithAck('call:start', { convId, kind })
        .catch(() => ({ error: "Couldn't reach the server. Check your connection." }))
      if (s.done) return void (r.id && socket.emit('call:hangup', { id: r.id }))
      if (!r.id) return finish(r.error)
      s.id = r.id
      patch({ phase: 'ringing' })
      s.stopTone = tone('back')
    },
    [finish],
  )

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
    const r: { id?: string; error?: string } = await socket
      .timeout(10_000)
      .emitWithAck('call:accept', { id: s.id })
      .catch(() => ({ error: "Couldn't reach the server. Check your connection." }))
    if (!r.id) return finish(r.error)
    void connect(s)
  }, [finish])

  const toggleMute = useCallback(() => {
    const s = ref.current
    if (!s) return
    s.muted = !s.muted
    s.local.getAudioTracks().forEach((t) => (t.enabled = !s.muted))
    patch({ muted: s.muted })
    sendState(s)
  }, [])

  // Off stops the camera (its light goes out); on starts it again. Turning it
  // on in a voice call adds video, which renegotiates the connection.
  const toggleCamera = useCallback(async () => {
    const s = ref.current
    if (!s) return
    const cur = s.local.getVideoTracks()[0]
    if (cur) {
      cur.stop()
      s.local.removeTrack(cur)
      await s.video?.replaceTrack(null)
      s.camera = false
    } else {
      const t = await getCamera(s.facing).catch(() => null)
      if (!t || s.done) return t?.stop()
      s.local.addTrack(t)
      if (s.video) await s.video.replaceTrack(t)
      else if (s.pc) s.video = s.pc.addTrack(t, s.local)
      s.camera = true
    }
    patch({ camera: s.camera, local: new MediaStream(s.local.getTracks()) })
    sendState(s)
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
      await s.video?.replaceTrack(null)
      s.camera = false
      patch({ camera: false, local: new MediaStream(s.local.getTracks()) })
      return sendState(s)
    }
    s.facing = t.getSettings().facingMode === 'environment' ? 'environment' : 'user'
    s.local.addTrack(t)
    await s.video?.replaceTrack(t)
    patch({ facing: s.facing, local: new MediaStream(s.local.getTracks()) })
  }, [])

  useEffect(() => {
    const onRing = (r: CallRing) => {
      if (ref.current) return // the server won't ring someone in a call; this is a replay
      const s = session(r.convId, r.kind, false, r.id)
      ref.current = s
      s.stopTone = tone('ring')
      setCall(view(s, r.from, 'incoming'))
    }
    const onAccepted = ({ id }: { id: string }) => {
      const s = ref.current
      if (s?.id !== id || s.pc) return
      s.stopTone?.()
      patch({ phase: 'connecting' })
      void connect(s)
    }
    const onSignal = ({ id, data }: { id: string; data: Signal }) => {
      const s = ref.current
      if (s?.id !== id) return
      if (s.pc) void handle(s, data)
      else s.queue.push(data)
    }
    const onEnd = ({ id, reason }: { id: string; reason: CallEnd }) => {
      const s = ref.current
      if (s?.id === id) finish(endNote(reason, s.outgoing))
    }
    // Our socket came back (phones drop it): tell the server which device we are again.
    const onConnect = () => {
      const s = ref.current
      if (!s?.id || (!s.outgoing && !s.pc)) return
      socket
        .timeout(10_000)
        .emitWithAck('call:rejoin', { id: s.id })
        .then((r: { error?: string }) => r.error && ref.current === s && finish('Call ended'), () => {})
    }
    const onLeave = () => {
      const s = ref.current
      if (s?.id) socket.emit('call:hangup', { id: s.id })
    }
    socket.on('call:ring', onRing)
    socket.on('call:accepted', onAccepted)
    socket.on('call:signal', onSignal)
    socket.on('call:end', onEnd)
    socket.on('connect', onConnect)
    addEventListener('pagehide', onLeave)
    return () => {
      socket.off('call:ring', onRing)
      socket.off('call:accepted', onAccepted)
      socket.off('call:signal', onSignal)
      socket.off('call:end', onEnd)
      socket.off('connect', onConnect)
      removeEventListener('pagehide', onLeave)
      onLeave()
      finish()
    }
    // connect and handle only read refs and stable setters
  }, [finish])

  return { call, start, accept, hangup, toggleMute, toggleCamera, flip }
}

export type Calls = ReturnType<typeof useCall>
