// Yes/no questions over Talk: a one-time code, the answer rules, expiry and the
// urgent ring. Only the owner's own account can answer (`gate` in talk.ts).
import { randomInt } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { openMessage } from '../src/lib/crypto.ts'
import type { Me, ReactionBody } from '../shared/types.ts'
import { api, connect, deepgramKey, dmKey, edit, file, gate, history, hhmm, log, react, read, send, type Paired } from './talk.ts'
import type { Outcome, Signal } from './voice.ts' // erased: werift isn't loaded here

export type Verdict = 'yes' | 'no' | 'expired' | 'keyboard' | 'cancelled'

export interface AskOptions {
  question: string
  detail?: string
  risk: 'low' | 'high'
  urgent: boolean
  ringAfter: number // seconds
  expires: number // minutes, under 15: closing the ask edits it, and Talk allows edits for 15 minutes
  source: 'cli' | 'permission' | 'mcp'
  code?: string // from claim(); else the ask claims its own
  waits?: boolean // a permission ask in an attended session: no answer leaves the prompt at the Mac
  atMac?: (sentAt: number) => boolean // polled every 2 s; true hands the question back to the terminal
  posted?: (id: number) => void // each message the ask stores: the ask, any re-post, and its reminders
}

interface Answer {
  verdict: Verdict
  via?: 'typed' | 'swipe' | 'reaction' | 'voice'
  id?: number // the answering message
  note?: string // what followed the code of a typed no
  at: number
}

const TYPED = /^\s*(yes|no)[\s,.:;!-]+([a-km-z]{5})\b[\s,.:;!-]*(.*)$/is // "yes kxqzm", "Yes, kxqzm.", "no kxqzm use staging"
// What follows the code. "yes kxqzm 👍" has no note; "yes kxqzm?" has one.
const noteOf = (rest: string) => (/[\p{L}\p{N}?]/u.test(rest) ? rest.trim() : '')
// A typed answer, its word and code in lower case, or null. The ask and the Stop hook both read answers through this.
export const typed = (text: string) => {
  const t = TYPED.exec(text)
  return t && { word: t[1].toLowerCase() as 'yes' | 'no', code: t[2].toLowerCase(), note: noteOf(t[3]) }
}
// A whole-message yes or no with no code. It answers only as a swipe-reply; otherwise it gets ❓ and a reminder.
export const PLAIN = /^\s*(?:(y|yes|yep|yeah|yup|ok|okay|sure|approve|approved|👍[\u{1F3FB}-\u{1F3FF}]?)|n|no|nope|nah|deny|denied|👎[\u{1F3FB}-\u{1F3FF}]?)\u{FE0F}?[\s.!]*$/iu
// TALKLINE_PLAIN=chat (the OpenClaw child): an unswiped plain word is chat, as on Telegram, not a stray answer.
export const CHAT = process.env.TALKLINE_PLAIN === 'chat'

// One per open ask, for the signal handler in cli.ts: each closes its ask before the process exits.
export const cancels = new Set<() => void>()

