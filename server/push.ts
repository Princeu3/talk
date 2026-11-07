import webpush from 'web-push'
import type { Server } from 'socket.io'
import { db, setting } from './db.ts'
import type { CallKind } from '../shared/types.ts'

const keys = JSON.parse(setting('VAPID_KEYS', () => JSON.stringify(webpush.generateVAPIDKeys()))) as {
  publicKey: string
  privateKey: string
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:admin@princeuniverse.dev', keys.publicKey, keys.privateKey)

export const vapidPublicKey = keys.publicKey

// The iPhone app's pushes go through the app developer's relay, which holds
// the APNs key. Empty turns them off.
const RELAY = process.env.PUSH_RELAY_URL ?? 'https://push.princeuniverse.dev'

export function saveSubscription(userId: string, sub: { endpoint: string }) {
  db.prepare('insert or replace into push_subs (endpoint, user_id, sub) values (?, ?, ?)').run(
    sub.endpoint,
    userId,
    JSON.stringify(sub),
  )
}

// What an APNs push carries: ids only. The app's notification extension
// fetches and decrypts the rest on the phone.
export type Apns =
  | { type: 'message'; convId: string; messageId: number }
  | { type: 'missed'; convId: string; callId: string; kind: CallKind }
  | { type: 'call'; convId: string; callId: string; kind: CallKind; from: string }

// Payload carries no message content: the sender name and conversation id only.
// Pushes only to someone with no visible tab or open app; those show it themselves.
// These users' sockets. An empty room list would reach every socket, so it reaches none.
export const toUsers = (io: Server, ids: string[]) => io.to(ids.length ? ids.map((u) => `user:${u}`) : 'nobody')

export async function notifyIfAway(io: Server, userId: string, payload: Payload, opts: { ttl?: number; apns?: Apns } = {}) {
  const sockets = await io.in(`user:${userId}`).fetchSockets()
  if (sockets.some((s) => s.data.active)) return
  await Promise.all([notify(userId, payload, opts.ttl), opts.apns && apns(userId, opts.apns)])
}

type Payload = { title: string; body: string; convId: string }

// ttl: seconds the push service may hold it; a ring is useless after a minute.
export async function notify(userId: string, payload: Payload, ttl = 3600) {
  const subs = db.prepare('select endpoint, sub from push_subs where user_id = ?').all(userId) as {
    endpoint: string
    sub: string
  }[]
  await Promise.all(
    subs.map(async ({ endpoint, sub }) => {
      try {
        await webpush.sendNotification(JSON.parse(sub), JSON.stringify(payload), { TTL: ttl, urgency: 'high' })
      } catch (e) {
        const { statusCode: code, body } = e as { statusCode?: number; body?: string }
        if (code !== 404 && code !== 410) console.error('[push]', code, new URL(endpoint).host, String(body ?? (e as Error).message).slice(0, 200))
        // 403: the subscription was made with another VAPID key (or our JWT is bad), so it fails on every
        // push. Drop it; an open client posts a fresh one on its next load (src/lib/push.ts).
        if (code === 403 || code === 404 || code === 410) db.prepare('delete from push_subs where endpoint = ?').run(endpoint)
      }
    }),
  )
}

// Calls go to VoIP tokens (they ring through CallKit), the rest to alert tokens.
// `v`: only phones whose app knows this push (a group call rings v2 and up).
export async function apns(userId: string, data: Apns, v = 1) {
  if (!RELAY) return
  const devices = db
    .prepare('select token, env from devices where user_id = ? and kind = ? and v >= ?')
    .all(userId, data.type === 'call' ? 'voip' : 'alert', v) as { token: string; env: string }[]
  await Promise.all(
    devices.map(async ({ token, env }) => {
      try {
        const r = await fetch(`${RELAY}/v1/push`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, env, ...data }),
        })
        if (r.status === 410) db.prepare('delete from devices where token = ?').run(token)
        else if (!r.ok) console.error('[apns]', r.status, await r.text())
      } catch (e) {
        console.error('[apns]', (e as Error).message)
      }
    }),
  )
}
