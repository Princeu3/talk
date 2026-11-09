import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AUTO_LOAD, type Talk } from '../lib/useTalk.ts'
import type { CallKind, FileRef } from '../../shared/types.ts'
import { convName, fileSize, host, isHelper, readOnlyNote, shortTime, URL_RE, userName } from '../lib/format.ts'
import { Avatar } from './Sidebar.tsx'
import { Confirm, danger, primary, Report, SafetyCode, segment, Sheet } from './Sheets.tsx'
import { Ban, BellOff, FileIcon, Flag, ImageIcon, LinkIcon, Lock, LogOut, Pencil, Phone, Pin, UserPlus, Video } from './icons.tsx'

const row = 'flex min-h-12 w-full items-center gap-3 rounded-2xl px-2 text-left font-medium hover:bg-raised'
const TABS = ['Media', 'Links', 'Docs'] as const
const isMedia = (f: FileRef) => /^(image|video)\//.test(f.type)

// A photo in the grid, decrypted once it scrolls into view; videos and big files wait for a tap.
function Thumb({ talk, convId, file, onOpen }: { talk: Talk; convId: string; file: FileRef; onOpen: (url: string, video: boolean) => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [url, setUrl] = useState<string>()
  const video = file.type.startsWith('video/')
  useEffect(() => {
    if (url || video || file.size > AUTO_LOAD) return
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return
      io.disconnect()
      talk.fileUrl(convId, file).then(setUrl, () => {})
    })
    io.observe(ref.current!)
    return () => io.disconnect()
  }, [convId, file, url, video]) // not talk: a new object each render, and fileUrl only reads refs
  const open = async () => onOpen(url ?? (await talk.fileUrl(convId, file)), video)
  return (
    <button ref={ref} type="button" onClick={() => void open().catch(() => {})} aria-label={`Open ${file.name}`} className="relative block aspect-square w-full overflow-hidden rounded-lg bg-raised">
      {video ? <span className="flex h-full items-center justify-center text-mut"><Video size={24} /></span> : url && <img src={url} alt="" className="h-full w-full object-cover" />}
    </button>
  )
}

