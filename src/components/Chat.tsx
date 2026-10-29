import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import type { Talk, Decrypted } from '../lib/useTalk.ts'
import type { FileRef } from '../../shared/types.ts'
import { convName, dayLabel, fileSize, userName } from '../lib/format.ts'
import { Avatar } from './Sidebar.tsx'
import { Back, Clip, Close, FileIcon, Lock, Send, UserPlus, Video } from './icons.tsx'
import { iconButton } from './Sidebar.tsx'

const AUTO_LOAD = 25 * 1024 * 1024
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g
const RUN_GAP = 5 * 60_000
const desktop = () => matchMedia('(pointer: fine)').matches

function FileChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [thumb, setThumb] = useState<string>()
  useEffect(() => {
    if (!file.type.startsWith('image/')) return
    const u = URL.createObjectURL(file)
    setThumb(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  return (
    <li className="relative shrink-0">
      {thumb ? (
        <img src={thumb} alt={file.name} className="h-16 w-16 rounded-xl object-cover" />
      ) : (
        <div className="flex h-16 w-36 items-center gap-2 rounded-xl bg-raised px-3 text-sm">
          <FileIcon size={18} />
          <span className="min-w-0 truncate">{file.name}</span>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-ink text-bg after:absolute after:-inset-2.5 after:content-['']"
      >
        <Close size={14} />
      </button>
    </li>
  )
}

function Linkified({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) =>
        i % 2 ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  )
}

function Attachment({ talk, convId, file, onZoom }: { talk: Talk; convId: string; file: FileRef; onZoom: (url: string) => void }) {
  const [url, setUrl] = useState<string>()
  const [want, setWant] = useState(file.size <= AUTO_LOAD)
  const [failed, setFailed] = useState(false)
  const [tries, setTries] = useState(0)
  useEffect(() => {
    if (want) talk.fileUrl(convId, file).then(setUrl, () => setFailed(true))
  }, [want, convId, file, talk, tries])

  const kind = file.type.split('/')[0]
  const media = kind === 'image' || kind === 'video'
  if (url && kind === 'image')
    return (
      <button type="button" onClick={() => onZoom(url)} className="block cursor-zoom-in" aria-label={`Open ${file.name}`}>
        <img src={url} alt={file.name} className="max-h-80 max-w-full rounded-xl object-cover" />
      </button>
    )
  if (url && kind === 'video') return <video src={url} controls playsInline className="max-h-80 max-w-full rounded-xl bg-black" />
  if (url && kind === 'audio') return <audio src={url} controls className="w-64 max-w-full" />
  // Reserve a photo-sized box while decrypting so the thread doesn't jump.
  if (media && want && !failed)
    return <div className="aspect-[4/3] w-60 max-w-full animate-pulse rounded-xl bg-raised" aria-label={`Decrypting ${file.name}`} />
  const status = failed ? 'Couldn\u2019t load. Tap to retry' : url ? `${fileSize(file.size)} \u00b7 Save` : want ? 'Decrypting\u2026' : `${fileSize(file.size)} \u00b7 Tap to download`
  return (
    <a
      href={url}
      download={file.name}
      onClick={(e) => {
        if (url) return
        e.preventDefault()
        setFailed(false)
        setWant(true)
        setTries((t) => t + 1)
      }}
      className="flex min-h-11 items-center gap-3 rounded-2xl bg-ink/8 px-3 py-2.5"
    >
      <FileIcon />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{file.name}</span>
        <span className="block text-xs opacity-80">{status}</span>
      </span>
    </a>
  )
}

// Bubbles in one run from the same sender share a column; inner corners tighten.
// Full class names: Tailwind only generates classes it can read in the source.
function corners(mine: boolean, first: boolean, last: boolean) {
  const top = first ? '' : mine ? 'rounded-tr-md' : 'rounded-tl-md'
  const bottom = last ? '' : mine ? 'rounded-br-md' : 'rounded-bl-md'
  return `rounded-[20px] ${top} ${bottom}`
}

function Bubble({ m, mine, first, last, talk, onJoin, onZoom }: {
  m: Decrypted
  mine: boolean
  first: boolean
  last: boolean
  talk: Talk
  onJoin: (room: string) => void
  onZoom: (u: string) => void
}) {
  const c = m.content
  const shape = `max-w-[80%] sm:max-w-[65%] ${corners(mine, first, last)} ${mine ? 'self-end' : 'self-start'}`
  const tone = mine ? 'bg-mine' : 'bg-bubble'
  if (!c)
    return (
      <div className={`${shape} ${tone} flex items-center gap-2 px-4 py-2.5 opacity-80`}>
        <Lock size={14} /> Couldn't decrypt this message
      </div>
    )
  if (c.call)
    return (
      <div className={`${shape} ${tone} flex items-center gap-3 py-2.5 pl-4 pr-2.5`}>
        <Video />
        <span className="flex-1">{mine ? 'You started a call' : `${userName(talk.me!, m.senderId)} started a call`}</span>
        <button onClick={() => onJoin(c.call!.room)} className="pressable min-h-9 rounded-full bg-fill px-4 text-sm font-semibold text-on-fill">
          Join
        </button>
      </div>
    )
  const mediaOnly = !c.text && c.files?.every((f) => /^(image|video)\//.test(f.type))
  return (
    <div className={`${shape} ${mediaOnly ? 'overflow-hidden' : `${tone} px-4 py-2.5`} flex flex-col gap-2 whitespace-pre-wrap break-words`}>
      {c.files?.map((f) => <Attachment key={f.id} talk={talk} convId={m.convId} file={f} onZoom={onZoom} />)}
      {c.text && <span><Linkified text={c.text} /></span>}
      {m.forged && <span className={`text-xs ${mine ? '' : 'text-danger'}`}>Warning: the sender could not be verified</span>}
    </div>
  )
}

export default function Chat({ talk, convId, onBack, onCall, onJoin, onAddPeople }: {
  talk: Talk
  convId: string
  onBack: () => void
  onCall: () => void
  onJoin: (room: string) => void
  onAddPeople: () => void
}) {
  const me = talk.me!
  const conv = me.conversations.find((c) => c.id === convId)
  const list = talk.messages[convId] ?? []
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState<string>()
  const scroller = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const stick = useRef(true) // pinned to the bottom?
  const olderFrom = useRef<number | null>(null) // scrollHeight before loading older

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (olderFrom.current != null) {
      el.scrollTop += el.scrollHeight - olderFrom.current
      olderFrom.current = null
    } else if (stick.current) el.scrollTop = el.scrollHeight
  }, [list.length, convId])

  useEffect(() => {
    if (!zoom) return
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setZoom(undefined)
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [zoom])

  useEffect(() => {
    stick.current = true
    setText('')
    setFiles([])
    setError('')
  }, [convId])

  if (!conv) return null
  const name = convName(me, conv)

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const t = text.trim()
    if ((!t && !files.length) || busy) return
    setBusy(true)
    setError('')
    const sending = { t: text, f: files }
    setText('')
    setFiles([])
    stick.current = true
    try {
      if (sending.f.length) await talk.sendWithFiles(convId, t, sending.f)
      else await talk.send(convId, { text: t })
    } catch (err) {
      setText(sending.t)
      setFiles(sending.f)
      setError((err as Error).message || 'Could not send. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && desktop()) {
      e.preventDefault()
      submit()
    }
  }
  const onPaste = (e: ClipboardEvent) => {
    const pasted = [...e.clipboardData.files]
    if (pasted.length) {
      e.preventDefault()
      setFiles((f) => [...f, ...pasted])
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="pt-safe z-10 flex items-center gap-1 bg-surface px-2 pb-2">
        <button onClick={onBack} aria-label="Back to chats" className={`${iconButton} md:hidden`}>
          <Back />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-3 px-1 md:px-2">
          <Avatar name={name} size={36} />
          <div className="min-w-0">
            <h2 className="truncate font-semibold leading-tight">{name}</h2>
            <p className="truncate text-xs text-mut">
              {conv.kind === 'group' ? conv.members.map((id) => userName(me, id)).join(', ') : 'End-to-end encrypted'}
            </p>
          </div>
        </div>
        {conv.kind === 'group' && (
          <button onClick={onAddPeople} aria-label="Add people" className={iconButton}>
            <UserPlus size={22} />
          </button>
        )}
        <button onClick={onCall} aria-label="Start a call" className={iconButton}>
          <Video size={24} />
        </button>
      </header>

      <div
        ref={scroller}
        role="log"
        aria-label={`Messages with ${name}`}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="flex flex-1 flex-col overflow-y-auto px-3 pb-3 pt-4"
      >
        {talk.hasOlder[convId] && (
          <button
            onClick={() => {
              olderFrom.current = scroller.current!.scrollHeight
              talk.loadOlder(convId)
            }}
            className="pressable mb-3 min-h-9 self-center rounded-full bg-raised px-4 text-sm font-medium text-mut"
          >
            Load earlier messages
          </button>
        )}
        {list.length === 0 && talk.hasOlder[convId] !== undefined && (
          <div className="m-auto flex max-w-64 flex-col items-center gap-3 text-center">
            <Avatar name={name} size={72} />
            <p className="font-semibold">{name}</p>
            <p className="flex items-start gap-1.5 text-sm text-mut">
              <span className="mt-0.5 shrink-0"><Lock size={14} /></span>
              Messages and files here are encrypted on your device. Only the people in this chat can read them.
            </p>
          </div>
        )}
        {list.map((m, i) => {
          const prev = list[i - 1]
          const next = list[i + 1]
          const mine = m.senderId === me.user.id
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()
          const first = newDay || prev.senderId !== m.senderId || m.createdAt - prev.createdAt > RUN_GAP
          const last =
            !next ||
            next.senderId !== m.senderId ||
            next.createdAt - m.createdAt > RUN_GAP ||
            new Date(next.createdAt).toDateString() !== new Date(m.createdAt).toDateString()
          return (
            <div key={m.id} className={`flex flex-col ${first ? 'mt-3' : 'mt-0.5'}`}>
              {newDay && <div className="mb-2 mt-3 self-center text-xs font-medium text-mut">{dayLabel(m.createdAt)}</div>}
              {first && !mine && conv.kind === 'group' && <div className="mb-1 ml-3 text-xs font-medium text-mut">{userName(me, m.senderId)}</div>}
              <Bubble m={m} mine={mine} first={first} last={last} talk={talk} onJoin={onJoin} onZoom={setZoom} />
              {last && (
                <time className={`mt-1 px-2 text-xs tabular-nums text-mut ${mine ? 'self-end' : 'self-start'}`}>
                  {new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </time>
              )}
            </div>
          )
        })}
      </div>

      <form onSubmit={submit} className="pb-safe bg-surface px-2 pt-2">
        {error && (
          <p className="px-3 pb-2 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        {files.length > 0 && (
          <ul className="flex gap-2 overflow-x-auto px-1 pb-2" aria-label="Files to send">
            {files.map((f, i) => (
              <FileChip key={i} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
            ))}
          </ul>
        )}
        <div className="flex items-end gap-1">
          <button type="button" onClick={() => fileInput.current?.click()} aria-label="Attach photos or files" className={`${iconButton} text-mut`}>
            <Clip size={22} />
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { setFiles((f) => [...f, ...(e.target.files ?? [])]); e.target.value = '' }} />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
            rows={1}
            placeholder="Message"
            aria-label="Message"
            className="max-h-40 min-h-11 flex-1 resize-none rounded-[22px] bg-bg px-4 py-2.5 [field-sizing:content] focus-visible:outline-offset-0"
          />
          <button disabled={busy || (!text.trim() && !files.length)} aria-label="Send" className="pressable ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fill text-on-fill transition-opacity disabled:opacity-35">
            <Send size={18} />
          </button>
        </div>
        {busy && (
          <p className="flex items-center gap-1.5 px-3 pt-1.5 text-xs text-mut" aria-live="polite">
            <Lock size={12} /> Encrypting and sending…
          </p>
        )}
      </form>

      {zoom && (
        <div role="dialog" aria-label="Photo" onClick={() => setZoom(undefined)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4">
          <button onClick={() => setZoom(undefined)} aria-label="Close photo" className="pressable pt-safe absolute right-3 top-0 flex h-11 w-11 items-center justify-center rounded-full text-white">
            <Close />
          </button>
          <img src={zoom} alt="" className="max-h-full max-w-full object-contain" />
        </div>
      )}
    </div>
  )
}
