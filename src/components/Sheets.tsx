import { useEffect, useState, type ReactNode } from 'react'
import type { Talk } from '../lib/useTalk.ts'
import { api } from '../lib/api.ts'
import { safetyCode } from '../lib/crypto.ts'
import { enablePush, needsInstall, pushSupported } from '../lib/push.ts'
import { Avatar } from './Sidebar.tsx'
import { loadTheme, setTheme, type Theme } from '../lib/theme.ts'
import { Close, Monitor, Moon, Sun } from './icons.tsx'

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="rise pb-safe flex max-h-[85dvh] w-full flex-col rounded-t-3xl bg-bg sm:max-w-md sm:rounded-3xl"
      >
        <header className="flex items-center justify-between px-5 pb-1 pt-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="pressable -mr-2 flex h-11 w-11 items-center justify-center rounded-full text-mut hover:bg-raised">
            <Close size={18} />
          </button>
        </header>
        <div className="overflow-y-auto px-5 pb-4">{children}</div>
      </div>
    </div>
  )
}

const primary = 'pressable min-h-12 w-full rounded-full bg-fill px-5 font-semibold text-on-fill disabled:opacity-40'

function PeoplePicker({ ids, picked, onToggle, talk }: { ids: string[]; picked: Set<string>; onToggle: (id: string) => void; talk: Talk }) {
  if (!ids.length) return <p className="py-6 text-mut">Nobody else to add yet. Create an invite link in Settings.</p>
  return (
    <div className="flex flex-col gap-1">
      {ids.map((id) => {
        const name = talk.me!.users.find((u) => u.id === id)!.name
        return (
          <label key={id} className="flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl px-2 hover:bg-raised">
            <Avatar name={name} size={36} />
            <span className="flex-1 font-medium">{name}</span>
            <input type="checkbox" checked={picked.has(id)} onChange={() => onToggle(id)} className="h-5 w-5 accent-[var(--color-accent)]" />
          </label>
        )
      })}
    </div>
  )
}

const toggle = (s: Set<string>, id: string) => {
  const n = new Set(s)
  if (n.has(id)) n.delete(id)
  else n.add(id)
  return n
}

