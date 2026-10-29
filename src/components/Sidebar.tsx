import type { Talk } from '../lib/useTalk.ts'
import { convName, initials, preview, shortTime, userName } from '../lib/format.ts'
import { Compose, Lock, User } from './icons.tsx'

export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  // Stable hue per name so each person keeps a color.
  const hue = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7)
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.38, background: `oklch(0.55 0.12 ${hue})` }}
      aria-hidden
    >
      {initials(name)}
    </div>
  )
}

export const iconButton = 'pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-accent hover:bg-raised'

export default function Sidebar({ talk, onNew, onSettings }: { talk: Talk; onNew: () => void; onSettings: () => void }) {
  const me = talk.me!
  return (
    <div className="flex h-full flex-col">
      <header className="pt-safe px-2">
        <div className="flex items-center justify-between">
          <button onClick={onSettings} aria-label="Settings and invites" className={iconButton}>
            <User size={24} />
          </button>
          <button onClick={onNew} aria-label="New chat" className={iconButton}>
            <Compose size={22} />
          </button>
        </div>
        <h1 className="px-3 pb-2 pt-1 text-[2rem] font-bold leading-tight tracking-tight">Chats</h1>
      </header>
      <nav aria-label="Chats" className="pb-safe flex-1 overflow-y-auto px-2">
        {me.conversations.length === 0 && (
          <div className="flex flex-col items-start gap-3 px-3 py-6">
            <p className="text-mut">
              {me.users.length > 1
                ? 'Start a chat with someone here.'
                : 'Nobody else is here yet. Create an invite link in Settings and send it to a friend.'}
            </p>
            <button onClick={me.users.length > 1 ? onNew : onSettings} className="pressable rounded-full bg-fill px-5 py-2.5 font-semibold text-white">
              {me.users.length > 1 ? 'New chat' : 'Invite someone'}
            </button>
          </div>
        )}
        <ul>
          {me.conversations.map((conv) => {
            const name = convName(me, conv)
            const last = talk.messages[conv.id]?.at(-1)
            const active = conv.id === talk.activeId
            const text = preview(last?.content)
            const who = !last ? '' : last.senderId === me.user.id ? 'You: ' : conv.kind === 'group' ? `${userName(me, last.senderId)}: ` : ''
            return (
              <li key={conv.id}>
                <button
                  onClick={() => talk.open(conv.id)}
                  aria-current={active ? 'true' : undefined}
                  className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors duration-150 ${active ? 'bg-raised' : 'hover:bg-raised/60 active:bg-raised'}`}
                >
                  <Avatar name={name} size={48} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={`truncate ${conv.unread ? 'font-semibold' : 'font-medium'}`}>{name}</span>
                      {conv.lastMessageAt && (
                        <time className={`shrink-0 text-xs tabular-nums ${conv.unread ? 'font-semibold text-accent' : 'text-mut'}`}>
                          {shortTime(conv.lastMessageAt)}
                        </time>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <span className={`line-clamp-2 text-sm leading-snug ${conv.unread ? 'text-ink' : 'text-mut'}`}>
                        {last && !last.content ? (
                          <span className="inline-flex items-center gap-1"><Lock size={12} /> Encrypted message</span>
                        ) : text ? (
                          who + text
                        ) : conv.kind === 'group' ? (
                          `${conv.members.length} people`
                        ) : (
                          'No messages yet'
                        )}
                      </span>
                      {conv.unread > 0 && (
                        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-fill px-1.5 text-xs font-semibold tabular-nums text-white">
                          <span className="sr-only">Unread: </span>
                          {conv.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}
