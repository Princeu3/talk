import webpush from 'web-push'
import type { Server } from 'socket.io'
import { db, setting } from './db.ts'

const keys = JSON.parse(setting('VAPID_KEYS', () => JSON.stringify(webpush.generateVAPIDKeys()))) as {
  publicKey: string
  privateKey: string
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:admin@princeuniverse.dev', keys.publicKey, keys.privateKey)

export const vapidPublicKey = keys.publicKey

export function saveSubscription(userId: string, sub: { endpoint: string }) {
  db.prepare('insert or replace into push_subs (endpoint, user_id, sub) values (?, ?, ?)').run(
    sub.endpoint,
    userId,
    JSON.stringify(sub),
  )
}

// Payload carries no message content: the sender name and conversation id only.
// Pushes only to someone with no visible tab; the open app shows it itself.
export async function notifyIfAway(io: Server, userId: string, payload: Payload, ttl?: number) {
  const sockets = await io.in(`user:${userId}`).fetchSockets()
  if (!sockets.some((s) => s.data.active)) await notify(userId, payload, ttl)
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
        const code = (e as { statusCode?: number }).statusCode
        if (code === 404 || code === 410) db.prepare('delete from push_subs where endpoint = ?').run(endpoint)
        else console.error('[push]', code, (e as Error).message)
      }
    }),
  )
}