// Photos and videos, links, and other files in a chat, newest first, from the history archive.
function SharedMedia({ talk, convId, onZoom, onClose }: { talk: Talk; convId: string; onZoom: (url: string, video?: boolean) => void; onClose: () => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Media')
  const [, setTick] = useState(0)
  const [done, setDone] = useState(false)
  const { backfill } = talk
  useEffect(
    () =>
      backfill([convId], (finished) => {
        setTick((n) => n + 1)
        if (finished) setDone(true)
      }),
    [backfill, convId],
  )

  // Only the open tab's list is built.
  const msgs = talk.history(convId).list.filter((m) => m.content && !m.system && !m.content.call)
  const files = tab === 'Links' ? [] : msgs.flatMap((m) => (m.content!.files ?? []).filter((f) => !f.voice && isMedia(f) === (tab === 'Media')).map((f) => ({ m, f })))
  const links =
    tab !== 'Links'
      ? []
      : msgs.flatMap((m) => {
          const p = m.content!.preview
          const url = p?.url ?? m.content!.text?.match(URL_RE)?.[0]
          return url ? [{ m, url, p }] : []
        })
  const count = files.length + links.length

  const save = async (f: FileRef) => {
    const a = document.createElement('a')
    a.href = await talk.fileUrl(convId, f)
    a.download = f.name
    a.click()
  }

  return (
    <Sheet title="Media, links and docs" onClose={onClose}>
      <fieldset className="mb-3">
        <legend className="sr-only">Show</legend>
        <div className="flex gap-1 rounded-full bg-raised p-1">
          {TABS.map((t) => (
            <label key={t} className={segment}>
              <input type="radio" name="shared" value={t} checked={tab === t} onChange={() => setTab(t)} className="sr-only" />
              {t}
            </label>
          ))}
        </div>
      </fieldset>
      {/* A steady height, so the tabs don't jump when one tab's list is shorter */}
      <div className="min-h-[60dvh]">
        {tab === 'Media' && (
          <ul className="grid grid-cols-3 gap-1">
            {files.map(({ f }) => (
              <li key={f.id}><Thumb talk={talk} convId={convId} file={f} onOpen={onZoom} /></li>
            ))}
          </ul>
        )}
        {tab === 'Links' && (
          <ul>
            {links.map(({ m, url, p }) => (
              <li key={m.id}>
                <a href={url} target="_blank" rel="noopener noreferrer" className={`${row} py-1.5`}>
                  {p?.image ? (
                    <img src={`data:image/jpeg;base64,${p.image}`} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
                  ) : (
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-raised text-accent"><LinkIcon size={18} /></span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{p?.title || url}</span>
                    <span className="block truncate text-sm font-normal text-mut">{p?.site || host(url)} · {shortTime(m.createdAt)}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {tab === 'Docs' && (
          <ul>
            {files.map(({ m, f }) => (
              <li key={f.id}>
                <button onClick={() => void save(f).catch(() => {})} className={`${row} py-1.5`}>
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-raised text-accent"><FileIcon size={18} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{f.name}</span>
                    <span className="block truncate text-sm font-normal text-mut">{fileSize(f.size)} · {shortTime(m.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p role="status" className="py-6 text-center text-sm text-mut">
          {!done ? 'Loading older messages…' : !count ? `No ${tab.toLowerCase()} yet` : ''}
        </p>
      </div>
    </Sheet>
  )
}

function Toggle({ icon, label, checked, onChange }: { icon: ReactNode; label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className={`${row} cursor-pointer`}>
      <span className="text-accent">{icon}</span>
      <span className="flex-1">{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 accent-[var(--color-accent)]" />
    </label>
  )
}

// One sheet at a time (info, a member, a confirm), so Escape steps back one level.
export default function ChatInfo({ talk, convId, onClose, onCall, onAddPeople, onZoom }: {
  talk: Talk
  convId: string
  onClose: () => void
  onCall?: (kind: CallKind) => void // unset while a call is on
  onAddPeople: () => void
  onZoom: (url: string, video?: boolean) => void // the chat's photo viewer
}) {
  const me = talk.me!
  const conv = me.conversations.find((c) => c.id === convId)
  const [media, setMedia] = useState(false)
  const [member, setMember] = useState<string | null>(null)
  const [ask, setAsk] = useState<'leave' | 'remove' | 'report' | null>(null)
  const [title, setTitle] = useState<string | null>(null) // set while renaming
  const [error, setError] = useState('')
  if (!conv) return null
  const name = convName(me, conv)
  const group = conv.kind === 'group'
  const other = conv.members.find((u) => u !== me.user.id) ?? me.user.id
  const user = (id: string) => me.users.find((u) => u.id === id)

  const run = (p: Promise<unknown>) => {
    setError('')
    p.catch((e: Error) => setError(e.message))
  }
  const rename = async (e: FormEvent) => {
    e.preventDefault()
    const t = title!.trim()
    if (!t || t === conv.title) return setTitle(null)
    try {
      await talk.rename(convId, t)
      setTitle(null)
    } catch (err) {
      setError((err as Error).message === 'bad request' ? 'Use up to 32 letters, numbers, spaces, dots, dashes or underscores.' : (err as Error).message)
    }
  }

  if (media) return <SharedMedia talk={talk} convId={convId} onZoom={onZoom} onClose={() => setMedia(false)} />
  if (ask === 'leave')
    return <Confirm title="Leave this group?" body="You won't get its messages anymore. Someone in it can add you back." action="Leave group" onConfirm={() => talk.leave(convId)} onClose={() => setAsk(null)} />
  if (ask === 'report') return <Report talk={talk} userId={other} convId={convId} onClose={() => setAsk(null)} />
  if (member && ask === 'remove')
    return (
      <Confirm
        title={`Remove ${userName(me, member)}?`}
        body="They won't get this group's messages anymore."
        action="Remove from group"
        onConfirm={async () => {
          await talk.removeMember(convId, member)
          setMember(null)
        }}
        onClose={() => setAsk(null)}
      />
    )
  if (member)
    return (
      <Sheet title={userName(me, member)} onClose={() => setMember(null)}>
        <div className="flex flex-col items-center gap-2 pb-5 pt-2 text-center">
          <Avatar name={userName(me, member)} size={72} />
          <p className="text-sm text-mut">Safety code</p>
          <SafetyCode pubkey={user(member)!.pubkey} />
        </div>
        {error && <p className="mb-2 text-sm text-danger" role="alert">{error}</p>}
        {!user(member)!.deleted && (
          <button onClick={() => run(talk.createConversation([member]).then((id) => { talk.open(id); onClose() }))} className={primary}>
            Message
          </button>
        )}
        <button onClick={() => setAsk('remove')} className={`${danger} mt-2`}>Remove from group</button>
      </Sheet>
    )

  const others = conv.members.filter((u) => u !== me.user.id).sort((a, b) => userName(me, a).localeCompare(userName(me, b)))
  const blocked = me.blocked.includes(other)
  const helper = isHelper(me, conv)
  // A deleted account's DM keeps only you, so its safety code, Block and Report would all point at you.
  const gone = readOnlyNote(me, conv)
  const call = (kind: CallKind) => {
    onCall?.(kind)
    onClose()
  }

  return (
    <Sheet title={group ? 'Group info' : 'Contact info'} onClose={onClose}>
      <div className="flex flex-col items-center gap-1 pb-5 pt-2 text-center">
        <Avatar name={name} size={88} />
        {title !== null ? (
          <form onSubmit={rename} className="mt-2 flex w-full items-center gap-2">
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                e.stopPropagation() // cancel the rename, keep the sheet
                setTitle(null)
              }}
              maxLength={32}
              aria-label="Group name"
              className="min-h-11 min-w-0 flex-1 rounded-2xl bg-surface px-4"
            />
            <button className="pressable min-h-11 shrink-0 rounded-full bg-fill px-4 font-semibold text-on-fill">Save</button>
          </form>
        ) : (
          <h3 className="mt-2 text-xl font-semibold">{name}</h3>
        )}
        <p className="flex items-center gap-1 text-sm text-mut">
          {group ? `${conv.members.length} people` : <><Lock size={12} /> End-to-end encrypted</>}
        </p>
        {group && title === null && (
          <button onClick={() => setTitle(name)} className="pressable flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-semibold text-accent hover:bg-raised">
            <Pencil size={14} /> Rename
          </button>
        )}
      </div>
      {error && <p className="mb-3 text-sm text-danger" role="alert">{error}</p>}

      {/* a helper or a deleted account takes no calls */}
      {!helper && !gone && (
        <div className="mb-5 flex gap-2">
          {([['audio', 'Voice', Phone], ['video', 'Video', Video]] as const).map(([kind, label, Icon]) => (
            <button
              key={kind}
              onClick={() => call(kind)}
              disabled={!onCall}
              className="pressable flex min-h-16 flex-1 flex-col items-center justify-center gap-1 rounded-2xl bg-surface text-sm font-medium text-accent disabled:opacity-40"
            >
              <Icon size={20} /> {label}
            </button>
          ))}
        </div>
      )}

      <button onClick={() => setMedia(true)} className={`${row} mb-5`}>
        <span className="text-accent"><ImageIcon size={20} /></span>
        Media, links and docs
      </button>

      {group ? (
        <section className="mb-5">
          <h4 className="mb-1 px-2 text-sm font-semibold text-mut">Members</h4>
          <div className={row}>
            <Avatar name={me.user.name} size={36} /> You
          </div>
          {others.map((id) => (
            <button key={id} onClick={() => setMember(id)} className={row}>
              <Avatar name={userName(me, id)} size={36} /> {userName(me, id)}
            </button>
          ))}
          <button
            onClick={() => {
              onClose()
              onAddPeople()
            }}
            className={`${row} text-accent`}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-raised"><UserPlus size={18} /></span>
            Add people
          </button>
        </section>
      ) : gone ? null : (
        <section className="mb-5 px-2">
          <h4 className="text-sm font-semibold text-mut">Safety code</h4>
          <SafetyCode pubkey={user(other)!.pubkey} />
          <p className="mt-1 text-sm text-mut">
            {/* a helper has no Settings to show its code */}
            Compare it with the code {helper ? 'talkline printed when it was paired' : `${name} sees for themselves in Settings, in person or on a call`}. If they match, nobody swapped a key.
          </p>
        </section>
      )}

      <section className="mb-5">
        <Toggle icon={<BellOff size={20} />} label="Mute notifications" checked={!!conv.muted} onChange={(on) => run(talk.setMine(convId, { muted: on }))} />
        <Toggle icon={<Pin size={20} />} label="Pin chat" checked={!!conv.pinned} onChange={(on) => run(talk.setMine(convId, { pinned: on }))} />
      </section>

      {group ? (
        <button onClick={() => setAsk('leave')} className={`${row} text-danger`}>
          <LogOut size={20} /> Leave group
        </button>
      ) : helper || gone ? null /* Pause and Remove are in Settings > Agents; nobody reports their own helper */ : (
        <section>
          <button onClick={() => run(talk.block(other, !blocked))} className={`${row} ${blocked ? '' : 'text-danger'}`}>
            <Ban size={20} /> {blocked ? `Unblock ${name}` : `Block ${name}`}
          </button>
          <button onClick={() => setAsk('report')} className={`${row} text-danger`}>
            <Flag size={20} /> Report {name}
          </button>
        </section>
      )}
    </Sheet>
  )
}
