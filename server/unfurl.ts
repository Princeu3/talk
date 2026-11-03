// Link previews for the web app, which can't fetch other sites itself. The
// server fetches the page once for the sender and forgets it: nothing logged or
// stored beyond a short in-memory cache. The phone makes its own on the device.
//
// The fetch can't be pointed at the server's own network: every address a host
// resolves to is checked before connecting (and the socket connects to that
// checked address), redirects are checked hop by hop, and reads are capped.
import http from 'node:http'
import https from 'node:https'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import type { LinkPreview } from '../shared/types.ts'

const PAGE_MAX = 512 * 1024
const IMAGE_MAX = 1024 * 1024
const TIMEOUT_MS = 5000
const HOPS = 3

const banned = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) banned.addSubnet(net, bits, 'ipv4')
// BlockList checks IPv4-mapped addresses against the IPv4 rules itself. NAT64 and
// 6to4 addresses can carry a private IPv4 address too: refuse them all.
for (const [net, bits] of [
  ['::', 127], ['64:ff9b::', 96], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) banned.addSubnet(net, bits, 'ipv6')

export const blocked = (ip: string) => {
  const v = isIP(ip)
  return !v || banned.check(ip, v === 4 ? 'ipv4' : 'ipv6')
}

// Node asks for one address or, when it races IPv4 and IPv6, all of them.
function safeLookup(host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) {
  dnsLookup(host, { all: true }, (err, list: LookupAddress[]) => {
    if (err) return cb(err)
    if (!list.length || list.some((a) => blocked(a.address))) return cb(new Error('blocked address'))
    if (opts.all) cb(null, list)
    else cb(null, list[0].address, list[0].family)
  })
}

const allowed = (u: URL) => {
  const host = u.hostname.replace(/^\[|\]$/g, '')
  return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password &&
    ['', '80', '443'].includes(u.port) && !(isIP(host) && blocked(host))
}

interface Got { url: URL; type: string; body: Buffer; full: boolean }

function once(url: URL, max: number, stopAtHead: boolean) {
  return new Promise<Got & { location?: string }>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, {
      lookup: safeLookup as never,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; TalkLinkPreview/1.0; +https://github.com/Princeu3/talk)', accept: 'text/html,image/*;q=0.9,*/*;q=0.1' },
    }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        return resolve({ url, type: '', body: Buffer.alloc(0), full: true, location: res.headers.location })
      }
      if (status !== 200) {
        res.resume()
        return reject(new Error(`status ${status}`))
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        chunks.push(c)
        size += c.length
        if (size > max || (stopAtHead && c.toString('latin1').toLowerCase().includes('</head'))) res.destroy()
      })
      // A reset or the timeout mid-body errors the response; unhandled, that would take the server down.
      res.on('error', reject)
      res.on('close', () => resolve({ url, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).subarray(0, max), full: size <= max }))
    })
    req.on('error', reject)
  })
}

async function get(raw: string, max: number, stopAtHead = false): Promise<Got> {
  let url = new URL(raw)
  for (let hop = 0; hop <= HOPS; hop++) {
    if (!allowed(url)) throw new Error('refused')
    const r = await once(url, max, stopAtHead)
    if (!r.location) return r
    url = new URL(r.location, url)
  }
  throw new Error('too many redirects')
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (s: string) =>
  s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
  })
const clean = (s: string | undefined, max: number) => {
  const t = s && decode(s).replace(/\s+/g, ' ').trim()
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : undefined
}
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((x) => x != null)

// Open Graph and Twitter card tags, falling back to <title>. `image` is the og:image link here.
export function parseHead(html: string, base: URL): LinkPreview {
  const meta: Record<string, string> = {}
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name'))?.toLowerCase()
    const content = attr(tag, 'content')
    if (key && content != null && !(key in meta)) meta[key] = content
  }
  const image = meta['og:image:secure_url'] ?? meta['og:image'] ?? meta['twitter:image']
  let imageUrl: string | undefined
  try {
    imageUrl = image ? new URL(decode(image), base).href : undefined
  } catch {}
  return {
    url: base.href,
    title: clean(meta['og:title'] ?? meta['twitter:title'] ?? /<title[^>]*>([^<]*)/i.exec(html)?.[1], 200),
    description: clean(meta['og:description'] ?? meta['twitter:description'] ?? meta.description, 300),
    site: clean(meta['og:site_name'], 100),
    image: imageUrl,
  }
}

function text(page: Got) {
  const sniff = page.body.toString('latin1')
  const label = /charset=["']?([\w-]+)/i.exec(page.type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(label).decode(page.body)
  } catch {
    return new TextDecoder().decode(page.body)
  }
}

interface Unfurled extends Omit<LinkPreview, 'image'> {
  image?: string // the raw og:image, base64, for the client to shrink
  imageType?: string
}

const cache = new Map<string, { at: number; value: Unfurled }>()
const CACHE_MS = 10 * 60_000

export async function unfurl(raw: string): Promise<Unfurled> {
  const hit = cache.get(raw)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const page = await get(raw, PAGE_MAX, true)
  if (!/^(text\/html|application\/xhtml\+xml)/i.test(page.type)) throw new Error('not a page')
  const { image, ...head } = parseHead(text(page), page.url)
  const value: Unfurled = head
  if (image) {
    const img = await get(image, IMAGE_MAX).catch(() => null)
    const type = img?.type.split(';')[0].trim().toLowerCase()
    if (img?.full && type && /^image\/(jpeg|png|gif|webp|avif)$/.test(type)) Object.assign(value, { image: img.body.toString('base64'), imageType: type })
  }
  if (!value.title && !value.description && !value.image) throw new Error('nothing to show')
  cache.delete(raw)
  cache.set(raw, { at: Date.now(), value })
  // Entries carry the raw og:image (up to 1 MB): few enough to stay small.
  if (cache.size > 30) cache.delete(cache.keys().next().value!)
  return value
}

// 20 previews a minute per account.
const hits = new Map<string, number[]>()
export function allow(userId: string) {
  const now = Date.now()
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= 20) return false
  hits.set(userId, [...recent, now])
  return true
}
