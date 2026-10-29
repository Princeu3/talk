import type { Voice } from '../../shared/types.ts'

export const BARS = 40
export const MAX_SECONDS = 600
// Safari records mp4 (AAC); Chrome and Firefox fall back to webm/opus.
const TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']

export const canRecord = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

// Loudness samples -> n bar heights in 0.1..1. Max per bucket keeps short
// syllables visible; sqrt lifts quiet speech so the shape reads at small sizes.
export function bucket(levels: number[], n: number): number[] {
  if (!levels.length) return Array(n).fill(0.1)
  const top = Math.max(...levels) || 1
  return Array.from({ length: n }, (_, i) => {
    const from = Math.floor((i * levels.length) / n)
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / n))
    const v = Math.max(...levels.slice(from, to)) / top
    return Math.round((0.1 + 0.9 * Math.sqrt(v)) * 100) / 100
  })
}

// One live bar from a raw RMS level (speech sits around 0.02..0.3).
export const liveBar = (v: number) => 0.12 + 0.88 * Math.min(1, Math.sqrt(v * 4))

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// Call from the tap itself: iOS only lets an AudioContext run if it was
// created inside a user gesture.
export async function startRecording() {
  const ctx = new AudioContext()
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  } catch (e) {
    void ctx.close()
    throw e
  }
  const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t))
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 48_000 } : undefined)
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }

  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  ctx.createMediaStreamSource(stream).connect(analyser)
  void ctx.resume()
  const buf = new Float32Array(analyser.fftSize)
  const levels: number[] = []
  const sample = setInterval(() => {
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (const x of buf) sum += x * x
    levels.push(Math.sqrt(sum / buf.length))
  }, 50)

  const started = performance.now()
  rec.start(250)
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    clearInterval(sample)
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
  }

  return {
    levels,
    elapsed: () => (performance.now() - started) / 1000,
    // No-op once stop() has begun, so an unmount can't swallow a message being sent.
    cancel() {
      if (rec.onstop) return
      if (rec.state !== 'inactive') rec.stop()
      end()
    },
    stop: () =>
      new Promise<{ blob: Blob; voice: Voice }>((resolve) => {
        const duration = Math.round((performance.now() - started) / 100) / 10
        rec.onstop = () => {
          end()
          resolve({ blob: new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/mp4' }), voice: { duration, peaks: bucket(levels, BARS) } })
        }
        rec.stop()
      }),
  }
}

export type Recording = Awaited<ReturnType<typeof startRecording>>
