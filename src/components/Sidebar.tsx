import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Decrypted, Talk } from '../lib/useTalk.ts'
import { closedAsk, convName, fold, isHelper, preview, shortTime, snippet, typingLabel, userName } from '../lib/format.ts'
import { BellOff, Close, Compose, Lock, Phone, Pin, Search, Settings, Video } from './icons.tsx'

// Olive to soft white, so every avatar sits inside the app palette in both themes.
const SHADES = ['#2e3d28', '#4f6340', '#7e9466', '#a9b887', '#cdd6b8', '#e8e9df']

// Generative Bauhaus-style art seeded by the name: looks random, but the same
// person gets the same picture on every device, with nothing sent to a service.
export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  let h = [...name.toLowerCase()].reduce((a, ch) => Math.imul(a ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261)
  const next = (n: number) => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0
    return h % n
  }
  const pool = [...SHADES]
  // Background from the middle shades only, so the circle never melts into either page color.
  const bg = pool.splice(1 + next(4), 1)[0]
  const [block, dot, bar] = [0, 1, 2].map(() => pool.splice(next(pool.length), 1)[0])
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" className="shrink-0 rounded-full" aria-hidden>
      <rect width="80" height="80" fill={bg} />
      <rect x={10 + next(20)} y={-10 + next(30)} width={40 + next(30)} height={40 + next(30)} rx={next(2) ? 40 : 4} fill={block} transform={`rotate(${next(360)} 40 40)`} />
      <circle cx={20 + next(40)} cy={20 + next(40)} r={10 + next(12)} fill={dot} />
      <line x1="-10" y1={30 + next(20)} x2="90" y2={30 + next(20)} stroke={bar} strokeWidth={3 + next(4)} transform={`rotate(${next(180)} 40 40)`} />
    </svg>
  )
}

// Next to a helper's name. Anyone can end a name in "AI", but only the server sets `owner`, so this badge is
// the trust signal: screen readers hear it as "helper", since a spoken "AI" would sound like part of the name.
export const AiBadge = () => (
  <span className="ml-1.5 shrink-0 rounded-full bg-fill px-1.5 py-px text-xs font-semibold text-on-fill">
    <span aria-hidden>AI</span>
    <span className="sr-only">, helper</span>
  </span>
)

export const iconButton = 'pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-accent hover:bg-raised'

const MAX_HITS = 200
const hitRow = 'flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors duration-150 hover:bg-raised/60 active:bg-raised'

// What search looks through in a message: text, file names, link titles; not system lines, call logs or voice notes.
const folded = new WeakMap<Decrypted, string>()
function searchable(m: Decrypted) {
  let f = folded.get(m)
  if (f === undefined) {
    const c = m.content
    f = !c || m.system || c.call ? '' : fold(fields(m).join('\n'))
    folded.set(m, f)
  }
  return f
}
const fields = ({ content: c }: Decrypted) =>
  [c?.text, ...(c?.files ?? []).filter((x) => !x.voice).map((x) => x.name), c?.preview?.title].filter((s): s is string => !!s)

