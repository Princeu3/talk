# talkline

talkline lets Claude Code reach you on Talk. It pairs as your helper: a Talk account that only you can see or message, named "Claude AI" unless you pick another name. It texts you, asks you yes/no questions, and can ring your phone once. Everything is end-to-end encrypted with Talk's own crypto (`src/lib/crypto.ts`).

This is Phase 1: the helper has its own key and an AI badge in Talk, and you can pause or remove it there.

Run it with Node 24 or later from anywhere: `node /path/to/Messaging/talkline/cli.ts <command>`. Any error exits 3.

## Pair

In Talk on the web, open Settings > Agents > Link a helper, and copy the link. Then:

```
node talkline/cli.ts pair '<agent link>' [--name 'Claude AI']
```

Keep the single quotes: the link holds `&` and `#`, and the shell cuts it at them. The link works once, for 10 minutes. Helper names end in " AI".

`pair` prints a safety code and waits. Settings > Agents in Talk then lists the helper with its own code. Tap Allow only if the two codes match. If they differ, or talkline printed no code, tap Deny. Allow opens a chat with the helper, and talkline says hello there. Deny ends the wait, and `pair` deletes its profile.

If you stop pair before you tap Allow, run the same command again: it waits for the same helper.

The link carries your account, your key and a secret, after the `#`, which never reaches the server. talkline proves to your browser that it holds the secret, and it refuses a chat your key didn't seal, so the server can't swap in a key of its own for yours or the helper's. Only the browser that made the link can Allow, since it keeps the secret.

## Hooks

```
node talkline/cli.ts hooks install [--approvals] [--settings <path>]
node talkline/cli.ts hooks uninstall [--settings <path>]
```

This edits `~/.claude/settings.json` (or `--settings`; a symlink stays a symlink), and first saves a copy next to it named `settings.json.talkline-backup-<date>-<time>`. It leaves your other settings and hooks alone. `hooks install` without `--approvals` turns approvals off. Run `hooks install` again after you upgrade Node or move this folder.

- Notification: when Claude needs you or is done and you are away from the Mac, it texts you. Away means no keyboard or mouse for 2 minutes (1 minute when Claude waits for your input).
- Stop: when a turn ends, Claude gets the messages you sent the helper on Talk since the last one. A reply shows what it quotes, and a forwarded message says someone else wrote it. Each gets 👀 when Claude gets it and ✅ when that turn ends. Answers to questions and call logs don't reach Claude.
- PermissionRequest, only with `--approvals`: while you are away, a permission prompt comes to Talk as an urgent question with the whole command or tool input (past 6,000 characters, its start and end). Reply `yes <code>` or `no <code>`, or tap Approve or Deny on the web. If you left less than 2 minutes before, it waits until you have been away 2 minutes. No answer in 8 minutes means no, and Claude stops until you're back. If you come back to the Mac first, the prompt goes back to the terminal. If you haven't read the question in 3 minutes, it rings your phone once, within Talk's ring rules.

Away is read from this Mac's own keyboard and mouse. Over SSH, on Linux or in a container, talkline can't tell: notifications count you as away, and permission prompts stay in the terminal. To override, set `TALKLINE_AWAY` to `always` or `never` in the `env` block of `~/.claude/settings.json`. The hooks don't see a variable you export in a shell.

Limits of the hooks:

- Talk messages reach Claude only when a turn ends. A message to an idle session waits until you start its next turn.
- All Claude Code sessions on this Mac share one inbox. A swipe-reply to what a session sent you goes to that session; any other message goes to the next session that ends a turn.
- About 9,000 characters reach Claude per turn. More waits for the next turn, and a longer single message is cut.
- The hooks run in every Claude Code session on this Mac, `claude -p` scripts included. A "waiting" or "done" text includes up to 500 characters of Claude's last reply.
- If you answer a permission prompt where this Mac's keyboard can't see it (Remote Control, or SSH with `TALKLINE_AWAY=always`), its Talk question stays open until it expires and may still ring. Ignore it.

