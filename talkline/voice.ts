// The urgent ring talks (Phase 3a): an answer-only werift peer on the owner's call, Deepgram Aura-2 speaks and Flux
// listens, and a spoken yes or no settles the ask. ask.ts loads this only through `await import('./voice.ts')`, so
// hooks never load werift. Nothing here writes to stdout or stderr: the permission hook prints JSON on stdout.
import { randomInt } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Socket } from 'socket.io-client'
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket, usePCMU, useVP8 } from 'werift'

export type Signal = { description?: { type: 'offer' | 'answer'; sdp: string }; candidate?: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }; state?: object }
export interface Converse {
  s: Socket
  id: string
  signals: { id: string; data: Signal }[] // ask.ts's buffer
  ended: Promise<void> // ask.ts's hungUp: call:end for this call, or a rejoin's error
  key: string
  name: string // the helper's, e.g. "Claude AI"
  question: string
  detail: boolean
  digits?: string // the 6-digit voice code: high risk, or any ask with a detail (5.2)
  settled: Promise<unknown> // ask.ts's settled: resolves or rejects when the ask closes
  live: () => void // the gate passed: ask.ts posts the voice code
  answer: (v: 'yes' | 'no') => void // settle(v, 'voice')
}
export interface Outcome {
  result: 'yes' | 'no' | 'gave up' | 'answered' | 'hung up' | 'timeout' | 'failed'
  stage?: 'start' | 'call' // a failure before or after the first word
  error?: string // never holds the key
  connectMs?: number // pick-up to connected
  speakMs?: number // pick-up to the first word
  heard: { text: string; taken: boolean }[] // every Flux EndOfTurn transcript
}

const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }] // shortcut: STUN only, Talk gives helpers no TURN (/api/ice 403); add TURN if LTE calls fail to connect.
// A fake Deepgram in tests, like APNS_ORIGIN, but only on this machine: the key must never go elsewhere in the clear.
const ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(process.env.DEEPGRAM_ORIGIN ?? '') ? process.env.DEEPGRAM_ORIGIN! : 'https://api.deepgram.com'
const CONNECT_MS = 15_000 // pick-up to connected, Flux open and the opening fetched; the phone gives up at 30 s
const LEAD_MS = 500 // silence before the first word while the iPhone starts its audio session
const LISTEN_MS = 8_000 // after a prompt, for an answer to start
const CODE_MS = 20_000 // the same when digits are needed: time to open the chat
const TURN_MS = 15_000 // a started answer gets this long to end
const HOLD_MS = 1_500 // after a turn that isn't a no: a next turn starting within this joins it
const OVER_MS = 300 // a turn starting within this of our last sound was said over us: not taken
const CALL_MS = 120_000 // shortcut: cap on the whole conversation; raise it if questions get long
const FRAME = 160 // 20 ms of µ-law at 8 kHz
const SILENCE = 0xff // µ-law zero; a 0x00 byte is a loud sample

// --- what the helper says ---

