# talkline

talkline lets Claude Code reach you on Talk. It signs up as an ordinary Talk account (named "Claude AI" unless you pick another name), opens a chat with you, and then texts you, asks you yes/no questions, and can ring your phone once. Everything is end-to-end encrypted with Talk's own crypto (`src/lib/crypto.ts`).

This is Phase 0: a client only. The server and the apps don't change.

Run it with Node 24 or later from anywhere: `node /path/to/Messaging/talkline/cli.ts <command>`. Any error exits 3.

## Pair

In Talk, open Settings > Create invite link, then:

```
node talkline/cli.ts pair "<invite link>" --owner <your Talk name> [--name "Claude AI"]
```

This makes the agent account, opens a chat with you and says hello. It prints two safety codes. In Talk, open Settings > Safety codes and check them: the first against the agent's row, the second against your own row, marked (you). If either differs, run `unpair --yes` and don't use the pairing.

If pair stops part way (a typo in `--owner`, say), fix it and run pair again. It picks up where it stopped.

## Hooks

```
node talkline/cli.ts hooks install [--approvals] [--settings <path>]
node talkline/cli.ts hooks uninstall [--settings <path>]
```

This edits `~/.claude/settings.json` (or `--settings`; a symlink stays a symlink), and first saves a copy next to it named `settings.json.talkline-backup-<date>-<time>`. It leaves your other settings and hooks alone. `hooks install` without `--approvals` turns approvals off. Run `hooks install` again after you upgrade Node or move this folder.

- Notification: when Claude needs you or is done and you are away from the Mac, it texts you. Away means no keyboard or mouse for 2 minutes (1 minute when Claude waits for your input).
- Stop: when a turn ends, Claude gets the messages you sent the agent on Talk since the last one. A reply shows what it quotes, and a forwarded message says someone else wrote it. Each gets 👀 when Claude gets it and ✅ when that turn ends. Answers to questions and call logs don't reach Claude.
- PermissionRequest, only with `--approvals`: while you are away, a permission prompt comes to Talk as a question with the whole command or tool input (past 6,000 characters, its start and end). Reply `yes <code>` or `no <code>`. If you left less than 2 minutes before, it waits until you have been away 2 minutes. No answer in 8 minutes means no, and Claude stops until you're back. If you come back to the Mac first, the prompt goes back to the terminal. Between 08:00 and 22:00 it rings your phone once if you haven't read the question in 3 minutes.

Away is read from this Mac's own keyboard and mouse. Over SSH, on Linux or in a container, talkline can't tell: notifications count you as away, and permission prompts stay in the terminal. To override, set `TALKLINE_AWAY` to `always` or `never` in the `env` block of `~/.claude/settings.json`. The hooks don't see a variable you export in a shell.

Limits of the hooks:

- Talk messages reach Claude only when a turn ends. A message to an idle session waits until you start its next turn.
- All Claude Code sessions on this Mac share one inbox. A swipe-reply to what a session sent you goes to that session; any other message goes to the next session that ends a turn.
- About 9,000 characters reach Claude per turn. More waits for the next turn, and a longer single message is cut.
- The hooks run in every Claude Code session on this Mac, `claude -p` scripts included. A "waiting" or "done" text includes up to 500 characters of Claude's last reply.
- If you answer a permission prompt where this Mac's keyboard can't see it (Remote Control, or SSH with `TALKLINE_AWAY=always`), its Talk question stays open until it expires and may still ring. Ignore it.

`doctor` checks the setup: profile, server, session, owner, chat, safety codes, idle time, hooks and the paths they run. When the agent fails to sign in, talkline stops trying for 10 minutes; `doctor` tries again at once.

## notify and ask

```
node talkline/cli.ts notify <text> [--quiet]
node talkline/cli.ts ask <question> [--detail <text>] [--risk low|high] [--urgent] [--ring-after <seconds>] [--expires <minutes>]
```

`notify` sends a message; `--quiet` sends it without a push.

`ask` sends the question with a five-letter code and waits. Reply `yes <code>` or `no <code>`; a typo fixed with Edit counts. A swipe-reply `no` always counts. On a low-risk ask, a swipe-reply `yes` or a 👍 counts too; on a high-risk ask (the default) they get a reminder that the code is needed. The question closes after `--expires` minutes (default 10, at most 14). `--urgent` rings your phone once after `--ring-after` seconds (default 180) if you haven't read the question. Pick up and the question comes back below the call.

| Answer  | Prints    | Exit code |
| ------- | --------- | --------- |
| yes     | `yes`     | 0         |
| no      | `no`      | 1         |
| none    | `expired` | 2         |
| error   |           | 3         |
| stopped |           | 128 + the signal (130 for Ctrl+C) |

Stopped by Ctrl+C or a signal, `ask` hangs up a ring and marks the question Cancelled first.

Only your own account can answer. Messages from anyone else, or that fail to decrypt, are ignored.

## Files

All in `~/.talkline` (or `$TALKLINE_HOME`), a folder only you can open (0700):

- `profile.json` (0600): the server, the agent's account and passphrase, its session cookie, your account as pinned at pairing, the chat key, and how far the Stop hook has read.
- `events.jsonl` (0600): one line per event, never message text. `stats` counts the last 7 days.
- `asks` (0600): the ids and codes of your recent questions (the last 500 lines), so the Stop hook keeps your answers from Claude.
- `sessions/`: per Claude Code session, its last reply (added to notifications), the ids of what it sent you, your replies waiting for its next turn, and a marker while a permission question waits.
- `inbox.lock`: held while the Stop hook reads your messages.

Anyone who can read `profile.json` can act as the agent.

## Phase 0 limits

- The agent is an ordinary account, and everyone on the server can see it and message it. It only listens to you, but use it on your own server only.
- Block the agent in Talk to cut it off at once. That is the kill switch.
- `unpair --yes` deletes the agent account on the server and the profile. Run `hooks uninstall` to remove the hooks.
- No voice: calls to the agent are declined.
- Talk doesn't push to your phone while a Talk tab is open and visible on another device. If that tab shows the agent's chat, it also marks questions read, so the phone won't ring. Close or hide Talk on the Mac when you leave.
- Your own safety code in Talk, the (you) row, comes from the server like every other row, so it proves little until the apps show it from your own key. The server can also replay or hold back past messages.
