// Yes/no questions over Talk: a one-time code, the answer rules, expiry and the
// urgent ring. Only the owner's own account can answer (`gate` in talk.ts).
import { openMessage } from '../src/lib/crypto.ts'
import type { Me, Message, ReactionBody } from '../shared/types.ts'
import { api, connect, dmKey, edit, gate, history, hhmm, log, react, read, send, type Paired } from './talk.ts'

export type Verdict = 'yes' | 'no' | 'expired' | 'keyboard' | 'cancelled'

export interface AskOptions {
  question: string
  detail?: string
  risk: 'low' | 'high'
  urgent: boolean
  ringAfter: number // seconds
  expires: number // minutes, under 15: closing the ask edits it, and Talk allows edits for 15 minutes
  source: 'cli' | 'permission'
  atMac?: (sentAt: number) => boolean // polled every 2 s; true hands the question back to the terminal
  posted?: (id: number) => void // each ask message once stored: the first, then any re-post
}

interface Answer {
  verdict: Verdict
  via: 'typed' | 'swipe' | 'reaction' | 'expired' | 'keyboard' | 'signal'
  id?: number // the answering message
  at: number
}

export const TYPED = /^\s*(yes|no)\s+([a-km-z]{5})[\s.!]*$/i // "yes kxqzm"
export const BARE = /^\s*(yes|no)[\s.!]*$/i // a swipe-reply
export const ASKED = /^Reply yes [a-km-z]{5} or no [a-km-z]{5} by /m // the line every ask carries

// Set while an ask is open, for the signal handler in cli.ts: it closes the ask before the process exits.
export let cancel: (() => void) | undefined

// 5 letters, a-z without l. Bytes of 250 and up are dropped so every letter is equally likely.
export function newCode() {
  let code = ''
  while (code.length < 5) {
    const [b] = crypto.getRandomValues(new Uint8Array(1))
    if (b < 250) code += 'abcdefghijkmnopqrstuvwxyz'[b % 25]
  }
  return code
}

