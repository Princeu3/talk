import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { api } from './lib/api.ts'
import { clearIdentity, loadIdentity, type StoredIdentity } from './lib/keystore.ts'
import { pushSupported, subscribe } from './lib/push.ts'
import { useTalk } from './lib/useTalk.ts'
import { useCall } from './lib/useCall.ts'
import { userName } from './lib/format.ts'
import Auth from './components/Auth.tsx'
import Sidebar from './components/Sidebar.tsx'
import Chat from './components/Chat.tsx'
import { AddPeople, NewChat, Settings } from './components/Sheets.tsx'
import { CallAudio, CallBar, CallScreen } from './components/Call.tsx'
import { Lock } from './components/icons.tsx'
import type { CallKind } from '../shared/types.ts'

export default function App() {
  const [ident, setIdent] = useState<StoredIdentity | null>()
  useEffect(() => void loadIdentity().then((i) => setIdent(i ?? null), () => setIdent(null)), [])

  const signOut = useCallback(async () => {
    await clearIdentity()
    await api('POST', '/api/logout').catch(() => {})
    setIdent(null)
  }, [])

  if (ident === undefined) return null
  if (!ident) return <Auth invite={new URLSearchParams(location.search).get('invite')} onDone={setIdent} />
  return <Main key={ident.userId} ident={ident} onSignOut={signOut} />
}

function Main({ ident, onSignOut }: { ident: StoredIdentity; onSignOut: () => void }) {
  const talk = useTalk(ident.privateKey, onSignOut)
  const [sheet, setSheet] = useState<'new' | 'settings' | 'add' | null>(null)
  const { open, me, send } = talk
  const calls = useCall(useCallback((convId, kind, ms) => void send(convId, { call: { kind, ms } }, true).catch(() => {}), [send]))
  const { call } = calls
  const [minimized, setMinimized] = useState(false)
  useEffect(() => {
    if (!call) setMinimized(false)
  }, [call])

  // A tapped notification opens its conversation: ?c= on cold start, a
  // service-worker message when the app was already running.
  useEffect(() => {
    const c = new URLSearchParams(location.search).get('c')
    if (c) {
      open(c)
      history.replaceState(null, '', '/')
    }
    const onMsg = (e: MessageEvent) => e.data?.convId && open(e.data.convId)
    navigator.serviceWorker?.addEventListener('message', onMsg)
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg)
  }, [open])

  // Re-register this device's push subscription each launch (cheap, idempotent).
  const vapid = me?.vapidPublicKey
  useEffect(() => {
    if (vapid && pushSupported() && Notification.permission === 'granted') subscribe(vapid).catch(() => {})
  }, [vapid])

  if (!me)
    return (
      <div className="flex h-full items-center justify-center text-mut">
        <Lock /> <span className="ml-2">Unlocking…</span>
      </div>
    )

  const startCall = (kind: CallKind) => {
    const conv = me.conversations.find((c) => c.id === talk.activeId)
    const peer = conv?.members.find((u) => u !== me.user.id)
    if (conv && peer) calls.start(conv.id, peer, kind)
  }
  const callName = call ? userName(me, call.peer) : ''
  const bar = call && minimized && call.phase !== 'incoming'

  return (
    <div className="flex h-full flex-col">
      {bar && <CallBar call={call} name={callName} calls={calls} onExpand={() => setMinimized(false)} />}
      {/* the bar already clears the notch, so the headers below it don't */}
      <div className="flex min-h-0 flex-1" style={bar ? ({ '--safe-top': '0px' } as CSSProperties) : undefined}>
        <aside className={`${talk.activeId ? 'hidden' : 'flex'} w-full flex-col md:flex md:w-[22rem] md:shrink-0 md:bg-surface`}>
          <Sidebar talk={talk} onNew={() => setSheet('new')} onSettings={() => setSheet('settings')} />
        </aside>
        <main className={`${talk.activeId ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col md:flex`}>
          {talk.activeId ? (
            <Chat
              talk={talk}
              convId={talk.activeId}
              onBack={() => open(null)}
              onCall={call ? undefined : startCall}
              onAddPeople={() => setSheet('add')}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center text-mut">
              <Lock size={28} />
              <p className="max-w-xs">Pick a chat. Messages, files and calls are encrypted on your devices.</p>
            </div>
          )}
        </main>
      </div>

      {sheet === 'new' && <NewChat talk={talk} onClose={() => setSheet(null)} onOpen={(id) => { setSheet(null); open(id) }} />}
      {sheet === 'add' && talk.activeId && <AddPeople talk={talk} convId={talk.activeId} onClose={() => setSheet(null)} />}
      {sheet === 'settings' && <Settings talk={talk} onClose={() => setSheet(null)} onSignOut={onSignOut} />}

      {call && !bar && (
        <CallScreen
          call={call}
          name={callName}
          calls={calls}
          onMinimize={() => {
            open(call.convId)
            setMinimized(true)
          }}
        />
      )}
      <CallAudio stream={call?.remote} />
    </div>
  )
}