`doctor` checks the setup: profile, server, session, owner, chat, safety codes, idle time, hooks and the paths they run. A removed helper fails the session check.

## notify and ask

```
node talkline/cli.ts notify <text> [--quiet]
node talkline/cli.ts ask <question> [--detail <text>] [--risk low|high] [--urgent] [--ring-after <seconds>] [--expires <minutes>]
```

`notify` sends a message; `--quiet` sends it without a push.

`ask` sends the question with a five-letter code and waits. Reply `yes <code>` or `no <code>`, or tap Approve or Deny under the question on the web; a typo fixed with Edit counts. A swipe-reply `no` always counts. On a low-risk ask, a swipe-reply `yes` or a 👍 counts too; on a high-risk ask (the default) they get a reminder that the code is needed. The question closes after `--expires` minutes (default 10, at most 14). `--urgent` sends the question as time-sensitive, and rings your phone once after `--ring-after` seconds (default 180) if you haven't read it, within Talk's ring rules. Pick up and the question comes back below the call.

| Answer  | Prints    | Exit code |
| ------- | --------- | --------- |
| yes     | `yes`     | 0         |
| no      | `no`      | 1         |
| none    | `expired` | 2         |
| error   |           | 3         |
| stopped |           | 128 + the signal (130 for Ctrl+C) |

Stopped by Ctrl+C or a signal, `ask` hangs up a ring and marks the question Cancelled first.

Only your own account can answer. Messages from anyone else, or that fail to decrypt, are ignored. A code never repeats in your chat, and talkline takes each of your messages once, so the server can't replay an old yes.

## Files

All in `~/.talkline` (or `$TALKLINE_HOME`), a folder only you can open (0700):

- `profile.json` (0600): the server, the helper's account, passphrase and token, your account and key as the link pinned them, the chat key, and how far the Stop hook has read.
- `events.jsonl` (0600): one line per event, never message text. `stats` counts the last 7 days.
- `asks` (0600): the ids and codes of all your questions, so a code never repeats and the Stop hook keeps your answers from Claude.
- `seen` (0600): an id for each of your messages, so talkline takes each one once.
- `sessions/`: per Claude Code session, its last reply (added to notifications), the ids of what it sent you, your replies waiting for its next turn, and a marker while a permission question waits.
- `inbox.lock`: held while the Stop hook reads your messages.

Anyone who can read `profile.json` can act as the helper.

## Phase 1 limits

- A helper is yours alone. Nobody else on the server sees it, and it can't start a chat, join a group, or reach anyone but you.
- The off switch is in Talk. Pause, which mutes the helper's chat, stops its pushes and rings until you unmute it. Remove, in Settings > Agents, locks it out at once. Its messages stay in your chat, under Deleted account.
- The server sets the ring rules: 08:00 to 22:00 where you are (the time zone of your Talk web app), at most once every 10 minutes and 6 times a day across all your helpers, once per question, and none after a ring you don't take until you write to the helper. It also caps pushes across your helpers (6 a minute buzz, and 10 an hour go time-sensitive), and each helper sends at most 60 messages a minute.
- Time-sensitive alerts need the Phase 4 iPhone build (12 or later). Until then, the iPhone shows them as normal ones.
- The server sees the helper's name and its Mac's host name, your time zone, when it last sent a message, and which messages are questions or urgent. It never sees what they say.
- The web app comes from the server, so a server that serves altered code could approve for you. Allow in the Phase 4 iPhone build removes that.
- No voice: calls to the helper are declined.
- Talk doesn't push to your phone while a Talk tab is open and visible on another device. If that tab shows the helper's chat, it also marks questions read, so the phone won't ring. Close or hide Talk on the Mac when you leave.
- `unpair --yes` removes the helper, as Remove does, and deletes the profile. Run `hooks uninstall` to remove the hooks.
- A Phase 0 profile (from `pair` with an invite link) keeps working: everyone on the server can see and message that helper, and `doctor` says so. To upgrade, run `unpair --yes`, then link a new helper. For a Phase 0 profile, `unpair --yes` deletes the old helper's messages from your chat.