export function NewChat({ talk, onClose, onOpen }: { talk: Talk; onClose: () => void; onOpen: (id: string) => void }) {
  const me = talk.me!
  const [picked, setPicked] = useState(new Set<string>())
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const group = picked.size > 1

  const create = async () => {
    setBusy(true)
    try {
      onOpen(await talk.createConversation([...picked], title.trim()))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Sheet title="New chat" onClose={onClose}>
      <PeoplePicker talk={talk} ids={me.users.filter((u) => u.id !== me.user.id).map((u) => u.id)} picked={picked} onToggle={(id) => setPicked(toggle(picked, id))} />
      {group && (
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Group name"
          maxLength={32}
          aria-label="Group name"
          className="mt-3 min-h-12 w-full rounded-2xl bg-surface px-4"
        />
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <button onClick={create} disabled={busy || !picked.size || (group && !title.trim())} className={`${primary} mt-4`}>
        {group ? 'Create group' : 'Message'}
      </button>
    </Sheet>
  )
}

export function AddPeople({ talk, convId, onClose }: { talk: Talk; convId: string; onClose: () => void }) {
  const me = talk.me!
  const conv = me.conversations.find((c) => c.id === convId)!
  const [picked, setPicked] = useState(new Set<string>())
  const [busy, setBusy] = useState(false)
  const add = async () => {
    setBusy(true)
    for (const id of picked) await talk.addMember(convId, id)
    onClose()
  }
  return (
    <Sheet title="Add people" onClose={onClose}>
      <p className="mb-3 text-sm text-mut">New members can read the whole history of this group.</p>
      <PeoplePicker talk={talk} ids={me.users.filter((u) => !conv.members.includes(u.id)).map((u) => u.id)} picked={picked} onToggle={(id) => setPicked(toggle(picked, id))} />
      <button onClick={add} disabled={busy || !picked.size} className={`${primary} mt-4`}>Add</button>
    </Sheet>
  )
}

const themes = [
  ['system', 'System', Monitor],
  ['light', 'Light', Sun],
  ['dark', 'Dark', Moon],
] as const

// Segmented control built on radios, so arrow keys and screen readers work for free.
function ThemePicker() {
  const [theme, set] = useState<Theme>(loadTheme)
  return (
    <fieldset>
      <legend className="sr-only">Theme</legend>
      <div className="flex gap-1 rounded-full bg-raised p-1">
        {themes.map(([value, label, Icon]) => (
          <label
            key={value}
            className="pressable flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full text-sm font-medium text-mut has-checked:bg-mine has-checked:font-semibold has-checked:text-ink has-focus-visible:outline-2 has-focus-visible:outline-accent"
          >
            <input
              type="radio"
              name="theme"
              value={value}
              checked={theme === value}
              onChange={() => {
                set(value)
                setTheme(value)
              }}
              className="sr-only"
            />
            <Icon size={16} />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function SafetyCode({ pubkey }: { pubkey: string }) {
  const [code, setCode] = useState('')
  useEffect(() => void safetyCode(pubkey).then(setCode), [pubkey])
  return <span className="font-mono text-sm tracking-wider text-mut">{code}</span>
}

export function Settings({ talk, onClose, onSignOut }: { talk: Talk; onClose: () => void; onSignOut: () => void }) {
  const me = talk.me!
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [push, setPush] = useState(pushSupported() ? Notification.permission : 'unsupported')

  const invite = async () => {
    const { code } = await api<{ code: string }>('POST', '/api/invites')
    const url = `${location.origin}/?invite=${code}`
    setLink(url)
    if (navigator.share) navigator.share({ title: 'Join me on Talk', url }).catch(() => {})
  }
  const copy = async () => {
    await navigator.clipboard.writeText(link)
    setCopied(true)
  }

  return (
    <Sheet title="Settings" onClose={onClose}>
      <section className="mb-7">
        <h3 className="mb-2 font-semibold">Invite someone</h3>
        <button onClick={invite} className={primary}>Create invite link</button>
        {link && (
          <div className="mt-2 flex items-center gap-2 rounded-2xl bg-surface py-2 pl-4 pr-2">
            <span className="min-w-0 flex-1 select-all truncate text-sm">{link}</span>
            <button onClick={copy} className="min-h-11 shrink-0 rounded-full px-3 text-sm font-semibold text-accent hover:bg-raised">{copied ? 'Copied' : 'Copy'}</button>
          </div>
        )}
        <p className="mt-2 text-sm text-mut">The link works once and expires in 7 days. Send it over a channel you trust.</p>
      </section>

      <section className="mb-7">
        <h3 className="mb-2 font-semibold">Notifications</h3>
        {push === 'granted' ? (
          <p className="text-sm text-mut">On for this device.</p>
        ) : push === 'unsupported' || needsInstall() ? (
          <p className="text-sm text-mut">
            On iPhone, tap Share then <b>Add to Home Screen</b>, open Talk from there, and turn notifications on here.
          </p>
        ) : push === 'denied' ? (
          <p className="text-sm text-mut">Blocked. Allow notifications for this site in your browser settings.</p>
        ) : (
          <button onClick={async () => setPush((await enablePush(me.vapidPublicKey)) ? 'granted' : Notification.permission)} className={primary}>
            Turn on notifications
          </button>
        )}
      </section>

      <section className="mb-7">
        <h3 className="mb-2 font-semibold">Appearance</h3>
        <ThemePicker />
        <p className="mt-2 text-sm text-mut">System follows your device's light or dark setting.</p>
      </section>

      <section className="mb-7">
        <h3 className="mb-1 font-semibold">Safety codes</h3>
        <p className="mb-3 text-sm text-mut">Compare these in person or on a call. If they match on both phones, nobody swapped a key.</p>
        {me.users.map((u) => (
          <div key={u.id} className="flex items-center gap-3 py-1.5">
            <Avatar name={u.name} size={32} />
            <span className="flex-1 font-medium">{u.id === me.user.id ? `${u.name} (you)` : u.name}</span>
            <SafetyCode pubkey={u.pubkey} />
          </div>
        ))}
      </section>

      <button onClick={onSignOut} className="pressable min-h-12 w-full rounded-full bg-raised px-5 font-semibold text-danger">
        Sign out of this device
      </button>
    </Sheet>
  )
}
