import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type ClipboardEvent, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode,
} from 'react'
import type { Talk, Decrypted } from '../lib/useTalk.ts'
import type { CallKind, FileRef, Voice } from '../../shared/types.ts'
import { callSummary, convName, dayLabel, fileSize, preview, typingLabel, userName } from '../lib/format.ts'
import { canRecord, startRecording, type Recording } from '../lib/voice.ts'
import { Avatar } from './Sidebar.tsx'
import { Back, Check, Clip, Close, Copy, FileIcon, Flag, Forward, Lock, Mic, More, Pencil, Phone, Reply, Send, Trash, Video } from './icons.tsx'
import { iconButton } from './Sidebar.tsx'
import { VoicePlayer, VoiceRecorder } from './Voice.tsx'
import { Confirm, ForwardSheet, Report, Sheet } from './Sheets.tsx'
import ChatInfo from './ChatInfo.tsx'

const AUTO_LOAD = 25 * 1024 * 1024
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g
const RUN_GAP = 5 * 60_000
const EDIT_MS = 15 * 60_000 // the server's window
const EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏']
const column = 'flex max-w-[80%] flex-col sm:max-w-[65%]' // a bubble and what hangs off it
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

  const retry = () => {
    setFailed(false)
    setWant(true)
    setTries((t) => t + 1)
  }
  if (file.voice) return <VoicePlayer url={url} voice={file.voice} failed={failed} onRetry={retry} />

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
        retry()
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

