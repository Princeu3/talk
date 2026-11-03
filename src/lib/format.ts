import type { CallKind, CallLog, Conversation, Me, MessageBody } from '../../shared/types.ts'

export const userName = (me: Me, id: string) => me.users.find((u) => u.id === id)?.name ?? 'Someone'
export const who = (me: Me, id: string) => (id === me.user.id ? 'You' : userName(me, id))

export const convName = (me: Me, conv: Conversation) =>
  conv.title ?? userName(me, conv.members.find((m) => m !== me.user.id) ?? me.user.id)

const and = new Intl.ListFormat('en', { type: 'conjunction' })
export const names = (list: string[]) => and.format(list)

// "typing…" in a DM; who, in a group (two names at most).
export function typingLabel(me: Me, conv: Conversation, ids: string[]) {
  if (conv.kind === 'dm') return 'typing…'
  if (ids.length > 2) return `${ids.length} people are typing…`
  return `${names(ids.map((id) => userName(me, id)))} ${ids.length > 1 ? 'are' : 'is'} typing…`
}

export const initials = (name: string) =>
  name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')

export function shortTime(ts: number) {
  const d = new Date(ts)
  const days = (Date.now() - ts) / 86_400_000
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (days < 6) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export const dayLabel = (ts: number) =>
  new Date(ts).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })

export function talkTime(ms: number) {
  const m = Math.round(ms / 60_000)
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} sec`
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`
}

// An old log with no kind was a video call.
export const callNoun = (kind: CallKind | undefined, group?: boolean) =>
  group ? `Group ${kind === 'audio' ? 'voice' : 'video'} call` : kind === 'audio' ? 'Voice call' : 'Video call'

// A missed call reads differently to the caller ("No answer") and the callee.
export function callSummary(c: CallLog, mine: boolean) {
  if (c.room) return { title: 'Call', detail: 'Ended', missed: false }
  const noun = callNoun(c.kind, c.group)
  if (c.ms) return { title: noun, detail: talkTime(c.ms), missed: false }
  return mine ? { title: noun, detail: 'No answer', missed: false } : { title: `Missed ${noun.toLowerCase()}`, missed: true }
}

export function preview(body: MessageBody | null | undefined, mine = false) {
  if (!body) return ''
  if (body.call) {
    const { title, detail } = callSummary(body.call, mine)
    return detail ? `${title} · ${detail}` : title
  }
  if (body.text) return body.text
  const files = body.files ?? []
  if (!files.length) return ''
  if (files[0].voice) return 'Voice message'
  const kind = files.every((f) => f.type.startsWith('image/')) ? 'Photo' : files.every((f) => f.type.startsWith('video/')) ? 'Video' : null
  if (kind) return files.length === 1 ? kind : `${files.length} ${kind.toLowerCase()}s`
  return files.length === 1 ? files[0].name : `${files.length} files`
}

// Search text that ignores case and accents: "Café" finds "cafe" and back.
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

// The line of `text` holding the folded query `q`, starting near the match: [before, match, after].
// Folds one character at a time to remember where each folded character came from.
export function snippet(text: string, q: string): [string, string, string] | null {
  let folded = ''
  const start: number[] = []
  const end: number[] = []
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!)
    const f = fold(ch)
    folded += f
    for (let k = 0; k < f.length; k++) start.push(i), end.push(i + ch.length)
    i += ch.length
  }
  const k = q ? folded.indexOf(q) : -1
  if (k < 0) return null
  const s = start[k]
  let e = end[k + q.length - 1]
  while (/\p{M}/u.test(text[e] ?? '')) e++ // a decomposed accent stays with its letter
  const line = text.lastIndexOf('\n', s - 1) + 1
  const stop = text.indexOf('\n', e)
  const from = Math.max(line, s - 30)
  return [(from > line ? '…' : '') + text.slice(from, s), text.slice(s, e), text.slice(e, stop < 0 ? undefined : stop)]
}

export const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g

export const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export const fileSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`