function SearchResults({ talk, q }: { talk: Talk; q: string }) {
  const me = talk.me!
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const words = q.length >= 2
  const { backfill } = talk
  const convs = useRef(me.conversations)

  // Page every chat's older history; results re-run as pages land.
  useEffect(() => {
    if (!words) return
    setBusy(true)
    return backfill(
      convs.current.map((c) => c.id),
      (finished) => {
        setTick((n) => n + 1)
        if (finished) setBusy(false)
      },
    )
  }, [words, backfill])

  const chats = me.conversations.filter(
    (conv) => fold(convName(me, conv)).includes(q) || conv.members.some((u) => u !== me.user.id && fold(userName(me, u)).includes(q)),
  )
  const { messages, history } = talk
  const hits = useMemo(() => {
    if (!words) return []
    const all: Decrypted[] = []
    for (const conv of me.conversations) {
      let n = 0
      for (const m of history(conv.id).list) {
        if (!searchable(m).includes(q)) continue
        all.push(m)
        if (++n >= MAX_HITS) break
      }
    }
    return all
      .sort((a, b) => b.id - a.id)
      .slice(0, MAX_HITS)
      .map((m) => ({ m, parts: fields(m).reduce<ReturnType<typeof snippet>>((hit, s) => hit ?? snippet(s, q), null) }))
  }, [q, words, me, messages, history, tick]) // tick: a page landed in the archive, which isn't state

  return (
    <>
      {chats.length > 0 && (
        <section aria-label="Chats">
          <h2 className="px-3 pb-1 pt-2 text-sm font-semibold text-mut">Chats</h2>
          <ul>
            {chats.map((conv) => (
              <li key={conv.id}>
                <button data-hit onClick={() => talk.open(conv.id)} className={hitRow}>
                  <Avatar name={convName(me, conv)} size={40} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{convName(me, conv)}</span>
                    {conv.kind === 'group' && (
                      <span className="block truncate text-sm text-mut">{conv.members.filter((u) => u !== me.user.id).map((u) => userName(me, u)).join(', ')}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {hits.length > 0 && (
        <section aria-label="Messages">
          <h2 className="px-3 pb-1 pt-3 text-sm font-semibold text-mut">Messages</h2>
          <ul>
            {hits.map(({ m, parts }) => {
              const conv = me.conversations.find((c) => c.id === m.convId)!
              const name = convName(me, conv)
              const who = m.senderId === me.user.id ? 'You: ' : conv.kind === 'group' ? `${userName(me, m.senderId)}: ` : ''
              return (
                <li key={m.id}>
                  <button data-hit onClick={() => talk.openAt(conv.id, m.id)} className={hitRow}>
                    <Avatar name={name} size={40} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-medium">{name}</span>
                        <time className="shrink-0 text-xs tabular-nums text-mut">{shortTime(m.createdAt)}</time>
                      </span>
                      <span className="block truncate text-sm text-mut">
                        {who}
                        {parts ? <>{parts[0]}<b className="font-semibold text-ink">{parts[1]}</b>{parts[2]}</> : preview(m.content)}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      <p role="status" className="px-3 py-4 text-center text-sm text-mut">
        {busy && words ? 'Searching older messages…' : !chats.length && !hits.length ? 'No results' : ''}
      </p>
    </>
  )
}

export default function Sidebar({ talk, onNew, onSettings, onJoin }: { talk: Talk; onNew: () => void; onSettings: () => void; onJoin: (convId: string) => void }) {
  const me = talk.me!
  const [query, setQuery] = useState('')
  const [q, setQ] = useState('') // folded, a beat behind the typing
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const t = setTimeout(() => setQ(fold(query.trim())), 150)
    return () => clearTimeout(t)
  }, [query])

  // Escape clears; arrows move between the field and the results.
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && query) {
      e.preventDefault()
      setQuery('')
      box.current!.focus()
    }
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || !query.trim()) return
    const hits = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-hit]')]
    const i = hits.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? hits[i + 1] : i > 0 ? hits[i - 1] : box.current
    if (!next) return
    e.preventDefault()
    next.focus()
  }

  return (
    <div className="flex h-full flex-col" onKeyDown={onKey}>
      <header className="pt-safe px-2">
        <div className="flex items-center justify-between">
          <button onClick={onSettings} aria-label="Settings and invites" className={iconButton}>
            <Settings size={22} />
          </button>
          <button onClick={onNew} aria-label="New chat" className={iconButton}>
            <Compose size={22} />
          </button>
        </div>
        <h1 className="px-3 pb-2 pt-1 text-[2rem] font-bold leading-tight tracking-tight">Chats</h1>
        <div role="search" className="relative px-1 pb-2 text-mut">
          <span className="pointer-events-none absolute left-4 top-1/2 -mt-1 -translate-y-1/2"><Search size={18} /></span>
          <input
            ref={box}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search chats and messages"
            className="min-h-10 w-full rounded-xl bg-raised pl-10 pr-10 text-ink focus-visible:outline-offset-0"
          />
          {query && (
            <button
              type="button"
              onClick={() => (setQuery(''), box.current?.focus())}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -mt-1 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-mut"
            >
              <Close size={16} />
            </button>
          )}
        </div>
      </header>
      {query.trim() && (
        <nav aria-label="Search results" className="pb-safe flex-1 overflow-y-auto px-2">
          {q && <SearchResults talk={talk} q={q} />}
        </nav>
      )}
      {/* Hidden, not unmounted, during a search so it keeps its scroll position */}
      <nav aria-label="Chats" className={`pb-safe flex-1 overflow-y-auto px-2 ${query.trim() ? 'hidden' : ''}`}>
        {me.conversations.length === 0 && (
          <div className="flex flex-col items-start gap-3 px-3 py-6">
            <p className="text-mut">
              {me.users.length > 1
                ? 'Start a chat with someone here.'
                : 'Nobody else is here yet. Create an invite link in Settings and send it to a friend.'}
            </p>
            <button onClick={me.users.length > 1 ? onNew : onSettings} className="pressable rounded-full bg-fill px-5 py-2.5 font-semibold text-on-fill">
              {me.users.length > 1 ? 'New chat' : 'Invite someone'}
            </button>
          </div>
        )}
        <ul>
          {me.conversations.map((conv) => {
            const name = convName(me, conv)
            const last = talk.messages[conv.id]?.at(-1)
            const active = conv.id === talk.activeId
            const text = preview(last?.content && closedAsk(me, last.senderId, last.content), last?.senderId === me.user.id)
            const who = !last || last.system ? '' : last.senderId === me.user.id ? 'You: ' : conv.kind === 'group' ? `${userName(me, last.senderId)}: ` : ''
            const join = conv.call && !conv.call.peers.includes(me.user.id) ? conv.call : null
            const typers = talk.typers[conv.id] ?? []
            const helper = isHelper(me, conv)
            return (
              <li key={conv.id} className="relative">
                <button
                  onClick={() => talk.open(conv.id)}
                  aria-current={active ? 'true' : undefined}
                  className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors duration-150 ${active ? 'bg-raised' : 'hover:bg-raised/60 active:bg-raised'} ${join ? 'pr-24' : ''}`}
                >
                  <Avatar name={name} size={48} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="flex min-w-0 items-center">
                        <span className={`truncate ${conv.unread ? 'font-semibold' : 'font-medium'}`}>{name}</span>
                        {helper && <AiBadge />}
                      </span>
                      {conv.lastMessageAt && (
                        <time className={`shrink-0 text-xs tabular-nums ${conv.unread ? 'font-semibold text-accent' : 'text-mut'}`}>
                          {shortTime(conv.lastMessageAt)}
                        </time>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <span className={`line-clamp-2 text-sm leading-snug ${typers.length ? 'text-accent' : conv.unread ? 'text-ink' : 'text-mut'}`}>
                        {typers.length ? (
                          typingLabel(me, conv, typers)
                        ) : last && !last.content ? (
                          <span className="inline-flex items-center gap-1"><Lock size={12} /> Encrypted message</span>
                        ) : text ? (
                          who + text
                        ) : conv.kind === 'group' ? (
                          `${conv.members.length} people`
                        ) : (
                          'No messages yet'
                        )}
                      </span>
                      {(conv.muted || conv.pinned) && (
                        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-mut">
                          {conv.muted && <span title="Muted"><span className="sr-only">Muted</span><BellOff size={14} /></span>}
                          {conv.pinned && <span title="Pinned"><span className="sr-only">Pinned</span><Pin size={14} /></span>}
                        </span>
                      )}
                      {conv.unread > 0 && (
                        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-fill px-1.5 text-xs font-semibold tabular-nums text-on-fill">
                          <span className="sr-only">Unread: </span>
                          {conv.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
                {/* A sibling of the row, since a button can't hold another */}
                {join && (
                  <button
                    onClick={() => onJoin(conv.id)}
                    aria-label={`Join the call in ${name}`}
                    className="pressable absolute right-3 top-1/2 flex min-h-9 -translate-y-1/2 items-center gap-1.5 rounded-full bg-fill px-3.5 text-sm font-semibold text-on-fill"
                  >
                    {join.kind === 'audio' ? <Phone size={14} /> : <Video size={16} />} Join
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}
