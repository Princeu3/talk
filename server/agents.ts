// Helpers (talkline): a helper is a user with owner_id set, and its owner is always a person.
// Here: when a helper may ring its owner, and how often its sends may buzz them.
import { db, mutedIds } from './db.ts'
import type { SendPayload } from '../shared/types.ts'

// users.agent, as JSON. proof and invite are kept so the owner's browser can check the pairing.
export type AgentInfo = { where: string; proof: string; invite: string }

const MIN = 60_000
const DAY = 24 * 60 * MIN

export const ownerOf = (id: string) =>
  (db.prepare('select owner_id from users where id = ?').get(id) as { owner_id: string | null } | undefined)?.owner_id ?? null
const tzOf = (id: string) => (db.prepare('select tz from users where id = ?').get(id) as { tz: string | null }).tz

export function validTz(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v })
    return true
  } catch {
    return false
  }
}

// 08:00 to 22:00 where the owner is. No zone, no rings.
export function inRingHours(tz: string | null, now: number) {
  if (!tz) return false
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now))
  return hour >= 8 && hour < 22
}

// shortcut: ring history and budgets live in memory, so a restart clears them; store them if restarts get common.
type Ring = { at: number; ask: number }
const rings = new Map<string, Ring[]>() // per owner: all their helpers' rings, last 24 h
const declines = new Map<string, number>() // caller id -> when a ring of theirs was last declined or went unanswered
const sends = new Map<string, number[]>() // per helper
const loud = new Map<string, number[]>(), urgent = new Map<string, number[]>() // per owner
// Same idea as unfurl.ts allow(), with a window and a cap.
const hit = (m: Map<string, number[]>, id: string, ms: number, max: number, now = Date.now()) => {
  const recent = (m.get(id) ?? []).filter((t) => now - t < ms)
  m.set(id, recent.length < max ? [...recent, now] : recent)
  return recent.length < max
}

export const noteDecline = (caller: string) => void declines.set(caller, Date.now())

// Checks 3 to 7 of a helper's ring; the first that fails wins. Pure, so a test can set the clock.
// declined: when this helper's last ring was declined or went unanswered. wrote: the owner's last message in this chat.
export function ringRule(r: { ask: number; tz: string | null; rings: Ring[]; declined?: number; wrote: number | null }, now: number) {
  // shortcut: the 6-a-day cap is a rolling 24 h, not a calendar day; count from the owner's midnight if owners expect that.
  const day = r.rings.filter((x) => now - x.at < DAY)
  if (day.some((x) => x.ask === r.ask)) return 'This ask already rang.'
  if (!inRingHours(r.tz, now)) return 'Outside ring hours: 08:00–22:00 where your owner is.'
  // shortcut: the decline lock lifts on the owner's next message in this chat; add an explicit unlock if owners miss that.
  if (r.declined !== undefined && r.declined > (r.wrote ?? 0)) return 'Your owner didn’t take the last ring. No more until they write to you.'
  if (day.some((x) => now - x.at < 10 * MIN)) return 'A helper rang your owner less than 10 minutes ago.'
  if (day.length >= 6) return 'Your owner’s helpers rang 6 times in the last day.'
}

// Why a helper's ring can't start, or undefined, and then the ring counts. People ring as before.
export function ringRefusal(me: string, convId: string, ask: unknown) {
  const owner = ownerOf(me)
  if (!owner) return
  if (mutedIds(convId).has(owner)) return 'Paused in Talk: no rings.'
  if (!Number.isSafeInteger(ask)) return 'Say which ask this ring is for.'
  const now = Date.now()
  const { wrote } = db.prepare('select max(created_at) as wrote from messages where conv_id = ? and sender_id = ?').get(convId, owner) as { wrote: number | null }
  const history = rings.get(owner) ?? []
  const refused = ringRule({ ask: ask as number, tz: tzOf(owner), rings: history, declined: declines.get(me), wrote }, now)
  if (!refused) rings.set(owner, [...history.filter((x) => now - x.at < DAY), { at: now, ask: ask as number }])
  return refused
}

// A helper's send: 60 a minute. Across all of an owner's helpers, at most 6 a minute buzz the owner
// and 10 an hour go time-sensitive (in ring hours only). Over a buzz cap the message still goes, quietly.
export function budget(me: string, owner: string, p: SendPayload): { error?: string; quiet?: boolean; level?: 'time-sensitive' } {
  if (!hit(sends, me, MIN, 60)) return { error: 'Slow down: a helper can send 60 messages a minute.' }
  // Only sends that would buzz count toward the cap, so quiet and paused ones don't use it up.
  const quiet = !!p.quiet || mutedIds(p.convId).has(owner) || !hit(loud, owner, MIN, 6)
  const level = !quiet && p.level === 'time-sensitive' && inRingHours(tzOf(owner), Date.now()) && hit(urgent, owner, 60 * MIN, 10) ? 'time-sensitive' : undefined
  return { quiet, level }
}
