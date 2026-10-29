import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Calls, CallView } from '../lib/useCall.ts'
import { clock } from '../lib/voice.ts'
import { Avatar } from './Sidebar.tsx'
import { ChevronDown, Lock, Mic, MicOff, Phone, SwitchCamera, Video, VideoOff } from './icons.tsx'

// The call screens are black whatever the theme, like the photo viewer, so
// they use white and the two universal call colors directly.
const END = 'bg-[#e5484d] text-white'
const ACCEPT = 'bg-[#30a46c] text-white'

export function status(c: CallView) {
  switch (c.phase) {
    case 'incoming': return c.kind === 'video' ? 'Video call' : 'Voice call'
    case 'calling': return 'Calling…'
    case 'ringing': return 'Ringing…'
    case 'connecting': return 'Connecting…'
    case 'reconnecting': return 'Reconnecting…'
    case 'live': return clock((Date.now() - c.since!) / 1000)
    case 'ended': return c.note ?? 'Call ended'
  }
}

function useSecondTick(on: boolean) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [on])
}

function useStream<T extends HTMLMediaElement>(stream?: MediaStream) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream ?? null
  }, [stream])
  return ref
}

const EndIcon = () => <span className="rotate-[135deg]"><Phone size={26} /></span>

// Remote sound plays here, outside the call screen, so it keeps going while the
// screen is minimized to the bar.
export function CallAudio({ stream }: { stream?: MediaStream }) {
  const ref = useStream<HTMLAudioElement>(stream)
  return <audio ref={ref} autoPlay />
}

function Round({ label, caption, tone = 'bg-white/15 text-white hover:bg-white/25', pressed, onClick, children }: {
  label: string
  caption?: string
  tone?: string
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        className={`pressable flex items-center justify-center rounded-full ${caption ? 'h-[4.5rem] w-[4.5rem]' : 'h-14 w-14'} ${pressed ? 'bg-white text-black' : tone}`}
      >
        {children}
      </button>
      {caption && <span className="text-sm text-white/80">{caption}</span>}
    </div>
  )
}