const hello = (name: string) => `Hi, this is ${name}, an AI helper, not a person. Deepgram transcribes this call.`
// An http(s) address goes as its host, so a user:password@, path or query (tokens included) never reaches Deepgram.
// shortcut: cut at 500 characters mid-sentence; the chat has it all.
const spoken = (q: string) => q.replace(/\bhttps?:\/\/(?:[^\s/?#]*@)?([^\s/?#]+)\S*/gi, '$1').replace(/\s*\n\s*/g, '. ').slice(0, 500)
const prompt = (c: Converse) =>
  c.digits
    ? `${spoken(c.question)}${c.detail ? ' The details are in our chat.' : ''} To approve, open our chat, then say yes and the six digits shown there. To deny, say no.`
    : `${spoken(c.question)} Say yes or no.`
const AGAIN = "Sorry, I didn't catch that. Please say yes or no."
const AGAIN_HIGH = "Sorry, I didn't catch that. Say no, or yes and the six digits from our chat."
const NEED_CODE = 'I need the six digits shown in our chat too. Say them one at a time.'
const WRONG_CODE = "Those digits don't match. Say the six digits shown in our chat."
const YES = 'Got it: yes. Bye.'
const NO = 'Got it: no. Bye.'
const GIVE_UP = "I'll post the question in our chat. Bye."

// --- what the owner says ---

// The typed PLAIN words (ask.ts) without emoji and single letters, plus spoken forms. ok and okay are filler: on a call
// they mostly mean "I hear you".
const YES_WORDS = new Set(['yes', 'yep', 'yeah', 'yup', 'sure', 'approve', 'approved'])
const NO_WORDS = new Set(['no', 'nope', 'nah', 'deny', 'denied', "don't", 'dont', 'stop', 'cancel'])
const FILLER = new Set(['ok', 'okay', 'please', 'thanks', 'thank', 'you', 'uh', 'um', 'oh', 'so', 'well', 'and', 'i', 'said', 'go', 'ahead', 'do', 'it', 'the', 'code', 'is', 'digits', 'that', "that's"])
const DIGIT = new Map(Object.entries({ zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' })) // a Map: `in` on an object matches "constructor"

export function verdict(text: string, digits?: string, saidYes = false) {
  const w = text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)
  // Negation wins: any no-word, or "do not", denies whatever else was said. A deny is always safe.
  if (w.some((x, i) => NO_WORDS.has(x) || (x === 'do' && w[i + 1] === 'not'))) return 'no'
  const num = (x?: string) => !!x && x !== 'oh' && (/^\d+$/.test(x) || DIGIT.has(x))
  // "oh" is 0 only next to another digit, so "oh yes" stays filler.
  const said = w.map((x, i) => (/^\d+$/.test(x) ? x : x === 'oh' ? (num(w[i - 1]) || num(w[i + 1]) ? '0' : '') : (DIGIT.get(x) ?? ''))).join('')
  const yes = saidYes || w.some((x) => YES_WORDS.has(x)) || /\b(go ahead|do it)\b/.test(w.join(' '))
  // A yes can't carry anything else, as typed: "yes, but not on prod" isn't taken.
  if (!yes || !w.every((x) => YES_WORDS.has(x) || FILLER.has(x) || /^\d+$/.test(x) || DIGIT.has(x))) return 'unclear'
  if (!digits) return said ? 'unclear' : 'yes'
  return !said ? 'need code' : said === digits ? 'yes' : 'wrong code'
}

// --- Deepgram ---

// Aura-2 over REST, one POST a line: our text is known up front. Raw µ-law, 8 kHz mono; `container=none`, since a
// wav header clicks.
export async function tts(key: string, text: string) {
  const r = await fetch(`${ORIGIN}/v1/speak?model=aura-2-thalia-en&encoding=mulaw&sample_rate=8000&container=none&mip_opt_out=true`, {
    method: 'POST',
    headers: { authorization: `Token ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!r.ok) throw new Error(`Deepgram speak: ${(await r.json().catch(() => null))?.err_msg ?? r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

// Flux over Node's own WebSocket. A bad key shows on it only as a close 1006, so it opens after Aura took the key.
function flux(key: string, onTurn: (m: { event: string; transcript: string }) => void, broke: (e: Error) => void) {
  const ws = new WebSocket(
    `${ORIGIN.replace(/^http/, 'ws')}/v2/listen?model=flux-general-en&encoding=mulaw&sample_rate=8000&mip_opt_out=true`,
    { headers: { authorization: `Token ${key}` } } as unknown as string[], // shortcut: the DOM lib types the 2nd argument as protocols; Node's WebSocket (undici) also takes {headers}.
  )
  let sentAt = 0
  const open = new Promise<void>((ok, no) => {
    ws.onopen = () => ok()
    // One error for both: a close before open breaks the call too, and whichever lands first is the one logged.
    ws.onclose = (e) => {
      const err = new Error(`Deepgram listen: closed ${e.code}`)
      no(err)
      broke(err)
    }
  })
  open.catch(() => {})
  ws.onmessage = (e) => {
    let m
    try {
      m = JSON.parse(String(e.data))
    } catch {
      return // a throw in a WebSocket listener would crash the process
    }
    if (m.type === 'TurnInfo') onTurn(m)
    // Flux's fatal message: ListenV2FatalError in its reference, but its type is 'Error'.
    if (m.type === 'Error') broke(new Error(`Deepgram listen: ${m.code} ${m.description}`))
  }
  const send = (b: Buffer<ArrayBuffer>) => ws.readyState === WebSocket.OPEN && (ws.send(b), (sentAt = performance.now()))
  // shortcut: Flux documents no KeepAlive or idle timeout; v1 closes after 10 s without audio, so 80 ms of silence each idle second.
  const keep = setInterval(() => performance.now() - sentAt > 1000 && send(Buffer.alloc(640, SILENCE)), 1000)
  const close = () => (clearInterval(keep), ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'CloseStream' })), ws.close())
  return { open, send, close }
}

// --- werift ---

// Never offers: answers the phone's offer, its resends, an ICE restart and a camera-on renegotiation.
function answerOnly(send: (d: Signal) => void) {
  // PCMU only: G.711 is in every WebRTC offer, and Deepgram takes and gives it as is. VP8 only so a video line can be
  // answered inactive: with no video codec werift rejects it (port 0). 1 s STUN gathering: an unreachable STUN cost 5 s.
  const pc = new RTCPeerConnection({ iceServers: ICE, iceStunGatherTimeout: 1, codecs: { audio: [usePCMU()], video: [useVP8()] } })
  const voice = new MediaStreamTrack({ kind: 'audio' })
  let answered: Signal['description']
  let origin = ''
  let error: string | undefined
  pc.onicecandidate = ({ candidate }) => candidate && send({ candidate: candidate.toJSON() })
  const handle = async (d: Signal) => {
    if (d.candidate) return pc.addIceCandidate(d.candidate)
    if (d.description?.type !== 'offer') return
    // The phone resends an unanswered offer with its candidates added: same o= line, so repeat our answer.
    // werift rebuilds the remote SDP, so compare the raw offers' o= lines, not remoteDescription.
    const o = /^o=.*$/m.exec(d.description.sdp)?.[0] ?? ''
    if (answered && o === origin) return send({ description: answered })
    await pc.setRemoteDescription(d.description)
    if (!pc.getSenders().some((x) => x.track === voice)) pc.addTrack(voice) // reuses the offer's audio transceiver
    // inactive, not rejected: a port-0 video line breaks the web app's later replaceTrack.
    for (const x of pc.getTransceivers()) if (x.kind === 'video' && !x.stopped) x.setDirection('inactive')
    const answer = await pc.createAnswer()
    answered = { type: 'answer', sdp: answer.sdp }
    origin = o
    send({ description: answered }) // before SLD: werift's resolves only after gathering
    await pc.setLocalDescription(answer)
  }
  let chain: Promise<unknown> = Promise.resolve()
  const onSignal = (d: Signal) => void (chain = chain.then(() => handle(d)).catch((e: Error) => (error = e.message)))
  // After connect, failed or disconnected is left alone: the phone restarts ICE and its new offer gets an answer.
  const connected = new Promise<void>((ok) => pc.connectionStateChange.subscribe((st) => st === 'connected' && ok()))
  return { pc, voice, onSignal, connected, error: () => error }
}

// 20 ms of µ-law every 20 ms, on the clock: a clip while one is queued, silence otherwise.
function speaker(voice: MediaStreamTrack) {
  const silence = Buffer.alloc(FRAME, SILENCE)
  let queue = Buffer.alloc(0)
  let seq = randomInt(0x10000)
  let ts = randomInt(2 ** 32 - 1)
  let n = 0
  let t0 = 0
  let last = 0
  let timer: NodeJS.Timeout | undefined
  const drained: (() => void)[] = []
  const tick = () => {
    let frame = silence
    if (queue.length) [frame, queue, last] = [queue.subarray(0, FRAME), queue.subarray(FRAME), performance.now()]
    else drained.splice(0).forEach((f) => f())
    voice.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 0, sequenceNumber: seq, timestamp: ts, marker: n === 0 }), frame))
    ;[seq, ts] = [(seq + 1) & 0xffff, (ts + FRAME) >>> 0]
    let wait = t0 + ++n * 20 - performance.now()
    if (wait < -200) [t0, n, wait] = [performance.now(), 0, 20] // shortcut: after a stall over 200 ms, drop the backlog instead of bursting
    timer = setTimeout(tick, wait)
  }
  return {
    start: () => ((t0 = performance.now()), tick()),
    play: (b: Buffer) => void (queue = Buffer.concat([queue, b, Buffer.alloc((FRAME - (b.length % FRAME)) % FRAME, SILENCE)])),
    idle: () => new Promise<void>((r) => (queue.length ? drained.push(r) : r())),
    lastSound: () => last,
    stop: () => clearTimeout(timer),
  }
}

// The phone's µ-law frames go to Flux as they come, 80 ms at a time.
// shortcut: no jitter buffer or loss concealment; a lost or late frame is a 20 ms gap Flux tolerates.
function listen(pc: RTCPeerConnection, send: (b: Buffer<ArrayBuffer>) => void) {
  let batch: Buffer[] = []
  let size = 0
  pc.onTrack.subscribe((t) => {
    if (t.kind !== 'audio') return
    t.onReceiveRtp.subscribe(({ payload }) => {
      batch.push(payload)
      size += payload.length
      if (size < 640) return
      send(Buffer.concat(batch))
      batch = []
      size = 0
    })
  })
}

// --- the call ---

// Picked up: connect, say who it is, read the question, take a yes or no. Never throws.
export async function converse(c: Converse): Promise<Outcome> {
  const t0 = performance.now()
  const since = () => Math.round(performance.now() - t0)
  const out: Outcome = { result: 'failed', stage: 'start', heard: [] }
  let decided = false // our own answer settles the ask: that mustn't cut off the goodbye
  // Everything that ends the call rejects `stop`: 'hung up' | 'answered' | 'timeout', or the Error that broke it.
  let fail!: (why: unknown) => void
  const stop = new Promise<never>((_, no) => (fail = no))
  stop.catch(() => {})
  const within = <T>(p: Promise<T>) => Promise.race([p, stop])
  c.ended.then(() => fail('hung up'))
  c.settled.then(() => decided || fail('answered'), () => fail('answered'))
  const cap = setTimeout(() => fail('timeout'), CALL_MS)
  let gate: NodeJS.Timeout | undefined
  let peer: ReturnType<typeof answerOnly> | undefined
  let mouth: ReturnType<typeof speaker> | undefined
  let ears: ReturnType<typeof flux> | undefined
  const onSignal = (x: { id: string; data: Signal }) => void (x.id === c.id && peer?.onSignal(x.data))
  let hearing = false // the owner's audio reaches Flux only once the disclosure has played
  let started = 0 // when the turn being taken started; 0 if none is
  let waiting: ((t: string) => void) | undefined // set only while hear() runs: a turn is taken only then
  const onTurn = (m: { event: string; transcript: string }) => {
    if (m.event === 'StartOfTurn') started = waiting && performance.now() - mouth!.lastSound() > OVER_MS ? performance.now() : 0
    if (m.event !== 'EndOfTurn') return
    out.heard.push({ text: m.transcript, taken: !!started })
    if (started) waiting?.(m.transcript)
    started = 0
  }
  // Waits `ms` for a taken turn to start, then up to TURN_MS for it to end; '' if none started. A turn that never ends
  // reads as unclear, so a yes held before it isn't taken, and neither is its late end.
  const hear = (ms: number) =>
    new Promise<string>((resolve) => {
      const done = (t: string) => (clearTimeout(timer), (waiting = undefined), resolve(t))
      waiting = done
      let timer = setTimeout(() => (started ? (timer = setTimeout(() => ((started = 0), done('(cut off)')), TURN_MS)) : done('')), ms)
    })
  const say = async (text: string) => (mouth!.play(await tts(c.key, text)), await mouth!.idle())
  try {
    // All inside try: a throw here must still close what was opened, and converse never throws.
    peer = answerOnly((data) => c.s.emit('call:signal', { id: c.id, data }))
    c.signals.forEach(onSignal)
    c.s.on('call:signal', onSignal)
    mouth = speaker(peer.voice)
    listen(peer.pc, (b) => hearing && ears!.send(b))
    gate = setTimeout(() => fail(new Error(`no connection in 15 s${peer!.error() ? `: ${peer!.error()}` : ''}`)), CONNECT_MS)
    const quest = tts(c.key, prompt(c))
    quest.catch(() => {}) // awaited at the gate
    const hi = await within(tts(c.key, hello(c.name))) // first: a bad key fails on Aura's readable 401
    ears = flux(c.key, onTurn, fail)
    const [asked] = await within(Promise.all([quest, ears.open, peer.connected.then(() => (out.connectMs = since()))]))
    clearTimeout(gate)
    c.live()
    mouth.start()
    await within(sleep(LEAD_MS))
    mouth.play(hi)
    out.stage = 'call' // from the disclosure on: a failure before it hangs up without a word
    out.speakMs = since()
    await within(mouth.idle())
    hearing = true // disclosure said: from here the owner's audio goes to Deepgram
    mouth.play(asked)
    await within(mouth.idle())
    let strikes = 0
    let saidYes = false
    for (;;) {
      let t = await within(hear(c.digits ? CODE_MS : LISTEN_MS))
      // A yes or part of the code can go on in a next turn ("Yes." then "no, wait"; "482" then "913"): a turn that
      // starts within HOLD_MS joins it. A no settles at once: nothing said after it can undo it.
      for (let more; t && verdict(t, c.digits, saidYes) !== 'no' && (more = await within(hear(HOLD_MS))); ) t += ` ${more}`
      const v = verdict(t, c.digits, saidYes)
      if (v === 'yes' || v === 'no') {
        decided = true
        c.answer(v)
        await within(say(v === 'yes' ? YES : NO)).catch(() => {}) // settled already: a cut goodbye changes nothing
        return { ...out, result: v, stage: undefined }
      }
      const first = v === 'need code' && !saidYes
      if (v === 'need code' || v === 'wrong code') saidYes = true
      if (first) {
        await within(say(NEED_CODE))
        continue
      }
      if (++strikes >= 2) return (await within(say(GIVE_UP)), { ...out, result: 'gave up', stage: undefined })
      await within(say(v === 'wrong code' ? WRONG_CODE : saidYes ? NEED_CODE : c.digits ? AGAIN_HIGH : AGAIN))
    }
  } catch (e) {
    if (typeof e === 'string') out.result = e as Outcome['result'] // 'hung up' | 'answered' | 'timeout': no speech
    else {
      out.error = (e as Error).message.replaceAll(c.key, '…') // deepgramKey() already refuses keys an error would echo
      if (out.stage === 'call') await Promise.race([say(GIVE_UP), sleep(5000)]).catch(() => {})
    }
  } finally {
    clearTimeout(cap)
    clearTimeout(gate)
    mouth?.stop()
    ears?.close()
    peer?.pc.close().catch(() => {}) // async; an unhandled rejection would kill the process and print on stderr
    c.s.off('call:signal', onSignal)
  }
  return out
}
