// Settings > Agents: link a helper (talkline), check and Allow a pending one, then Pause or Remove it.
import { useEffect, useState, type ReactNode } from 'react'
import type { Agent, Conversation } from '../../shared/types.ts'
import { checkAgent, linkSecret, type Talk } from '../lib/useTalk.ts'
import { api } from '../lib/api.ts'
import { shortTime } from '../lib/format.ts'
import { AiBadge, Avatar } from './Sidebar.tsx'
import { CopyLink, danger, primary, SafetyCode, useSubmit } from './Sheets.tsx'
import { Pause, Play } from './icons.tsx'

type Run = (f: () => Promise<unknown>) => void

// The pair hint, one argument a piece: a line breaks only between arguments, never inside a flag or the quoted name.
const PAIR = ['node', 'talkline/cli.ts', 'pair', `'<link>'`, '--name', `'Claude AI'`]

// Deny and Remove are one call. The server's sync reloads `me`, which drops the row.
async function remove(a: Agent) {
  await api('DELETE', `/api/agents/${a.id}`)
  localStorage.removeItem(linkSecret(a.invite))
}

function Who({ a, children }: { a: Agent; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <Avatar name={a.name} size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center font-medium">
          <span className="truncate">{a.name}</span>
          <AiBadge />
        </div>
        <div className="truncate text-sm text-mut">{children}</div>
      </div>
    </div>
  )
}

// Waiting for Allow. Only the browser that made the link holds the secret the helper's proof is checked with.
function Pending({ talk, a, busy, run }: { talk: Talk; a: Agent; busy: boolean; run: Run }) {
  const [check, setCheck] = useState<'no secret' | 'bad proof' | 'ok'>()
  useEffect(() => void checkAgent(a).then(setCheck, () => setCheck('no secret')), [a])
  const deny = <button onClick={() => run(() => remove(a))} disabled={busy} className={danger}>Deny</button>
  return (
    <li className="py-2">
      <Who a={a}>{a.where}</Who>
      {check === 'ok' ? (
        <>
          <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-2.5">
            <span className="text-sm text-mut">Safety code</span>
            <SafetyCode pubkey={a.pubkey} />
          </div>
          <p className="mt-2 text-sm text-mut">Allow only if this matches the code talkline printed. No code printed? Deny.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button onClick={() => run(() => talk.allowAgent(a))} disabled={busy} className={primary}>Allow</button>
            {deny}
          </div>
        </>
      ) : (
        check && (
          <>
            <p className="mb-3 mt-2 text-sm text-mut">
              {check === 'no secret' ? 'Made in another browser. Deny it, then make a new link here.' : 'This helper didn’t prove it has your link. Deny it.'}
            </p>
            {deny}
          </>
        )
      )}
    </li>
  )
}

// Allowed: its DM with me exists. Pause mutes that DM, which the server reads as no pushes and no rings.
function Helper({ talk, a, dm, busy, run }: { talk: Talk; a: Agent; dm: Conversation; busy: boolean; run: Run }) {
  const small = 'pressable flex min-h-9 items-center gap-1.5 rounded-full bg-raised px-3.5 text-sm font-semibold disabled:opacity-40'
  return (
    <li className="py-2">
      {/* a long host name gives way, so the time always shows */}
      <Who a={a}>
        {dm.muted ? 'Paused · can’t buzz you' : (
          <span className="flex">
            <span className="truncate">{a.where}</span>
            <span className="shrink-0 whitespace-pre">{` · ${a.activeAt ? `last message ${shortTime(a.activeAt)}` : 'no messages yet'}`}</span>
          </span>
        )}
      </Who>
      <div className="mt-2 flex gap-2 pl-13">
        <button onClick={() => run(() => talk.setMine(dm.id, { muted: !dm.muted }))} disabled={busy} className={small}>
          {dm.muted ? <><Play size={14} /> Resume</> : <><Pause size={14} /> Pause</>}
        </button>
        <button onClick={() => run(() => remove(a))} disabled={busy} className={`${small} text-danger`}>Remove</button>
      </div>
    </li>
  )
}

export default function Agents({ talk }: { talk: Talk }) {
  const me = talk.me!
  const agents = me.agents ?? []
  const [made, setMade] = useState<{ code: string; link: string; expiresAt: number }>()
  const { busy, error, run } = useSubmit(undefined, 'That didn’t work. Try again.')
  // The link works once: its box goes when its helper shows up, pending or allowed.
  useEffect(() => {
    if (made && agents.some((a) => a.invite === made.code)) setMade(undefined)
  }, [made, agents])
  const link = () => run(async () => setMade(await talk.linkAgent()))

  return (
    <section className="mb-7">
      <h3 className="mb-2 font-semibold">Agents</h3>
      {agents.length ? (
        <ul className="mb-3 flex flex-col gap-2">
          {agents.map((a) => {
            const dm = me.conversations.find((c) => c.kind === 'dm' && c.members.includes(a.id))
            return dm ? <Helper key={a.id} talk={talk} a={a} dm={dm} busy={busy} run={run} /> : <Pending key={a.id} talk={talk} a={a} busy={busy} run={run} />
          })}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-mut">Let Claude Code and your scripts text you here. Each helper gets its own key, and only you can see it.</p>
      )}
      <button onClick={link} disabled={busy} className={primary}>Link a helper</button>
      {made && (
        <>
          {/* Copy only: never the share sheet, since the link's fragment holds the secret. */}
          <CopyLink key={made.link} link={made.link} />
          <p className="mt-2 text-sm text-mut">Works once, until {new Date(made.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>
          <p className="mt-1 text-sm text-mut">
            On your Mac:{' '}
            <span className="font-mono">{PAIR.flatMap((w, i) => [i ? ' ' : '', <span key={w} className="whitespace-nowrap">{w}</span>])}</span>
          </p>
        </>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
      <p className="mt-2 text-sm text-mut">
        Helpers ring only 08:00–22:00 {Intl.DateTimeFormat().resolvedOptions().timeZone} time (this browser’s zone), at most once every 10 minutes
        and 6 times a day.
      </p>
    </section>
  )
}
