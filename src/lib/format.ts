import type { CallLog, Conversation, Me, MessageBody } from '../../shared/types.ts'

export const userName = (me: Me, id: string) => me.users.find((u) => u.id === id)?.name ?? 'Someone'

export const convName = (me: Me, conv: Conversation) =>
  conv.title ?? userName(me, conv.members.find((m) => m !== me.user.id) ?? me.user.id)

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

// A missed call reads differently to the caller ("No answer") and the callee.
export function callSummary(c: CallLog, mine: boolean) {
  if (c.room) return { title: 'Call', detail: 'Ended', missed: false }
  const noun = c.kind === 'audio' ? 'Voice call' : 'Video call'
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

export const fileSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`
