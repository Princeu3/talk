// Yes/no questions over Talk: a one-time code, the answer rules, expiry and the
// urgent ring. Only the owner's own account can answer (`gate` in talk.ts).
import { randomInt } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { openMessage } from '../src/lib/crypto.ts'
import type { Me, ReactionBody } from '../shared/types.ts'
import { api, connect, dmKey, edit, file, gate, history, hhmm, log, react, read, send, type Paired } from './talk.ts'

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
  via?: 'typed' | 'swipe' | 'reaction'
  id?: number // the answering message
  at: number
}

export const TYPED = /^\s*(yes|no)\s+([a-km-z]{5})[\s.!]*$/i // "yes kxqzm"
export const BARE = /^\s*(yes|no)[\s.!]*$/i // a swipe-reply

// Set while an ask is open, for the signal handler in cli.ts: it closes the ask before the process exits.
export let cancel: (() => void) | undefined

// 5 letters, a-z without l.
export const newCode = () => Array.from({ length: 5 }, () => 'abcdefghijkmnopqrstuvwxyz'[randomInt(25)]).join('')

// The last 500 ask records, a line each: "<id> <code>", id 0 for the code before the ask is stored.
// The Stop hook keeps answers to asks from Claude by them, however long it waits to read.
const ASKS = file('asks')
const records = () => (existsSync(ASKS) ? readFileSync(ASKS, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')) : [])
export function asked() {
  const r = records()
  return { ids: new Set(r.map(([id]) => Number(id))), codes: new Set(r.map(([, code]) => code)) }
}
// Written aside and renamed, so a reader sees the old file or the new one, whole.
// shortcut: two asks recorded in the same instant can drop a line; lock the file if that ever bites.
function record(id: number, code: string) {
  const tmp = `${ASKS}.${process.pid}.tmp`
  writeFileSync(tmp, [...records().slice(-499), [id, code]].map((l) => l.join(' ') + '\n').join(''), { mode: 0o600 })
  renameSync(tmp, ASKS)
}

export async function ask(p: Paired, o: AskOptions): Promise<Verdict> {
  const key = await dmKey(p)
  let answer: Answer | undefined
  let done!: (a: Answer) => void
  let died!: (e: Error) => void
  // The first answer, or a rejection once Talk refuses the session for good: then no answer can come.
  const settled = new Promise<Answer>((resolve, reject) => ((done = resolve), (died = reject)))
  settled.catch(() => {}) // a refusal can come before anything awaits it
  const s = await connect(p, died)
  const code = newCode()
  record(0, code) // before the send: the owner may answer before Talk's ack comes back
  const sentAt = Date.now()
  const expiresAt = sentAt + o.expires * 60_000
  const closed = (status: string) => [o.question, status, o.detail].filter(Boolean).join('\n')
  const text = closed(`Reply yes ${code} or no ${code} by ${hhmm(expiresAt)}${o.risk === 'low' ? ', or tap 👍' : ''}`)
  const askIds: number[] = [] // the ask message, then any re-post after a ring
  let hinted = false
  let rang = false
  let call: string | undefined

  const settle = (verdict: Verdict, via?: Answer['via'], id?: number) => {
    if (!answer) done((answer = { verdict, via, id, at: Date.now() })) // the first answer wins
  }
  cancel = () => settle('cancelled')
  // A high-risk ask needs the code. Say so once when the owner swipes yes or taps 👍.
  const hint = () => {
    if (hinted) return
    hinted = true
    send(s, p, key, { text: `This one needs the code: reply yes ${code}` }, { quiet: true }).catch(() => {})
  }

  // One path for every answer: re-read the chat since the ask, so edits, reactions and whatever came
  // while the socket was down count alike. Runs one at a time; the first answer in message order wins.
  // A reaction carries no time, so a 👍 counts only when no message answers.
  const catchUp = async () => {
    if (answer || !askIds.length) return
    const ms = await history(p, askIds[0] - 1)
    for (const m of ms) {
      const body = await gate(p, key, m)
      if (!body) continue
      const said = String(body.text ?? '')
      const typed = TYPED.exec(said)
      if (typed && typed[2].toLowerCase() === code) return settle(typed[1].toLowerCase() as Verdict, 'typed', m.id)
      const bare = BARE.exec(said)?.[1].toLowerCase()
      if (!bare || !askIds.includes(Number(body.reply?.id))) continue
      if (bare === 'no' || o.risk === 'low') return settle(bare as Verdict, 'swipe', m.id) // a deny is always safe
      hint()
    }
    for (const m of ms)
      for (const r of askIds.includes(m.id) ? (m.reactions ?? []) : []) {
        const rb = r.userId === p.owner.id ? await openMessage<ReactionBody>(key, m.convId, r.body).catch(() => null) : null
        if (rb?.from !== p.owner.id || rb.to !== m.id || String(rb.emoji).codePointAt(0) !== 0x1f44d) continue
        if (o.risk === 'low') return settle('yes', 'reaction')
        hint()
      }
  }
  let checking: Promise<unknown> = Promise.resolve()
  let retry: NodeJS.Timeout | undefined
  // A failed read tries again in 2 s: no later event may come to catch the answer it missed. One retry
  // stands for every failed read, so the retries don't multiply.
  const check = (): void =>
    void (checking = checking.then(catchUp).catch(() => void (retry ??= setTimeout(() => ((retry = undefined), check()), 2000))))
  const post = (id: number) => {
    askIds.push(id)
    record(id, code)
    o.posted?.(id)
    check() // an answer can come in the same socket read as the ask's ack
  }

  // Ring steps run one at a time and the close waits for them, so no call outlives the ask.
  let work: Promise<unknown> = Promise.resolve()
  const queue = (f: () => Promise<unknown>) => void (work = work.then(f).catch(() => {}))
  const ring = async () => {
    // shortcut: ring hours for permission asks live here; Phase 1 moves ring caps to the server.
    const hour = new Date().getHours()
    if (o.source === 'permission' && (hour < 8 || hour >= 22)) return
    // Read already? Asked now, so reads made while the socket was down count too.
    const me = await api<Me>(p, 'GET', '/api/me').catch(() => null)
    if (answer) return
    if (!me) return log('ring', { result: 'error', error: 'read state unknown' }) // it rings only for an unread question
    if ((me.conversations.find((c) => c.id === p.dm.id)?.reads?.[p.owner.id] ?? 0) >= askIds.at(-1)!) return
    rang = true
    const r = await s.timeout(10_000).emitWithAck('call:start', { convId: p.dm.id, kind: 'audio' }).catch(() => ({ error: 'timeout' }))
    if (r.error) return log('ring', { result: 'error', error: r.error })
    call = r.id
  }
  // The call log the apps show once a ring is over; ms 0 reads as "No answer".
  const callLog = async (ms: number) => {
    if (!call) return
    call = undefined
    await send(s, p, key, { call: { kind: 'audio', ms } }, { quiet: true, seen: ms > 0 }).catch(() => {})
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
    post((await send(s, p, key, { text })).id)
    await edit(p, key, askIds.at(-2)!, closed('Sent again below'))
  }
  const ended = async (id: string, reason: string) => {
    if (id !== call) return
    log('ring', { result: reason })
    await callLog(0)
  }

  // Listen before sending, so no answer slips past. Reconnects catch up too (the first connect came before this).
  for (const ev of ['message', 'edit', 'reaction', 'connect']) s.on(ev, check)
  s.on('call:accepted', (c: { id: string }) => queue(() => accepted(c.id)))
  s.on('call:end', (c: { id: string; reason: string }) => queue(() => ended(c.id, c.reason)))

  post((await send(s, p, key, { text })).id)
  log('ask', { risk: o.risk, urgent: o.urgent, source: o.source })
  const timers = [setTimeout(() => settle('expired'), expiresAt - Date.now())]
  if (o.urgent) timers.push(setTimeout(() => queue(ring), o.ringAfter * 1000))
  if (o.atMac) timers.push(setInterval(() => o.atMac!(sentAt) && settle('keyboard'), 2000))

  const { verdict, via, id, at } = await settled
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
  await Promise.all([
    edit(p, key, askIds.at(-1)!, closed(status)).catch(() => {}),
    id && react(p, key, id, verdict === 'yes' ? '✅' : '❌').catch(() => {}),
    id && read(p, id).catch(() => {}),
  ])
  log('answer', { verdict, via })
  s.close()
  return verdict
}
