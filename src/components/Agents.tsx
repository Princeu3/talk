// Settings > Agents: link a helper (talkline), check and Allow a pending one, then Pause or Remove it.
import { useEffect, useState, type ReactNode } from 'react'
import type { Agent, Conversation } from '../../shared/types.ts'
import type { Talk } from '../lib/useTalk.ts'
import { api } from '../lib/api.ts'
import { shortTime } from '../lib/format.ts'
import { AiBadge, Avatar } from './Sidebar.tsx'
import { danger, primary, SafetyCode } from './Sheets.tsx'
import { Pause, Play } from './icons.tsx'

type Run = (f: () => Promise<unknown>) => void

// Deny and Remove are one call. The server's sync reloads `me`, which drops the row.
async function remove(a: Agent) {
  await api('DELETE', `/api/agents/${a.id}`)
  localStorage.removeItem(`talk:agent-link:${a.invite}`)
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
  const { checkAgent } = talk
  useEffect(() => void checkAgent(a).then(setCheck, () => setCheck('no secret')), [checkAgent, a])
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
      <Who a={a}>
        {dm.muted ? 'Paused · can’t buzz you' : `${a.where} · ${a.activeAt ? `last message ${shortTime(a.activeAt)}` : 'no messages yet'}`}
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
  const [made, setMade] = useState<{ link: string; expiresAt: number }>()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run: Run = async (f) => {
    setBusy(true)
    setError('')
    try {
      await f()
    } catch (e) {
      setError((e as Error).message || 'That didn’t work. Try again.')
    } finally {
      setBusy(false)
    }
  }
  const link = () =>
    run(async () => {
      setMade(await talk.linkAgent())
      setCopied(false)
    })
  // Copy only: never the share sheet, since the link's fragment holds the secret.
  const copy = async () => {
    await navigator.clipboard.writeText(made!.link)
    setCopied(true)
  }

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
          <div className="mt-2 flex items-center gap-2 rounded-2xl bg-surface py-2 pl-4 pr-2">
            <span className="min-w-0 flex-1 select-all truncate text-sm">{made.link}</span>
            <button onClick={copy} className="min-h-11 shrink-0 rounded-full px-3 text-sm font-semibold text-accent hover:bg-raised">{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <p className="mt-2 text-sm text-mut">Works once, until {new Date(made.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>
          <p className="mt-1 text-sm text-mut">
            On your Mac: <span className="break-all font-mono">{`node talkline/cli.ts pair '<link>' --name 'Claude AI'`}</span>
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
