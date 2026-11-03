import { useState, type FormEvent, type ReactNode } from 'react'
import type { Talk } from '../lib/useTalk.ts'
import type { CallKind } from '../../shared/types.ts'
import { convName, userName } from '../lib/format.ts'
import { Avatar } from './Sidebar.tsx'
import { Confirm, danger, primary, Report, SafetyCode, Sheet } from './Sheets.tsx'
import { Ban, BellOff, Flag, Lock, LogOut, Pencil, Phone, Pin, UserPlus, Video } from './icons.tsx'

const row = 'flex min-h-12 w-full items-center gap-3 rounded-2xl px-2 text-left font-medium hover:bg-raised'

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
export default function ChatInfo({ talk, convId, onClose, onCall, onAddPeople }: {
  talk: Talk
  convId: string
  onClose: () => void
  onCall?: (kind: CallKind) => void // unset while a call is on
  onAddPeople: () => void
}) {
  const me = talk.me!
  const conv = me.conversations.find((c) => c.id === convId)
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
      ) : (
        <section className="mb-5 px-2">
          <h4 className="text-sm font-semibold text-mut">Safety code</h4>
          <SafetyCode pubkey={user(other)!.pubkey} />
          <p className="mt-1 text-sm text-mut">
            Compare it with the code {name} sees for themselves in Settings, in person or on a call. If they match, nobody swapped a key.
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
      ) : (
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
