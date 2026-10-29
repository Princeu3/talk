import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { Voice } from '../../shared/types.ts'
import { clock, liveBar, MAX_SECONDS, type Recording } from '../lib/voice.ts'
import { Pause, Play, Send, Trash } from './icons.tsx'

const LIVE_BARS = 120 // more than any composer fits; the oldest clip off the left edge

// Replaces the composer row while recording: cancel, timer, live waveform, send.
export function VoiceRecorder({ rec, onCancel, onSend }: { rec: Recording; onCancel: () => void; onSend: () => void }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 80)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onSend()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onCancel, onSend])

  const secs = rec.elapsed()
  useEffect(() => {
    if (secs >= MAX_SECONDS) onSend()
  }, [secs, onSend])

  // Newest bars on the right, so speech scrolls in like a tape.
  const tail = rec.levels.slice(-LIVE_BARS)
  const bars = [...Array(LIVE_BARS - tail.length).fill(0), ...tail]
  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={onCancel} aria-label="Delete recording" className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-danger hover:bg-raised">
        <Trash size={22} />
      </button>
      <div className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-[22px] bg-bg pl-4 pr-3">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-danger motion-safe:animate-pulse" aria-hidden />
        <span role="timer" aria-label={`Recording, ${clock(secs)}`} className="w-10 shrink-0 text-sm font-medium tabular-nums">
          {clock(secs)}
        </span>
        <div className="flex h-7 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden" aria-hidden>
          {bars.map((v, i) => (
            <span key={i} className="w-[3px] shrink-0 rounded-full bg-ink/70 transition-[height] duration-75" style={{ height: `${liveBar(v) * 100}%` }} />
          ))}
        </div>
      </div>
      <button type="button" onClick={onSend} aria-label="Send voice message" className="pressable ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fill text-on-fill">
        <Send size={18} />
      </button>
    </div>
  )
}

let current: HTMLAudioElement | null = null // only one voice message plays at a time
const RATES = [1, 1.5, 2]

export function VoicePlayer({ url, voice, failed, onRetry }: { url?: string; voice: Voice; failed: boolean; onRetry: () => void }) {
  const audio = useRef<HTMLAudioElement>(null)
  const wave = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [at, setAt] = useState(0)
  const [rate, setRate] = useState(1)
  // Recorded webm often reports an Infinity duration, so trust the stored one.
  const dur = voice.duration || 1
  const frac = Math.min(1, at / dur)

  // timeupdate fires ~4x a second; follow frames instead so the fill glides.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const step = () => {
      setAt(audio.current?.currentTime ?? 0)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  useEffect(() => () => audio.current?.pause(), [])

  const toggle = () => {
    const a = audio.current
    if (!a) return
    if (!a.paused) return a.pause()
    if (current && current !== a) current.pause()
    current = a
    a.playbackRate = rate
    void a.play()
  }
  const seekTo = (s: number) => {
    const t = Math.max(0, Math.min(dur, s))
    if (audio.current) audio.current.currentTime = t
    setAt(t)
  }
  const fromPointer = (e: PointerEvent) => {
    const r = wave.current!.getBoundingClientRect()
    seekTo(((e.clientX - r.left) / r.width) * dur)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') seekTo(at + 5)
    else if (e.key === 'ArrowLeft') seekTo(at - 5)
    else return
    e.preventDefault()
  }
  const nextRate = () => {
    const r = RATES[(RATES.indexOf(rate) + 1) % RATES.length]
    setRate(r)
    if (audio.current) audio.current.playbackRate = r
  }

  const filled = Math.round(frac * voice.peaks.length)
  return (
    <div className="flex w-56 items-center gap-3 sm:w-64">
      {url && (
        <audio
          ref={audio}
          src={url}
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false)
            seekTo(0)
          }}
        />
      )}
      <button
        type="button"
        onClick={failed ? onRetry : toggle}
        disabled={!url && !failed}
        aria-label={failed ? 'Couldn’t load voice message. Retry' : playing ? 'Pause voice message' : 'Play voice message'}
        className={`pressable flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-fill text-on-fill ${!url && !failed ? 'motion-safe:animate-pulse' : ''}`}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div className="min-w-0 flex-1">
        <div
          ref={wave}
          role="slider"
          tabIndex={0}
          aria-label="Voice message position"
          aria-valuemin={0}
          aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(at)}
          aria-valuetext={`${clock(at)} of ${clock(dur)}`}
          onKeyDown={onKey}
          onPointerDown={(e) => {
            if (!url) return
            e.currentTarget.setPointerCapture(e.pointerId)
            fromPointer(e)
          }}
          onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && fromPointer(e)}
          className="flex h-7 cursor-pointer touch-none items-center gap-[2px] rounded-sm"
        >
          {voice.peaks.map((p, i) => (
            <span key={i} className={`min-w-[2px] flex-1 rounded-full ${i < filled ? 'bg-ink' : 'bg-ink/30'}`} style={{ height: `${p * 100}%` }} />
          ))}
        </div>
        <div className="mt-0.5 flex items-center justify-between text-xs tabular-nums text-ink/80">
          <span>{failed ? 'Couldn’t load' : clock(playing || at > 0 ? at : dur)}</span>
          <button
            type="button"
            onClick={nextRate}
            aria-label={`Playback speed ${rate} times`}
            className="relative rounded-full bg-ink/10 px-1.5 font-semibold after:absolute after:-inset-3 after:content-['']"
          >
            {rate}×
          </button>
        </div>
      </div>
    </div>
  )
}
