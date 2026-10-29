import { io } from 'socket.io-client'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const raw = body instanceof Uint8Array
  const r = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': raw ? 'application/octet-stream' : 'application/json' },
    body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
  })
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.arrayBuffer()
  if (!r.ok) throw new ApiError(r.status, (data as { error?: string }).error ?? `HTTP ${r.status}`)
  return data as T
}

// Connects only after sign-in; the session cookie authenticates the handshake.
export const socket = io({ autoConnect: false, transports: ['websocket'] })