function Bubble({ m, mine, first, last, talk, onCall, onZoom, onJump }: {
  m: Decrypted
  mine: boolean
  first: boolean
  last: boolean
  talk: Talk
  onCall?: (kind: CallKind) => void // unset during a call
  onZoom: (u: string) => void
  onJump?: (id: number) => void // to a reply's original
}) {
  const c = m.content
  const shape = `max-w-full ${corners(mine, first, last)} ${mine ? 'self-end' : 'self-start'}`
  const tone = mine ? 'bg-mine' : 'bg-bubble'
  if (!c)
    return (
      <div className={`${shape} ${tone} flex items-center gap-2 px-4 py-2.5 opacity-80`}>
        <Lock size={14} /> Couldn't decrypt this message
      </div>
    )
  if (c.call) {
    const kind = c.call.kind ?? 'video'
    const { title, detail, missed } = callSummary(c.call, mine)
    const conv = talk.me!.conversations.find((x) => x.id === m.convId)
    return (
      <div className={`${shape} ${tone} flex items-center gap-3 py-2 pl-2.5 pr-2`}>
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${missed ? 'bg-danger/15 text-danger' : 'bg-ink/8'}`}>
          {kind === 'audio' ? <Phone size={18} /> : <Video size={20} />}
        </span>
        <div className="min-w-0 flex-1 pr-1">
          <div className={`font-semibold leading-tight ${missed ? 'text-danger' : ''}`}>{title}</div>
          {detail && <div className="text-sm text-ink/80">{detail}</div>}
        </div>
        {onCall && (
          <button onClick={() => onCall(kind)} className="pressable min-h-9 shrink-0 rounded-full bg-fill px-3.5 text-sm font-semibold text-on-fill">
            {conv?.kind === 'group' ? (conv.call ? 'Join' : 'Call') : mine ? 'Call again' : 'Call back'}
          </button>
        )}
      </div>
    )
  }
  const mediaOnly = !c.text && !c.reply && !c.forwarded && c.files?.every((f) => /^(image|video)\//.test(f.type))
  const me = talk.me!
  return (
    <div className={`${shape} ${mediaOnly ? 'overflow-hidden' : `${tone} px-4 py-2.5`} flex flex-col gap-2 whitespace-pre-wrap break-words`}>
      {c.forwarded && (
        <span className="-mb-1 flex items-center gap-1 text-xs italic text-ink/80">
          <Forward size={12} /> Forwarded
        </span>
      )}
      {c.reply && (
        <button
          type="button"
          onClick={() => onJump?.(c.reply!.id)}
          className="flex flex-col rounded-xl border-l-[3px] border-accent bg-ink/8 px-3 py-1.5 text-left text-sm"
        >
          <span className="font-semibold">{c.reply.from === me.user.id ? 'You' : userName(me, c.reply.from)}</span>
          <span className="line-clamp-2 text-ink/80">{c.reply.preview}</span>
        </button>
      )}
      {c.files?.map((f) => <Attachment key={f.id} talk={talk} convId={m.convId} file={f} onZoom={onZoom} />)}
      {c.text && <span><Linkified text={c.text} /></span>}
      {m.forged && <span className={`text-xs ${mine ? '' : 'text-danger'}`}>Warning: the sender could not be verified</span>}
    </div>
  )
}

// Reaction bar over the action list, beside the bubble and kept on screen.
function MessageMenu({ at, mine, onClose, children }: { at: DOMRect; mine: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    const { offsetWidth: w, offsetHeight: h } = ref.current!
    const top = at.bottom + 6 + h < innerHeight - 8 ? at.bottom + 6 : Math.max(8, at.top - h - 6)
    setPos({ top, left: Math.min(Math.max(8, mine ? at.right - w : at.left), innerWidth - w - 8) })
  }, [at, mine])
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      <div
        ref={ref}
        role="dialog"
        aria-label="Message actions"
        style={pos}
        onClick={(e) => e.stopPropagation()}
        className={`rise fixed flex flex-col gap-2 ${mine ? 'items-end' : 'items-start'}`}
      >
        {children}
      </div>
    </div>
  )
}

function ReactionPill({ reacts, myId, onClick }: { reacts: Record<string, string>; myId: string; onClick: () => void }) {
  const counts = new Map<string, number>()
  for (const e of Object.values(reacts)) counts.set(e, (counts.get(e) ?? 0) + 1)
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Reactions: ${[...counts].map(([e, n]) => `${e} ${n}`).join(', ')}. Show who reacted`}
      className="relative -mt-1.5 mx-2 flex h-7 items-center gap-0.5 rounded-full bg-surface px-1 ring-2 ring-bg after:absolute after:-inset-2 after:content-['']"
    >
      {[...counts].map(([e, n]) => (
        <span key={e} className={`flex h-5 items-center rounded-full px-1 text-sm ${reacts[myId] === e ? 'bg-mine' : ''}`}>
          {e}
          {n > 1 && <span className="ml-0.5 text-xs font-medium tabular-nums">{n}</span>}
        </span>
      ))}
    </button>
  )
}