export async function ask(p: Paired, o: AskOptions): Promise<Verdict> {
  const key = await dmKey(p)
  let died = (_: Error) => {}
  const dead = new Promise<never>((_, reject) => (died = reject)) // Talk refused the session for good: no answer can come
  dead.catch(() => {})
  const s = await connect(p, (e) => died(e))
  const from = p.agent.id
  const code = newCode()
  const sentAt = Date.now()
  const expiresAt = sentAt + o.expires * 60_000
  const text = [o.question, `Reply yes ${code} or no ${code} by ${hhmm(expiresAt)}${o.risk === 'low' ? ', or tap 👍' : ''}`, o.detail]
    .filter(Boolean)
    .join('\n')
  const closed = (status: string) => [o.question, status, o.detail].filter(Boolean).join('\n')
  const askIds: number[] = [] // the ask message, then any re-post after a ring
  const seen = new Set<number>()
  let ownerRead = o.urgent ? ((await api<Me>(p, 'GET', '/api/me')).conversations.find((c) => c.id === p.dm.id)?.reads?.[p.owner.id] ?? 0) : 0
  let hinted = false
  let rang = false
  let call: string | undefined

  let answer: Answer | undefined
  let done = (_: Answer) => {}
  const settled = new Promise<Answer>((r) => (done = r))
  const settle = (verdict: Verdict, via: Answer['via'], id?: number) => {
    if (answer) return // the first answer wins
    answer = { verdict, via, id, at: Date.now() }
    done(answer)
  }
  cancel = () => settle('cancelled', 'signal')
  const post = (id: number) => {
    askIds.push(id)
    o.posted?.(id)
  }
  // A high-risk ask needs the code. Say so once when the owner swipes yes or taps 👍.
  const hint = () => {
    if (hinted) return
    hinted = true
    send(s, p, key, { from, text: `This one needs the code: reply yes ${code}` }, { quiet: true }).catch(() => {})
  }

  const onMessage = async (m: Message) => {
    await stored // an answer can come in the same socket read as the ask's ack: learn the ask's id first
    if (answer || !askIds.length || m.id <= askIds[0] || seen.has(m.id)) return
    seen.add(m.id)
    const body = await gate(p, key, m)
    if (!body) return
    const said = String(body.text ?? '')
    const typed = TYPED.exec(said)
    if (typed && typed[2].toLowerCase() === code) return settle(typed[1].toLowerCase() as Verdict, 'typed', m.id)
    const bare = BARE.exec(said)?.[1].toLowerCase()
    if (!bare || !askIds.includes(Number(body.reply?.id))) return
    if (bare === 'no' || o.risk === 'low') settle(bare as Verdict, 'swipe', m.id) // a deny is always safe
    else hint()
  }
  const onReaction = async (r: { messageId: number; convId: string; userId: string; body: string | null }) => {
    await stored
    if (answer || r.convId !== p.dm.id || r.userId !== p.owner.id || !askIds.includes(r.messageId) || !r.body) return
    const rb = await openMessage<ReactionBody>(key, r.convId, r.body).catch(() => null)
    if (rb?.from !== p.owner.id || rb.to !== r.messageId || String(rb.emoji).codePointAt(0) !== 0x1f44d) return
    if (o.risk === 'low') settle('yes', 'reaction')
    else hint()
  }
  // Reaction events aren't replayed after a reconnect: re-read history, reactions included.
  const catchUp = async () => {
    for (const m of await history(p, askIds[0] - 1).catch(() => [])) {
      if (m.editedAt) seen.delete(m.id) // maybe edited into an answer while we were away
      await onMessage(m)
      if (askIds.includes(m.id)) for (const r of m.reactions ?? []) await onReaction({ ...r, messageId: m.id, convId: m.convId })
    }
  }

  // Ring steps run one at a time and the close waits for them, so no call outlives the ask.
  let work: Promise<unknown> = Promise.resolve()
  const queue = (f: () => Promise<unknown>) => void (work = work.then(f).catch(() => {}))
  const ring = async () => {
    // shortcut: ring hours for permission asks live here; Phase 1 moves ring caps to the server.
    const hour = new Date().getHours()
    if (answer || rang || ownerRead >= askIds.at(-1)! || (o.source === 'permission' && (hour < 8 || hour >= 22))) return
    rang = true
    const r = await s.timeout(10_000).emitWithAck('call:start', { convId: p.dm.id, kind: 'audio' }).catch(() => ({ error: 'timeout' }))
    if (r.error) return log('ring', { result: 'error', error: r.error })
    call = r.id
  }
  // The call log the apps show once a ring is over; ms 0 reads as "No answer".
  const callLog = async (ms: number) => {
    if (!call) return
    call = undefined
    await send(s, p, key, { from, call: { kind: 'audio', ms } }, { quiet: true, seen: ms > 0 }).catch(() => {})
  }
  // The owner picked up: hang up and post the question again below the call. With no id yet, the
  // call:start ack came too late or got lost; the id is still ours: Talk sends call:accepted only to the caller.
  const accepted = async (id: string) => {
    if (id !== call && (!rang || call)) return
    call = id
    s.emit('call:hangup', { id })
    log('ring', { result: 'accepted' })
    await callLog(1) // any ms > 0 reads as answered; we hang up at once
    if (answer) return
    post((await send(s, p, key, { from, text })).id)
    await edit(p, key, askIds.at(-2)!, closed('Sent again below'))
  }
  const ended = async (id: string, reason: string) => {
    if (id !== call) return
    log('ring', { result: reason })
    await callLog(0)
  }

  // Listen before sending, so no answer slips past. An answer fixed with Edit counts too.
  s.on('message', onMessage)
  s.on('edit', (m: Message) => {
    seen.delete(m.id)
    void onMessage(m)
  })
  s.on('reaction', onReaction)
  s.on('read', (r: { convId: string; userId: string; upTo: number }) => {
    if (r.convId === p.dm.id && r.userId === p.owner.id) ownerRead = Math.max(ownerRead, r.upTo)
  })
  s.on('call:accepted', (c: { id: string }) => queue(() => accepted(c.id)))
  s.on('call:end', (c: { id: string; reason: string }) => queue(() => ended(c.id, c.reason)))

  const sending = send(s, p, key, { from, text })
  const stored = sending.then((m) => post(m.id), () => {}) // runs before any other wait on `sending`
  // Catch up on every reconnect (the first connect came before this), once the ask is stored.
  s.on('connect', () => void sending.then(catchUp, () => {}))
  await sending
  log('ask', { risk: o.risk, urgent: o.urgent, source: o.source })
  const timers = [setTimeout(() => settle('expired', 'expired'), expiresAt - Date.now())]
  if (o.urgent) timers.push(setTimeout(() => queue(ring), o.ringAfter * 1000))
  if (o.atMac) timers.push(setInterval(() => o.atMac!(sentAt) && settle('keyboard', 'keyboard'), 2000))

  const { verdict, via, id, at } = await Promise.race([settled, dead])
  cancel = undefined // a second signal exits at once
  timers.forEach(clearTimeout) // clears the interval too
  if (verdict !== 'cancelled') await work // a ring step can take 10 s; a signal leaves 1 s
  if (call) {
    s.emit('call:hangup', { id: call })
    log('ring', { result: 'cancelled' })
    await callLog(0)
  }
  const status =
    verdict === 'yes' ? `Approved ${hhmm(at)}`
    : verdict === 'no' ? `Denied ${hhmm(at)}`
    : verdict === 'keyboard' ? 'Answered at the Mac'
    : verdict === 'cancelled' ? 'Cancelled'
    : o.source === 'permission' ? 'Expired, denied'
    : 'Expired'
  await edit(p, key, askIds.at(-1)!, closed(status)).catch(() => {})
  if (id) {
    await react(p, key, id, verdict === 'yes' ? '✅' : '❌').catch(() => {})
    await read(p, id).catch(() => {})
  }
  log('answer', { verdict, via })
  s.close()
  return verdict
}