export function CallScreen({ call, name, calls, onMinimize }: { call: CallView; name: string; calls: Calls; onMinimize: () => void }) {
  useSecondTick(call.phase === 'live')
  const remoteRef = useStream<HTMLVideoElement>(call.remote)
  const localRef = useStream<HTMLVideoElement>(call.local)
  const ended = call.phase === 'ended'
  const incoming = call.phase === 'incoming'
  const showRemote = !ended && call.remoteCamera && !!call.remote?.getVideoTracks().length
  const showLocal = !ended && call.camera && !!call.local?.getVideoTracks().length
  // Before the other side picks up, your own camera fills the screen, like a mirror.
  const localFull = showLocal && !showRemote && !call.since

  const [cams, setCams] = useState(1)
  useEffect(() => {
    if (showLocal) navigator.mediaDevices.enumerateDevices().then((d) => setCams(d.filter((x) => x.kind === 'videoinput').length), () => {})
  }, [showLocal])

  // In a video call the controls fade after a few seconds; a tap brings them back.
  const [chrome, setChrome] = useState(true)
  useEffect(() => {
    if (!showRemote || !chrome) return
    const t = setTimeout(() => setChrome(false), 4000)
    return () => clearTimeout(t)
  }, [showRemote, chrome])
  const fade = `transition-opacity duration-300 ${showRemote && !chrome ? 'pointer-events-none opacity-0' : ''}`

  return (
    <div role="dialog" aria-label={`Call with ${name}`} className="fixed inset-0 z-50 overflow-hidden bg-black text-white" onClick={() => setChrome((c) => !c)}>
      <video ref={remoteRef} autoPlay playsInline muted className={showRemote ? 'absolute inset-0 h-full w-full object-cover' : 'hidden'} />
      <video
        ref={localRef}
        autoPlay
        playsInline
        muted
        className={`${!showLocal ? 'hidden' : localFull ? 'absolute inset-0 h-full w-full object-cover opacity-60' : 'absolute right-3 top-[calc(max(0.75rem,env(safe-area-inset-top))+3.75rem)] z-10 aspect-[3/4] w-[28vw] max-w-40 rounded-2xl object-cover'} ${call.facing === 'user' ? '-scale-x-100' : ''}`}
      />

      <div className={`pt-safe relative z-20 flex items-center px-2 ${fade}`}>
        {incoming || ended ? (
          <span className="w-11" />
        ) : (
          <button type="button" onClick={(e) => (e.stopPropagation(), onMinimize())} aria-label="Back to chat" className="pressable flex h-11 w-11 items-center justify-center rounded-full hover:bg-white/10">
            <ChevronDown size={26} />
          </button>
        )}
        <div className="min-w-0 flex-1 text-center">
          {showRemote ? (
            <>
              <div className="truncate font-semibold">{name}</div>
              <div className="text-sm tabular-nums text-white/80">{call.remoteMuted ? `Muted · ${status(call)}` : status(call)}</div>
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs text-white/70"><Lock size={12} /> End-to-end encrypted</span>
          )}
        </div>
        <span className="w-11" />
      </div>

      {!showRemote && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-8 text-center">
          <Avatar name={name} size={120} />
          <div>
            <h2 className="text-3xl font-semibold tracking-tight">{name}</h2>
            <p role="status" className="mt-1.5 text-lg tabular-nums text-white/75">{status(call)}</p>
          </div>
          {call.remoteMuted && !ended && (
            <p className="flex items-center gap-1.5 text-sm text-white/75"><MicOff size={14} /> {name} is muted</p>
          )}
        </div>
      )}

      {!ended && (
        <div className={`pb-safe absolute inset-x-0 bottom-0 z-20 flex justify-center px-6 pt-4 ${fade}`}>
          {incoming ? (
            <div className="mb-6 flex w-full max-w-xs justify-between">
              <Round label="Decline" caption="Decline" tone={END} onClick={calls.hangup}><EndIcon /></Round>
              <Round label="Accept" caption="Accept" tone={ACCEPT} onClick={calls.accept}>
                {call.kind === 'video' ? <Video size={28} /> : <Phone size={26} />}
              </Round>
            </div>
          ) : (
            <div className="mb-4 flex items-center gap-3 rounded-full bg-white/10 p-2.5 backdrop-blur-xl sm:gap-4">
              <Round label="Mute" pressed={call.muted} onClick={calls.toggleMute}>{call.muted ? <MicOff size={24} /> : <Mic size={24} />}</Round>
              <Round label="Camera" pressed={!call.camera} onClick={calls.toggleCamera}>{call.camera ? <Video size={24} /> : <VideoOff size={24} />}</Round>
              {showLocal && cams > 1 && <Round label="Switch camera" onClick={calls.flip}><SwitchCamera size={24} /></Round>}
              <Round label="End call" tone={END} onClick={calls.hangup}><EndIcon /></Round>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// The minimized call: a bar above the app, like a phone's in-call banner.
export function CallBar({ call, name, calls, onExpand }: { call: CallView; name: string; calls: Calls; onExpand: () => void }) {
  useSecondTick(call.phase === 'live')
  return (
    <div className="pt-safe flex items-center gap-1 bg-fill px-2 pb-1.5 text-on-fill">
      <button type="button" onClick={onExpand} aria-label={`Return to call with ${name}`} className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full px-2 text-left">
        <Avatar name={name} size={28} />
        <span className="truncate font-semibold">{name}</span>
        <span role="status" className="shrink-0 tabular-nums opacity-80">{status(call)}</span>
      </button>
      {call.phase !== 'ended' && (
        <>
          <button type="button" onClick={calls.toggleMute} aria-label="Mute" aria-pressed={call.muted} className={`pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${call.muted ? 'bg-on-fill text-fill' : 'hover:bg-on-fill/15'}`}>
            {call.muted ? <MicOff /> : <Mic />}
          </button>
          <button type="button" onClick={calls.hangup} aria-label="End call" className={`pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${END}`}>
            <span className="rotate-[135deg]"><Phone /></span>
          </button>
        </>
      )}
    </div>
  )
}