function Reactions({ talk, m, onClose }: { talk: Talk; m: Decrypted; onClose: () => void }) {
  const me = talk.me!
  const list = Object.entries(m.reacts ?? {}).sort(([a], [b]) => Number(b === me.user.id) - Number(a === me.user.id))
  return (
    <Sheet title="Reactions" onClose={onClose}>
      <ul className="flex flex-col gap-1">
        {list.map(([id, emoji]) => {
          const mine = id === me.user.id
          const inner = (
            <>
              <Avatar name={userName(me, id)} size={36} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{mine ? 'You' : userName(me, id)}</span>
                {mine && <span className="block text-xs text-mut">Tap to remove</span>}
              </span>
              <span className="text-2xl">{emoji}</span>
            </>
          )
          return (
            <li key={id}>
              {mine ? (
                <button onClick={() => { onClose(); talk.react(m, emoji).catch(() => {}) }} className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-2 text-left hover:bg-raised">
                  {inner}
                </button>
              ) : (
                <div className="flex min-h-14 items-center gap-3 px-2">{inner}</div>
              )}
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
}

export default function Chat({ talk, convId, onBack, onCall, onJoin, onAddPeople }: {
  talk: Talk
  convId: string
  onBack: () => void
  onCall?: (kind: CallKind) => void // unset while a call is on
  onJoin: () => void // the group call on in this chat, or back to it
  onAddPeople: () => void
}) {
  const me = talk.me!
  const conv = me.conversations.find((c) => c.id === convId)
  const list = talk.messages[convId] ?? []
  const queued = talk.pending.filter((p) => p.convId === convId)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState<string>()
  const [rec, setRec] = useState<Recording | null>(null)
  const [unsent, setUnsent] = useState<{ file: File; voice: Voice } | null>(null) // kept so a failed send isn't lost
  const [reply, setReply] = useState<Decrypted | null>(null)
  const [editing, setEditing] = useState<Decrypted | null>(null)
  const [menu, setMenu] = useState<{ m: Decrypted; at: DOMRect; mine: boolean } | null>(null)
  const [act, setAct] = useState<{ kind: 'delete' | 'forward' | 'report' | 'reactions'; m: Decrypted } | null>(null)
  const [info, setInfo] = useState(false)
  const recRef = useRef<Recording | null>(null)
  recRef.current = rec
  const starting = useRef(false)
  const scroller = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true) // pinned to the bottom?
  const olderFrom = useRef<number | null>(null) // scrollHeight before loading older
  const pressTimer = useRef(0)
  const pressed = useRef(false) // a long-press just opened the menu

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (olderFrom.current != null) {
      el.scrollTop += el.scrollHeight - olderFrom.current
      olderFrom.current = null
    } else if (stick.current) el.scrollTop = el.scrollHeight
  }, [list.length, queued.length, convId])

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
    setUnsent(null)
    setRec(null)
    setReply(null)
    setEditing(null)
    setMenu(null)
    setAct(null)
    setInfo(false)
    return () => recRef.current?.cancel()
  }, [convId])

  // The body fields that make a message a reply to `r`.
  const quote = (r: Decrypted | null) =>
    r ? { reply: { id: r.id, from: r.senderId, preview: preview(r.content, r.senderId === talk.me!.user.id).slice(0, 200) } } : undefined

  const sendVoice = useCallback(
    async (file: File, voice: Voice) => {
      setBusy(true)
      setError('')
      setUnsent(null)
      const r = reply
      setReply(null)
      stick.current = true
      try {
        await talk.sendWithFiles(convId, '', [file], voice, quote(r))
      } catch (err) {
        setReply(r)
        setUnsent({ file, voice })
        setError((err as Error).message || 'Could not send the voice message.')
      } finally {
        setBusy(false)
      }
    },
    [talk, convId, reply],
  )

  const stopAndSend = useCallback(async () => {
    const r = recRef.current
    if (!r) return
    recRef.current = null // a second tap (or the time limit) must not stop it twice
    setRec(null)
    const { blob, voice } = await r.stop()
    if (voice.duration < 0.7) return // a mis-tap, not a message
    await sendVoice(new File([blob], `Voice message.${blob.type.includes('webm') ? 'webm' : 'm4a'}`, { type: blob.type }), voice)
  }, [sendVoice])

  const cancelRec = useCallback(() => {
    recRef.current?.cancel()
    setRec(null)
  }, [])

  if (!conv) return null
  const name = convName(me, conv)

  const cancelCompose = () => {
    if (editing) setText('')
    setEditing(null)
    setReply(null)
  }
  const startReply = (m: Decrypted) => {
    cancelCompose()
    setReply(m)
    input.current?.focus()
  }
  const startEdit = (m: Decrypted) => {
    setReply(null)
    setEditing(m)
    setText(m.content!.text!)
    input.current?.focus()
  }

  const saveEdit = async (m: Decrypted, t: string) => {
    if (t === m.content?.text) return cancelCompose()
    setBusy(true)
    setError('')
    try {
      await talk.edit(m, t)
      setEditing(null)
      setText('')
    } catch (err) {
      setError((err as Error).message || 'Could not save the edit.')
    } finally {
      setBusy(false)
    }
  }

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const t = text.trim()
    if (editing) return t && !busy && saveEdit(editing, t)
    if ((!t && !files.length) || busy) return
    setBusy(true)
    setError('')
    const sending = { t: text, f: files, r: reply }
    setText('')
    setFiles([])
    setReply(null)
    stick.current = true
    try {
      if (sending.f.length) await talk.sendWithFiles(convId, t, sending.f, undefined, quote(sending.r))
      else await talk.send(convId, { text: t, ...quote(sending.r) })
    } catch (err) {
      setText(sending.t)
      setFiles(sending.f)
      setReply(sending.r)
      setError((err as Error).message || 'Could not send. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  const openMenu = (m: Decrypted, el: Element) => setMenu({ m, at: el.getBoundingClientRect(), mine: m.senderId === me.user.id })
  // Right-click on desktop; long-press on touch (iOS fires no contextmenu, Android does: both open the same menu).
  const menuHandlers = (m: Decrypted) => ({
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      if (getSelection()?.toString()) return // let the browser copy a selection
      e.preventDefault()
      openMenu(m, e.currentTarget)
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      pressed.current = false
      if (e.pointerType === 'mouse') return
      const el = e.currentTarget
      pressTimer.current = window.setTimeout(() => {
        pressed.current = true
        openMenu(m, el)
      }, 450)
    },
    onPointerUp: () => clearTimeout(pressTimer.current),
    onPointerCancel: () => clearTimeout(pressTimer.current),
    // The click that ends a long-press mustn't also open a photo or link.
    onClickCapture: (e: MouseEvent) => {
      if (!pressed.current) return
      pressed.current = false
      e.preventDefault()
      e.stopPropagation()
    },
  })

  const actions = (m: Decrypted, mine: boolean) => {
    const c = m.content
    const go = (f: () => void) => () => {
      setMenu(null)
      f()
    }
    return [
      c && { label: 'Reply', Icon: Reply, run: go(() => startReply(m)) },
      c?.text && { label: 'Copy', Icon: Copy, run: go(() => void navigator.clipboard.writeText(c.text!)) },
      (c?.text || c?.files) && { label: 'Forward', Icon: Forward, run: go(() => setAct({ kind: 'forward', m })) },
      mine && c?.text && Date.now() - m.createdAt < EDIT_MS && { label: 'Edit', Icon: Pencil, run: go(() => startEdit(m)) },
      mine
        ? { label: 'Delete', Icon: Trash, run: go(() => setAct({ kind: 'delete', m })), red: true }
        : { label: 'Report', Icon: Flag, run: go(() => setAct({ kind: 'report', m })), red: true },
    ].filter((x) => !!x)
  }

  // Scroll a reply's original into view and flash it, if it's loaded.
  const jump = (id: number) => {
    const el = document.getElementById(`m-${id}`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('flash')
    el.addEventListener('animationend', () => el.classList.remove('flash'), { once: true })
  }

  const typers = talk.typers[convId] ?? []
  // Receipt under my newest message: who has read up to it.
  const newest = list.findLast((m) => m.senderId === me.user.id && !m.content?.system)
  const readers = newest ? conv.members.filter((u) => u !== me.user.id && (conv.reads?.[u] ?? 0) >= newest.id) : []
  const receipt =
    conv.kind === 'dm' || !readers.length
      ? readers.length ? 'Read' : 'Sent'
      : readers.length > 2 ? `Read by ${readers.length}` : `Read by ${readers.map((u) => userName(me, u)).join(', ')}`
  const live = act && list.find((x) => x.id === act.m.id)

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && (reply || editing)) {
      e.stopPropagation()
      cancelCompose()
    }
    if (e.key === 'Enter' && !e.shiftKey && desktop()) {
      e.preventDefault()
      submit()
    }
  }
  const record = async () => {
    if (starting.current) return
    starting.current = true
    setError('')
    try {
      setRec(await startRecording())
    } catch (e) {
      setError(
        (e as Error).name === 'NotAllowedError'
          ? 'Microphone access is blocked. Allow it for this site in your browser settings.'
          : 'Couldn’t start the microphone.',
      )
    } finally {
      starting.current = false
    }
  }
  const empty = !text.trim() && !files.length

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
        <button onClick={() => setInfo(true)} aria-label={`${name}: chat info`} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-2xl px-1 text-left hover:bg-raised/60 md:px-2">
          <Avatar name={name} size={36} />
          <div className="min-w-0">
            <h2 className="truncate font-semibold leading-tight">{name}</h2>
            <p className={`truncate text-xs ${typers.length ? 'text-accent' : 'text-mut'}`}>
              {typers.length
                ? typingLabel(me, conv, typers)
                : conv.kind === 'group' ? conv.members.map((id) => userName(me, id)).join(', ') : 'End-to-end encrypted'}
            </p>
          </div>
        </button>
        <button onClick={() => onCall?.('audio')} disabled={!onCall} aria-label="Voice call" className={iconButton}>
          <Phone size={22} />
        </button>
        <button onClick={() => onCall?.('video')} disabled={!onCall} aria-label="Video call" className={iconButton}>
          <Video size={24} />
        </button>
      </header>
      {conv.call && (
        <button onClick={onJoin} className="flex min-h-11 items-center gap-2.5 border-t border-line bg-surface px-4 py-1.5 text-left text-sm">
          {conv.call.kind === 'audio' ? <Phone size={16} /> : <Video size={18} />}
          <span className="min-w-0 flex-1 truncate">
            Group {conv.call.kind === 'audio' ? 'voice' : 'video'} call · {conv.call.peers.length} {conv.call.peers.length === 1 ? 'person' : 'people'}
          </span>
          <span className="shrink-0 rounded-full bg-fill px-3.5 py-1.5 font-semibold text-on-fill">
            {conv.call.peers.includes(me.user.id) ? 'Return to call' : 'Join'}
          </span>
        </button>
      )}

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
          const system = m.content?.system && !m.forged
          const first = newDay || prev.senderId !== m.senderId || m.createdAt - prev.createdAt > RUN_GAP || !!prev.content?.system
          const last =
            !next ||
            next.senderId !== m.senderId ||
            next.createdAt - m.createdAt > RUN_GAP ||
            new Date(next.createdAt).toDateString() !== new Date(m.createdAt).toDateString() ||
            !!next.content?.system
          return (
            <div key={m.id} id={`m-${m.id}`} className={`flex flex-col rounded-xl ${first ? 'mt-3' : 'mt-0.5'}`}>
              {newDay && <div className="mb-2 mt-3 self-center text-xs font-medium text-mut">{dayLabel(m.createdAt)}</div>}
              {system ? (
                <p className="mx-6 my-1 self-center text-center text-xs text-mut">{m.content!.text}</p>
              ) : (
                <>
                  {first && !mine && conv.kind === 'group' && <div className="mb-1 ml-3 text-xs font-medium text-mut">{userName(me, m.senderId)}</div>}
                  <div
                    {...menuHandlers(m)}
                    className={`group relative ${column} ${mine ? 'items-end self-end' : 'items-start self-start'} [-webkit-touch-callout:none] pointer-coarse:select-none`}
                  >
                    <Bubble m={m} mine={mine} first={first} last={last} talk={talk} onCall={onCall} onZoom={setZoom} onJump={jump} />
                    {m.reacts && Object.keys(m.reacts).length > 0 && (
                      <ReactionPill reacts={m.reacts} myId={me.user.id} onClick={() => setAct({ kind: 'reactions', m })} />
                    )}
                    <button
                      type="button"
                      onClick={(e) => openMenu(m, e.currentTarget.parentElement!)}
                      aria-label="Message actions"
                      className={`absolute top-1/2 ${mine ? 'right-full mr-1' : 'left-full ml-1'} flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-mut opacity-0 hover:bg-raised focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:hidden`}
                    >
                      <More size={18} />
                    </button>
                  </div>
                  {(last || m.editedAt || m.id === newest?.id) && (
                    <div className={`mt-1 px-2 text-xs text-mut ${mine ? 'self-end' : 'self-start'}`}>
                      {m.editedAt ? 'Edited · ' : ''}
                      <time className="tabular-nums">{new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
                      {m.id === newest?.id && ` · ${receipt}`}
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
        {queued.map((p) => (
          <div key={p.cid} className="mt-0.5 flex flex-col">
            {p.content.system ? (
              <p className="mx-6 my-1 self-center text-center text-xs text-mut">{p.content.text}</p>
            ) : (
              <div className={`${column} self-end`}>
                <Bubble
                  m={{ id: 0, convId, senderId: me.user.id, body: p.body, createdAt: p.createdAt, content: p.content, forged: false }}
                  mine first last talk={talk} onZoom={setZoom}
                />
              </div>
            )}
            {p.sending ? (
              <span className="mt-1 self-end px-2 text-xs text-mut" aria-live="polite">Sending…</span>
            ) : (
              <div className="flex items-center gap-1 self-end">
                {p.error ? (
                  <>
                    <span className="pl-2 text-xs text-danger" role="alert">{p.error}</span>
                    <button type="button" onClick={() => talk.retry(p)} className="min-h-11 rounded-full px-3 text-sm font-semibold text-accent hover:bg-raised">
                      Retry
                    </button>
                  </>
                ) : (
                  <span className="pl-2 text-xs text-mut" aria-live="polite">Waiting for connection</span>
                )}
                <button type="button" onClick={() => talk.discard(p)} className="min-h-11 rounded-full px-3 text-sm text-mut hover:bg-raised">
                  Discard
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <form onSubmit={submit} className="pb-safe bg-surface px-2 pt-2">
        {error && (
          <div className="flex items-center gap-1 pb-2 pl-3">
            <p className="flex-1 text-sm text-danger" role="alert">
              {error}
            </p>
            {unsent && (
              <>
                <button type="button" onClick={() => sendVoice(unsent.file, unsent.voice)} className="min-h-11 rounded-full px-3 text-sm font-semibold text-accent hover:bg-raised">
                  Retry
                </button>
                <button type="button" onClick={() => { setUnsent(null); setError('') }} className="min-h-11 rounded-full px-3 text-sm text-mut hover:bg-raised">
                  Discard
                </button>
              </>
            )}
          </div>
        )}
        {(reply || editing) && (
          <div className="flex items-center gap-2 pb-2 pl-3">
            <div className="min-w-0 flex-1 border-l-[3px] border-accent pl-3">
              <p className="text-sm font-semibold">
                {editing ? 'Editing' : reply!.senderId === me.user.id ? 'You' : userName(me, reply!.senderId)}
              </p>
              <p className="truncate text-sm text-mut">{preview((editing ?? reply)!.content, (editing ?? reply)!.senderId === me.user.id)}</p>
            </div>
            <button type="button" onClick={cancelCompose} aria-label={editing ? 'Cancel editing' : 'Cancel reply'} className={`${iconButton} text-mut`}>
              <Close size={18} />
            </button>
          </div>
        )}
        {files.length > 0 && !editing && (
          <ul className="flex gap-2 overflow-x-auto px-1 pb-2" aria-label="Files to send">
            {files.map((f, i) => (
              <FileChip key={i} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
            ))}
          </ul>
        )}
        {rec ? (
          <VoiceRecorder rec={rec} onCancel={cancelRec} onSend={stopAndSend} />
        ) : (
          <div className="flex items-end gap-1">
            {!editing && (
              <button type="button" onClick={() => fileInput.current?.click()} aria-label="Attach photos or files" className={`${iconButton} text-mut`}>
                <Clip size={22} />
              </button>
            )}
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { setFiles((f) => [...f, ...(e.target.files ?? [])]); e.target.value = '' }} />
            <textarea
              ref={input}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                if (!editing && e.target.value.trim()) talk.typing(convId)
              }}
              onKeyDown={onKey}
              onPaste={onPaste}
              rows={1}
              placeholder="Message"
              aria-label="Message"
              className="max-h-40 min-h-11 flex-1 resize-none rounded-[22px] bg-bg px-4 py-2.5 [field-sizing:content] focus-visible:outline-offset-0"
            />
            {/* Empty composer: the send spot becomes the mic, as in iMessage and WhatsApp. */}
            {editing ? (
              <button disabled={busy || !text.trim()} aria-label="Save edit" className="pressable ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fill text-on-fill transition-opacity disabled:opacity-35">
                <Check size={20} />
              </button>
            ) : empty && canRecord() ? (
              <button type="button" onClick={record} disabled={busy} aria-label="Record voice message" className="pressable ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fill text-on-fill transition-opacity disabled:opacity-35">
                <Mic size={20} />
              </button>
            ) : (
              <button disabled={busy || empty} aria-label="Send" className="pressable ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fill text-on-fill transition-opacity disabled:opacity-35">
                <Send size={18} />
              </button>
            )}
          </div>
        )}
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

      {menu && (
        <MessageMenu at={menu.at} mine={menu.mine} onClose={() => setMenu(null)}>
          {menu.m.content && (
            <div className="flex rounded-full bg-surface p-1 shadow-lg ring-1 ring-line">
              {EMOJI.map((e, i) => {
                const picked = menu.m.reacts?.[me.user.id] === e
                return (
                  <button
                    key={e}
                    autoFocus={i === 0}
                    onClick={() => {
                      setMenu(null)
                      talk.react(menu.m, e).catch((err: Error) => setError(err.message))
                    }}
                    aria-label={`React with ${e}`}
                    aria-pressed={picked}
                    className={`pressable flex h-11 w-11 items-center justify-center rounded-full text-2xl ${picked ? 'bg-mine' : 'hover:bg-raised'}`}
                  >
                    {e}
                  </button>
                )
              })}
            </div>
          )}
          <ul className="min-w-52 rounded-2xl bg-surface py-1 shadow-lg ring-1 ring-line">
            {actions(menu.m, menu.mine).map(({ label, Icon, run, red }) => (
              <li key={label}>
                <button onClick={run} className={`flex min-h-11 w-full items-center justify-between gap-6 px-4 text-left hover:bg-raised ${red ? 'text-danger' : ''}`}>
                  {label}
                  <Icon size={18} />
                </button>
              </li>
            ))}
          </ul>
        </MessageMenu>
      )}

      {info && <ChatInfo talk={talk} convId={convId} onClose={() => setInfo(false)} onCall={onCall} onAddPeople={onAddPeople} />}
      {act?.kind === 'delete' && (
        <Confirm
          title="Delete for everyone?"
          body="This message will disappear for everyone in this chat."
          action="Delete"
          onConfirm={() => talk.unsend(act.m)}
          onClose={() => setAct(null)}
        />
      )}
      {act?.kind === 'forward' && <ForwardSheet talk={talk} m={act.m} onClose={() => setAct(null)} />}
      {act?.kind === 'report' && <Report talk={talk} userId={act.m.senderId} convId={convId} quote={act.m.content?.text} onClose={() => setAct(null)} />}
      {act?.kind === 'reactions' && live?.reacts && Object.keys(live.reacts).length > 0 && (
        <Reactions talk={talk} m={live} onClose={() => setAct(null)} />
      )}
    </div>
  )
}