// Every ask record, a line each: "<id> <code>", id 0 for the code before the ask is stored, then the ask, its
// re-posts, its reminders and the answer it took. Never pruned, so a code never repeats in this chat: an old
// "yes <code>" the server sends again can't answer a new ask. The router keeps answers to asks from Claude
// by them, however long it waits to read. "0 <code> relay" tags a relay code, "-1 <code>" marks a closed
// ask, and "-2 <code>" a "Too late" reply sent; Phase 1 reads those as ids no message has.
// shortcut: the asks file grows forever (about 30 bytes an ask) and each run reads it whole; pair can reset it if it gets big.
const ASKS = file('asks')
const records = () => (existsSync(ASKS) ? readFileSync(ASKS, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')) : [])
export function asked() {
  const r = records()
  const codes = new Map<string, number[]>() // each code's ids: its ask, re-posts, reminders, the answer it took, and -1 or -2
  for (const [id, code] of r) codes.set(code, [...(codes.get(code) ?? []), Number(id)])
  return { ids: new Set(r.map(([id]) => Number(id))), codes, relay: new Set(r.filter((x) => x[2] === 'relay').map((x) => x[1])) }
}
export const record = (id: number, code: string, tag = '') => appendFileSync(ASKS, `${id} ${code}${tag && ` ${tag}`}\n`, { mode: 0o600 })

// 5 letters, a-z without l, never one this chat has had.
export function newCode() {
  const used = asked().codes
  for (;;) {
    const code = Array.from({ length: 5 }, () => 'abcdefghijkmnopqrstuvwxyz'[randomInt(25)]).join('')
    if (!used.has(code)) return code
  }
}
// A new code, recorded with no await in between, so two asks in one process can't draw the same one. A relay asks
// for Claude Code's request_id, which it gets unless this chat has had it; its record is tagged.
export function claim(want = '', tag = '') {
  const code = /^[a-km-z]{5}$/.test(want) && !asked().codes.has(want) ? want : newCode()
  record(0, code, tag)
  return code
}

// `id` is the answering message, if one answered, and `at` when the ask settled.
export async function ask(p: Paired, o: AskOptions): Promise<{ verdict: Verdict; note?: string; id?: number; at: number }> {
  const key = await dmKey(p)
  let answer: Answer | undefined
  let done!: (a: Answer) => void
  let died!: (e: Error) => void
  // The first answer, or a rejection once Talk refuses the session for good: then no answer can come.
  const settled = new Promise<Answer>((resolve, reject) => ((done = resolve), (died = reject)))
  settled.catch(() => {}) // a refusal can come before anything awaits it
  const s = await connect(p, died)
  const code = o.code ?? claim() // recorded before the send: the owner may answer before Talk's ack comes back
  const sentAt = Date.now()
  const expiresAt = sentAt + o.expires * 60_000
  const closed = (status: string) => `${o.question}\n${status}${o.detail ? `\n\n${o.detail}` : ''}`
  const text = closed(`Reply yes ${code} or no ${code} by ${hhmm(expiresAt)}${o.risk === 'low' ? ', or tap 👍' : ''}`)
  // `ask` gives the web its Approve and Deny buttons; `text` still holds the whole ask for older apps. Closing edits drop it.
  // shortcut: an urgent ask goes time-sensitive at once, not message, then time-sensitive, then one ring; split those steps once a build can show Time Sensitive.
  const asking = () => send(s, p, key, { text, ask: { code, expires: expiresAt } }, o.urgent ? { level: 'time-sensitive' } : {})
  const askIds: number[] = [] // the ask message, then any re-post after a ring
  let rang = false
  let call: string | undefined
  let up = 0 // when the owner picked up a voice call: voiced() ends and logs it
  let talking: Promise<unknown> = Promise.resolve()
  // A voice call's signals and end, caught from the ask's start and outside the queue: the offer can beat `accepted`
  // through the queue, and a hang-up can land before converse listens.
  // shortcut: signals kept until the ask closes (a few dozen a call); drop them per call if an ask ever rings twice.
  const signals: { id: string; data: Signal }[] = []
  let gone!: () => void
  const hungUp = new Promise<void>((r) => (gone = r))

  const settle = (verdict: Verdict, via?: Answer['via'], id?: number, note?: string) => {
    if (answer) return // the first answer wins
    done((answer = { verdict, via, id, note, at: Date.now() }))
    if (id) record(id, code) // the answer it took: the router keeps it, note and all, from Claude
    record(-1, code) // closed: a later typed answer gets ⏳
  }
  const cancel = () => settle('cancelled')
  cancels.add(cancel)

  // One path for every answer: re-read the chat since the ask, so edits, reactions and whatever came
  // while the socket was down count alike. Runs one at a time; the first answer in message order wins.
  // A reaction carries no time, so a 👍 counts only when no message answers.
  const catchUp = async () => {
    if (answer || !askIds.length) return
    const ms = await history(p, askIds[0] - 1)
    for (const m of ms) {
      const body = await gate(p, key, m)
      if (!body || body.forwarded) continue // someone else wrote it, so it answers nothing
      const said = String(body.text ?? '')
      const t = typed(said)
      if (t?.code === code) {
        // A yes can't carry a note: an allow or an exit code would drop it, and with it any condition ("but not on prod").
        if (!t.note || t.word === 'no') return settle(t.word, 'typed', m.id, t.note)
        puzzled(m.id, 'note', `Not taken: a yes can't carry a note. Reply yes ${code} alone, or no ${code} and your note`)
        continue
      }
      const plain = PLAIN.exec(said)
      if (!plain) continue
      const word = plain[1] ? 'yes' : 'no'
      const at = Number(body.reply?.id)
      // Only a swipe at the question answers, or a swiped no at a reminder: a yes, ok or 👍 there may mean "got it".
      if (!(askIds.includes(at) || (word === 'no' && replies.includes(at)))) {
        const how = `To say ${word}, reply ${word} ${code}${word === 'yes' && o.risk === 'low' ? ' or tap 👍 on the question' : ''}`
        if ((!body.reply && !CHAT) || replies.includes(at)) puzzled(m.id, word, how)
        continue // otherwise a swipe-reply to another message
      }
      if (word === 'no' || o.risk === 'low') return settle(word, 'swipe', m.id) // a deny is always safe
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
  const replies: number[] = [] // reminders: quiet replies to the ask. A swiped no at one counts as at the ask; a yes or 👍 only on the question.
  const told = new Set<string>() // one reminder of each kind per ask
  const remind = (kind: string, text: string) => {
    if (told.has(kind)) return
    told.add(kind)
    queue(() => under(text).then((m) => replies.push(m.id))) // queued, so the close waits for it
  }
  // A quiet reply under the ask. Its id goes in `asks`, so the Stop hook keeps a swipe at it from Claude.
  const under = (text: string) =>
    send(s, p, key, { text, reply: { id: askIds.at(-1)!, from: p.agent.id, preview: o.question.slice(0, 200) } }, { quiet: true })
      .then((m) => (record(m.id, code), o.posted?.(m.id), m))
  // A high-risk ask needs the code. Say so once when the owner swipes yes or taps 👍.
  const hint = () => remind('yes', `This one needs the code: reply yes ${code}`)
  const marked = new Set<number>()
  // An answer this ask can't take: ❓ on it once, and a reminder of the form that works.
  const puzzled = (id: number, kind: string, text: string) => {
    if (!marked.has(id)) (marked.add(id), queue(() => react(p, key, id, '❓')))
    remind(kind, text)
  }
  const ring = async () => {
    // Talk enforces a helper's ring hours where its owner is. shortcut: a Phase 0 profile (a cookie)
    // keeps this Mac's 08–22 for permission asks; re-pairing moves it to the server's rules.
    const hour = new Date().getHours()
    if (!p.token && o.source === 'permission' && (hour < 8 || hour >= 22)) return
    // Read already? Asked now, so reads made while the socket was down count too.
    const me = await api<Me>(p, 'GET', '/api/me').catch(() => null)
    if (answer) return
    if (!me) return log('ring', { result: 'error', error: 'read state unknown' }) // it rings only for an unread question
    if ((me.conversations.find((c) => c.id === p.dm.id)?.reads?.[p.owner.id] ?? 0) >= askIds.at(-1)!) return
    rang = true
    // `ask` names the question the ring is for: Talk rings once per ask.
    const r = await s.timeout(10_000).emitWithAck('call:start', { convId: p.dm.id, kind: 'audio', ask: askIds.at(-1) }).catch(() => ({ error: 'timeout' }))
    if (r.error) return log('ring', { result: 'error', error: r.error })
    call = r.id
  }
  // The call log the apps show once a ring is over; ms 0 reads as "No answer".
  const callLog = async (ms: number) => {
    if (!call) return
    call = undefined
    await send(s, p, key, { call: { kind: 'audio', ms } }, { quiet: true, seen: ms > 0 }).catch(() => {})
  }
  // The question again below the call, the old one pointing to it.
  const below = async () => {
    if (answer) return
    post((await asking()).id)
    await edit(p, key, askIds.at(-2)!, `${o.question}\nSent again below`)
  }
  // The owner picked up. With a Deepgram key, talkline talks (voice.ts); without one, it hangs up and posts the
  // question again below the call. With no id yet, the call:start ack came too late or got lost; the id is still
  // ours: Talk sends call:accepted only to the caller.
  const accepted = async (id: string) => {
    if (id !== call && (!rang || call)) return
    call = id
    log('ring', { result: 'accepted' })
    const dg = !answer && deepgramKey()
    // Outside `work`: a live call outlasts the close's 10 s wait. voiced() ends and logs the call itself.
    if (dg) return void ((up = Date.now()), (talking = voiced(id, dg).catch((e: Error) => log('voice', { result: 'failed', error: e.message }))))
    s.emit('call:hangup', { id })
    await callLog(1) // any ms > 0 reads as answered; we hang up at once
    await below()
  }
  const voiced = async (id: string, dg: string) => {
    // The digits make the owner open the chat: on high risk, and whenever there is a detail the call never reads out.
    const digits = o.risk === 'high' || o.detail ? String(randomInt(1_000_000)).padStart(6, '0') : undefined
    const r: Outcome = await import('./voice.ts')
      .then((v) =>
        v.converse({
          s, id, signals, ended: hungUp, key: dg, name: p.agent.name, question: o.question, detail: !!o.detail, digits, settled,
          live: () => void (digits && remind('voice', `Voice code for this call: ${digits.slice(0, 3)} ${digits.slice(3)}. Say yes and these six digits to approve.`)),
          answer: (v) => settle(v, 'voice'),
        }),
      )
      .catch((e: Error): Outcome => ({ result: 'failed', stage: 'start', error: `voice did not load: ${e.message}`, heard: [] }))
    s.emit('call:hangup', { id })
    log('voice', { result: r.result, stage: r.stage, error: r.error, connectMs: r.connectMs, speakMs: r.speakMs, ms: Date.now() - up, turns: r.heard.length })
    await callLog(Date.now() - up) // clears `call`, so the close won't log it twice
    const heard = r.heard.slice(0, 6).map((h) => `“${h.text.slice(0, 200)}”${h.taken ? '' : ' (said over me, not taken)'}`).join(', ')
    if (r.speakMs !== undefined) await under(`On the call I heard: ${heard || 'nothing'}.`).catch(() => {})
    await below().catch(() => {})
  }
  const ended = async (id: string, reason: string) => {
    if (id !== call || up) return // a voice call ends and logs itself
    log('ring', { result: reason })
    await callLog(0)
  }

  // Listen before sending, so no answer slips past. Reconnects catch up too (the first connect came before this).
  // Talk echoes the agent's own sends, edits and reactions back to it; none can be an answer, so they read nothing.
  for (const ev of ['message', 'edit', 'reaction']) s.on(ev, (x?: { senderId?: string; userId?: string }) => (x?.senderId ?? x?.userId) !== p.agent.id && check())
  s.on('connect', check)
  s.on('call:accepted', (c: { id: string }) => queue(() => accepted(c.id)))
  s.on('call:end', (c: { id: string; reason: string }) => queue(() => ended(c.id, c.reason)))
  s.on('call:signal', (x: { id: string; data: Signal }) => signals.push(x))
  s.on('call:end', (x: { id: string }) => x.id === call && gone())
  // A voice call outlives a socket drop: rejoin, or Talk ends it `lost` in 30 s. Talk sends call:end only to connected
  // sockets, so the rejoin's error is how a call that ended meanwhile shows.
  s.on('connect', () => up && call && s.emit('call:rejoin', { id: call }, (r?: { error?: string }) => void (r?.error && gone())))

  const timers: NodeJS.Timeout[] = []
  try {
    const first = await asking()
    post(first.id)
    log('ask', { risk: o.risk, urgent: o.urgent, source: o.source })
    timers.push(setTimeout(() => settle('expired'), expiresAt - Date.now()))
    if (o.urgent) timers.push(setTimeout(() => queue(ring), o.ringAfter * 1000))
    if (o.atMac) timers.push(setInterval(() => o.atMac!(sentAt) && settle('keyboard'), 2000))

    const { verdict, via, id, note, at } = await settled
    cancels.delete(cancel) // a second signal exits at once
    timers.forEach(clearTimeout) // clears the interval too
    // The close waits for a ring step or a voice call (up to 10 s), so no call outlives the ask, but no longer: with
    // Talk stalled, queued reminders and ❓ could take minutes, and the permission hook must close its question within 600 s.
    // A signal leaves 1 s.
    if (verdict !== 'cancelled') await Promise.race([Promise.all([work, talking]), new Promise((r) => timers.push(setTimeout(r, 10_000)))])
    if (call) {
      s.emit('call:hangup', { id: call })
      log('ring', { result: 'cancelled' })
      await callLog(up && Date.now() - up) // an answered voice call logs its time, not "No answer"
    }
    const status =
      verdict === 'yes' ? `Approved ${hhmm(at)}`
      : verdict === 'no' ? `Denied ${hhmm(at)}`
      : verdict === 'keyboard' ? 'Back at the Mac: answer there'
      : verdict === 'cancelled' ? 'Cancelled: no answer needed'
      : o.waits ? `No answer by ${hhmm(expiresAt)}: it waits for you at the Mac`
      : o.source === 'permission' ? 'Expired, denied'
      : 'Expired'
    await Promise.all([
      edit(p, key, askIds.at(-1)!, closed(status)).catch(() => {}),
      id && react(p, key, id, verdict === 'yes' ? '✅' : '❌').catch(() => {}),
      id && read(p, id).catch(() => {}),
    ])
    log('answer', { verdict, via })
    return { verdict, note, id, at }
  } finally {
    // Talk refused the question or the session (then no answer can come), or it settled: all of it goes.
    // A posted ask Talk dropped closes too, or a failing catch-up read would retry every 2 s while the process lives.
    if (askIds.length) settle('cancelled')
    cancels.delete(cancel)
    timers.forEach(clearTimeout)
    s.close()
  }
}
