import { useEffect } from 'react'
import { Close, External, Video } from './icons.tsx'

// Calls run in the meetup app (P2P mesh WebRTC). We only embed a room whose id
// was shared inside an encrypted message, so only conversation members know it.
export function CallOverlay({ url, onLeave }: { url: string; onLeave: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="pt-safe flex items-center justify-between gap-2 px-3 pb-2 text-white">
        <a href={url} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm text-white/80">
          <External size={16} /> Open in browser
        </a>
        <button onClick={onLeave} className="pressable flex min-h-11 items-center gap-1.5 rounded-full bg-white/15 px-4 text-sm font-semibold">
          <Close size={16} /> Close
        </button>
      </div>
      <iframe
        src={url}
        title="Call"
        allow="camera; microphone; display-capture; autoplay; fullscreen; screen-wake-lock"
        className="w-full flex-1 border-0"
      />
    </div>
  )
}

// Two-tone ring through Web Audio; iOS may block it before the first tap, in
// which case the banner alone has to do.
function ring() {
  try {
    const ctx = new AudioContext()
    const beep = (at: number, f: number) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at)
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.35)
      o.connect(g).connect(ctx.destination)
      o.start(ctx.currentTime + at)
      o.stop(ctx.currentTime + at + 0.4)
    }
    beep(0, 660)
    beep(0.4, 880)
    setTimeout(() => ctx.close(), 1000)
  } catch {
    // no audio, banner only
  }
}

export function IncomingCall({ from, onJoin, onDismiss }: { from: string; onJoin: () => void; onDismiss: () => void }) {
  useEffect(() => {
    ring()
    const r = setInterval(ring, 2500)
    const stop = setTimeout(onDismiss, 45_000)
    return () => {
      clearInterval(r)
      clearTimeout(stop)
    }
  }, [onDismiss])
  return (
    <div className="pt-safe fixed inset-x-0 top-0 z-50 flex justify-center px-3" role="alert">
      {/* floats over the chat, so it keeps its depth cue */}
      <div /* taste-skill-ignore */ className="rise flex w-full max-w-md items-center gap-3 rounded-3xl bg-surface p-3 shadow-2xl shadow-black/30">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fill text-white"><Video /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{from}</div>
          <div className="text-sm text-mut">is calling…</div>
        </div>
        <button onClick={onDismiss} className="pressable min-h-11 rounded-full bg-raised px-4 text-sm font-semibold">Later</button>
        <button onClick={onJoin} className="pressable min-h-11 rounded-full bg-fill px-5 text-sm font-semibold text-white">Join</button>
      </div>
    </div>
  )
}
