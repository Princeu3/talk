import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { SESSION_SECRET } from './db.ts'

const COOKIE = 'talk_session'
const YEAR = 365 * 24 * 3600 * 1000

// The client sends a 32-byte key it derived from the passphrase (never the
// passphrase itself, and never the half used for encryption). We store its hash.
export const hashAuth = (auth: string) => createHash('sha256').update(auth).digest('hex')

export function authMatches(auth: string, storedHash: string): boolean {
  const a = Buffer.from(hashAuth(auth), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

const sign = (v: string) => createHmac('sha256', SESSION_SECRET).update(v).digest('base64url')

export function setSession(res: Response, userId: string) {
  const v = `${userId}.${Date.now() + YEAR}`
  res.cookie(COOKIE, `${v}.${sign(v)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: YEAR,
  })
}

export const clearSession = (res: Response) => res.clearCookie(COOKIE)

// Returns the user id from a raw Cookie header, or null.
export function userFromCookie(header: string | undefined): string | null {
  const raw = header?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
  if (!raw) return null
  const [id, exp, sig] = decodeURIComponent(raw).split('.')
  if (!id || !exp || !sig) return null
  const want = Buffer.from(sign(`${id}.${exp}`))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  return Number(exp) > Date.now() ? id : null
}

declare module 'express-serve-static-core' {
  interface Request {
    userId: string
  }
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const id = userFromCookie(req.headers.cookie)
  if (!id) return void res.status(401).json({ error: 'signed out' })
  req.userId = id
  next()
}

// Global throttle counting failures only: Railway's proxy rotates client IPs,
// so per-IP limits don't hold. While tripped, every login waits (even a correct
// one), otherwise a guesser could still tell right answers from wrong ones.
const fails: number[] = []
export function throttled(): boolean {
  const cutoff = Date.now() - 60_000
  while (fails.length && fails[0] < cutoff) fails.shift()
  return fails.length >= 10
}
export const recordFail = () => fails.push(Date.now())
