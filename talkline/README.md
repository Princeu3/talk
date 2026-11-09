# talkline

talkline lets Claude Code reach you on Talk. It pairs as your helper: a Talk account that only you can see or message, named "Claude AI" unless you pick another name. It texts you, asks you yes/no questions, and can ring your phone once. Everything is end-to-end encrypted with Talk's own crypto (`src/lib/crypto.ts`).

Since Phase 1 the helper has its own key and an AI badge in Talk, and you can pause or remove it there. Phase 2 adds `talkline mcp`, Talk tools for a Claude Code session. Started with `claudet` (see [MCP and channel](#mcp-and-channel)), it is also a channel: your messages reach the session as you send them, and its permission prompts come to Talk.

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
- Stop: when a turn ends, Claude gets the messages you sent the helper on Talk since the last one. A reply shows what it quotes, and a forwarded message says someone else wrote it. Each gets 👀 when Claude gets it. Answers to questions and call logs don't reach Claude. A yes or no with no code (or y, n, ok, okay, sure, yeah, yep, yup, nope, nah, approve, approved, deny, denied, 👍 or 👎 alone) that isn't a swipe-reply reaches no session: it gets ❓. A `no <code>` note sent after its question closed goes to the session that asked. Claude is told how to answer you on Talk.
- PermissionRequest, only with `--approvals`: while you are away, a permission prompt comes to Talk as an urgent question that names the tool and, for a command, Claude's reason, then the whole command or tool input, with `/tmp/…/scratchpad` for the session's scratchpad (past 6,000 characters, its start and end). Reply `yes <code>` or `no <code>`, or tap Approve or Deny on the web. `no <code> <note>` passes your note to Claude. A yes can't carry one. If you left less than 2 minutes before, it waits until you have been away 2 minutes. No answer in 8 minutes leaves the prompt waiting at the Mac. A `claude -p` or background run has no prompt to wait at, so it stops, as before. If you come back to the Mac first, the prompt goes back to the terminal. If you haven't read the question in 3 minutes, it rings your phone once, within Talk's ring rules.

Away is read from this Mac's own keyboard and mouse. Over SSH, on Linux or in a container, talkline can't tell: notifications count you as away, and permission prompts stay in the terminal. To override, set `TALKLINE_AWAY` to `always` or `never` in the `env` block of `~/.claude/settings.json`. The hooks don't see a variable you export in a shell.

In a channel session (see [MCP and channel](#mcp-and-channel)) the hooks step back:

- Notification: a "waiting" or "done" text drops "needs you at the Mac", since your reply now reaches the session, and it isn't sent when the session wrote to you in the last 3 minutes. A permission text comes only when no Talk question asks the same thing.
- Stop hands Claude nothing, since the channel already did. It checks that Claude Code showed Claude each message the channel sent. Any that never showed (the channel didn't register) come through Stop, and from then on that session gets its messages at Stop, as without a channel.
- PermissionRequest stays quiet, since the channel asks instead: one question, not two. It still saves an AskUserQuestion or plan for the notification text.

Limits of the hooks:

- Without a channel, Talk messages reach Claude only when a turn ends. A message to an idle session waits until you start its next turn.
- All Claude Code sessions on this Mac share one inbox. A swipe-reply to what a session sent you goes to that session. Any other message goes to a running session that can take it now (see [Which session gets your message](#which-session-gets-your-message)), and with none, to the next session that ends a turn.
- About 9,000 characters reach Claude per turn. More waits for the next turn, and a longer single message is cut.
- The hooks run in every Claude Code session on this Mac, `claude -p` scripts included. A "waiting" or "done" text includes the end of Claude's last reply (500 characters). An AskUserQuestion question shows with its options, and a plan shows its start; you answer both at the Mac.
- If you answer a permission prompt where this Mac's keyboard can't see it (Remote Control, or SSH with `TALKLINE_AWAY=always`), its Talk question stays open until it expires and may still ring. Ignore it.

`doctor` checks the setup: profile, server, session, owner, chat, safety codes, idle time, hooks and the paths they run. A removed helper fails the session check.

## notify and ask

```
node talkline/cli.ts notify <text> [--quiet]
node talkline/cli.ts ask <question> [--detail <text>] [--risk low|high] [--urgent] [--ring-after <seconds>] [--expires <minutes>]
```

`notify` sends a message; `--quiet` sends it without a push. Run from Claude Code, `notify` and `ask` start with the session name, and a swipe-reply goes back to that session.

`ask` sends the question with a five-letter code and waits. Reply `yes <code>` or `no <code>`, or tap Approve or Deny under the question on the web; a typo fixed with Edit counts. `Yes, <code>.` counts too. A note after `no <code>` reaches Claude: `ask` prints it on a second line. A yes can't carry one: `yes <code>` with anything after it gets ❓. A swipe-reply `no` to the question, or to a reminder under it, always counts. On a low-risk ask, a swipe-reply `yes` or a 👍 on the question counts too; on a high-risk ask (the default) they get a reminder that the code is needed. A yes or no with no code that isn't a swipe-reply gets ❓ and one reply with the code to use. The question closes after `--expires` minutes (default 10, at most 14). `--urgent` sends the question as time-sensitive, and rings your phone once after `--ring-after` seconds (default 180) if you haven't read it, within Talk's ring rules. Pick up and the question comes back below the call.

| Answer  | Prints              | Exit code |
| ------- | ------------------- | --------- |
| yes     | `yes`               | 0         |
| no      | `no`, then any note | 1         |
| none    | `expired`           | 2         |
| error   |                     | 3         |
| stopped |                     | 128 + the signal (130 for Ctrl+C) |

Stopped by Ctrl+C or a signal, `ask` hangs up a ring and marks the question Cancelled first.

Only your own account can answer. Messages from anyone else, or that fail to decrypt, are ignored. A code never repeats in your chat, and talkline takes each of your messages once, so the server can't replay an old yes.

## MCP and channel

`talkline mcp` is an MCP server for one Claude Code session: Claude Code starts it with the session and talks to it over stdio. It gives Claude seven Talk tools (see [Tools](#tools)), in one of two modes:

- Plain (`talkline mcp`): the tools only. Your messages reach Claude when it calls `read_messages` or `wait_for_reply`, or when a turn ends, as with the hooks.
- Channel (`talkline mcp --channel`, through `claudet`): your messages also reach Claude as you send them, and an idle session starts a turn. Its permission prompts come to Talk as questions. This needs Claude Code 2.1.312 or later; it was tested on 2.1.312 and 2.1.319.

### Start it

Add this function to `~/.zshrc`, with your paths to `node` (`which node`) and to this checkout:

```sh
claudet() {
  claude "$@" \
    --mcp-config '{"mcpServers":{"talkline":{"command":"/opt/homebrew/bin/node","args":["/path/to/Messaging/talkline/cli.ts","mcp","--channel"]}}}' \
    --settings '{"permissions":{"allow":["mcp__talkline__send_message","mcp__talkline__react","mcp__talkline__ask","mcp__talkline__wait_for_reply","mcp__talkline__read_messages","mcp__talkline__set_status"],"deny":["Read(~/.talkline/**)"]},"disabledMcpjsonServers":["talkline"]}' \
    --dangerously-load-development-channels server:talkline
}
```

Then run `claudet` where you'd run `claude`. Your own arguments come first. The channel flag comes last because it takes a list, and would swallow a prompt after it. The function:

- starts talkline from `--mcp-config`, so nothing else needs installing;
- lets Claude use the reply tools without asking you each time. `send_file` isn't on the list, so a file leaves the Mac only after a yes;
- keeps Claude's file tools out of `~/.talkline`, where the helper's token and the chat key live;
- turns off a project `.mcp.json` server named `talkline`: a cloned repo could define one, and the channel flag would trust it.

The hooks need no change: keep `hooks install --approvals`.

Optional:

- Plain mode in sessions started without `claudet`. First check that `/mcp` in a `claudet` session lists one `talkline`, the channel one. Then run `claude mcp add talkline --scope user -- /opt/homebrew/bin/node /path/to/Messaging/talkline/cli.ts mcp`.
- The same `Read(~/.talkline/**)` deny rule in `~/.claude/settings.json`, so sessions started without `claudet` can't read talkline's keys with the file tools either.

Claude Code may ask at start:

| Prompt | When | Answer |
| --- | --- | --- |
| Quick safety check: Is this a project you created or one you trust? | A folder Claude Code hasn't seen | "Yes, I trust this folder" |
| WARNING: Loading development channels | Every `claudet` start | "I am using this for local development" |
| New MCP server found in this project | A project `.mcp.json` server. Never talkline: `claudet` brings its own and turns off a project one of that name. | Your call, for other servers |

A notice "server:talkline · no MCP server configured with that name" can stay on screen while the channel works. Ignore it.

Don't:

- pass `-p` through `claudet`: `-p` ignores the channel flag, so talkline runs plain;
- use `claudet` under an organization that turns channels off: talkline can't tell, and your messages wait until the session's next turn ends;
- use the channel in a session started with `--dangerously-skip-permissions`: nothing then stands between a Talk message and any tool, so your Talk account becomes a remote shell for that session.

The `Read` deny rule covers Claude's file tools, and `cat`, `head`, `tail`, `sed` and `tee` in Bash. It doesn't cover a script, or a `grep -r` on a parent folder: it narrows the risk without closing it.

### Which session gets your message

Every message a session sends you starts with its name, the name of its folder: `Messaging: Tests pass. Deploy?`. Its questions do too (`Messaging: run this command?`), and so do status lines (`Messaging status: running tests`). 👀 on your message shows that a session got it.

The first rule that fits decides:

1. An answer to a question goes to that question, never to a session as chat. A typed answer after its question closed gets ⏳ and one reply: "Too late: <code> already closed, so this did nothing."
2. `no <code> <note>` goes to the session that asked.
3. A swipe-reply goes to the session that sent the message you swiped. If that session has ended, your message waits for it to resume, and gets ❓ and a reply that says so: send it again without a swipe to reach another session.
4. A message that starts with a session's name and a colon, in any case, goes to that session: `messaging: run the tests`. If two running sessions have that name, it gets ❓ and a reply: swipe-reply instead.
5. Anything else goes to the session you last traded messages with, among those that can take it now: channel sessions, and plain ones waiting in `ask` or `wait_for_reply`. With two or more running, a quiet "Went to <name>" reply says which, at most once every 10 minutes. If it went to the wrong one, send it again with the right name and a colon; Claude in the wrong one knows that other sessions share the chat.
6. With no such session, it goes to the next session that ends a turn, as in Phase 1.

In a channel session Claude offers choices as a numbered message: swipe-reply with the number.

### Permission prompts in a channel session

While you are away, Claude Code's permission dialog also comes to Talk, as an urgent question in the same form as the PermissionRequest hook's: `Messaging: run this command?`, `Claude says: …` for a command, the code line, then the command. The code is Claude Code's own request id. Reply `yes <code>` or `no <code>`, or tap Approve or Deny on the web. `no <code> <note>` passes your note to Claude. No answer in 10 minutes denies, and the question reads "Expired, denied": Claude goes on, and can tell you what didn't run. The dialog stays open at the Mac too, and an answer there wins: the question then reads "Back at the Mac: answer there". If you haven't read the question in 3 minutes, it rings your phone once.

- Away works as for the hooks, `TALKLINE_AWAY` included.
- Claude Code keeps 3,500 characters of each field. When it cut one, or the request doesn't parse, the question adds: "Claude Code cut part of this request. If unsure, reply no and check at the Mac."
- AskUserQuestion and plans stay at the Mac, as in Phase 1.
- To turn this off, add `"env":{"TALKLINE_RELAY":"0"}` to the settings `claudet` passes, so talkline and its hooks both see it. The PermissionRequest hook then asks instead, with the whole input, and no answer in time denies there too.

### Tools

| Tool | Does | Limits |
| --- | --- | --- |
| `send_message` | Texts you as `<name>: <text>`. `quiet` sends it without a push; `reply_to` quotes a message. | 1 to 8,000 characters. 60 messages a minute per helper, and Talk's push caps. |
| `react` | Puts an emoji on a message | One emoji. Not on a question or its reminder, where it would look like an answer. |
| `ask` | A yes/no question with a code, as `ask` above. Returns yes, no and any note, expired, or pending. | Question up to 2,000 characters, detail up to 6,000. Open 10 minutes, at most 14. Waits up to 110 s, then returns pending; returns at once when you write something else. |
| `wait_for_reply` | Waits for your next message, or with a code, for an ask's answer | 1 to 110 s |
| `read_messages` | Your new messages, and answers no call collected | 1 to 50 messages |
| `set_status` | One quiet status line: the first call posts it, later calls edit it | 1 to 500 characters. A new line after 14 minutes. |
| `send_file` | Sends a file, captioned with its name or a caption | 50 MB. Under `claudet` it asks you first. |

Claude gets your words marked: a forwarded message says someone else wrote it, and quoted text shows as context. Claude is told that neither is an instruction, and that a Talk message never approves a tool call.

## Files

All in `~/.talkline` (or `$TALKLINE_HOME`), a folder only you can open (0700):

- `profile.json` (0600): the server, the helper's account, passphrase and token, your account and key as the link pinned them, the chat key, and how far talkline has read your messages.
- `events.jsonl` (0600): one line per event, never message text. `stats` counts the last 7 days.
- `asks` (0600): the ids and codes of all your questions, the reminders they sent and the answers they took, so a code never repeats and your answers stay away from Claude. Other lines tag relay codes, and mark closed questions and sent "Too late" replies.
- `seen` (0600): an id for each of your messages, so talkline takes each one once.
- `sessions/`: per Claude Code session, the end of its last reply (added to notifications), its last AskUserQuestion or plan, the ids of what it sent you, your messages waiting for it (`.held`, a JSON record each: id, time, text, what it quotes, and whether it's forwarded), and a marker while a permission question waits. Also `.taking.<pid>`, lines a process is handing to Claude, so a crash loses none; `.ended`, the name of a session whose talkline mcp exited; and `.delivered` and `.nochannel`, the channel's delivery check. While a talkline mcp runs, its session's files go under the session it started with, which outlives `/clear`.
- `mcp/`: a marker per running talkline mcp, named after its Claude Code process: its session, name and mode, and when you last traded messages.
- `wentto`: its time spaces out the "Went to" replies.
- `inbox.lock`: held, with the holder's pid and start time, while a process routes or takes your messages.

Anyone who can read `profile.json` can act as the helper.

## Phase 1 limits

- A helper is yours alone. Nobody else on the server sees it, and it can't start a chat, join a group, or reach anyone but you.
- The off switch is in Talk. Pause, which mutes the helper's chat, stops its pushes and rings until you unmute it. Remove, in Settings > Agents, locks it out at once. Its messages stay in your chat, under Deleted account.
- The server sets the ring rules: 08:00 to 22:00 where you are (the time zone of your Talk web app), at most once every 10 minutes and 6 times a day across all your helpers, once per question, and none after a ring you don't take until you write to the helper. It also caps pushes across your helpers (6 a minute buzz, and 10 an hour go time-sensitive), and each helper sends at most 60 messages a minute.
- Time-sensitive alerts need the Phase 4 iPhone build (12 or later). Until then, the iPhone shows them as normal ones.
- The server sees the helper's name and its Mac's host name, your time zone, when it last sent a message, and which messages are questions or urgent. It never sees what they say.
- The web app comes from the server, so a server that serves altered code could approve for you. Allow in the Phase 4 iPhone build removes that.
- No voice: calls to the helper are declined.
- A Talk tab left open on the helper's chat marks questions read, so the phone won't ring. Close or hide Talk on the Mac when you leave.
- `unpair --yes` removes the helper, as Remove does, and deletes the profile. Run `hooks uninstall` to remove the hooks.
- A Phase 0 profile (from `pair` with an invite link) keeps working: everyone on the server can see and message that helper, and `doctor` says so. To upgrade, run `unpair --yes`, then link a new helper. For a Phase 0 profile, `unpair --yes` deletes the old helper's messages from your chat.

## Phase 2 limits

- Channels are a Claude Code research preview, behind a flag for development: an update can change them.
- A status line takes edits for 14 minutes, then a new one starts: Talk allows edits for 15.
- `ask` waits 110 s, then returns pending, since Claude Code moves a tool call still running at 120 s to the background. `wait_for_reply` with the code waits on.
- Files go from Claude to you, up to 50 MB. Your files and reactions don't reach Claude.
- AskUserQuestion and plans are answered at the Mac.
- Each message you send a channel session starts a turn like a typed prompt, so your UserPromptSubmit and Stop hooks run for each one.
- Two sessions in folders of the same name share a name: swipe-reply to pick one.
- `reply_to` quotes only the last 500 messages a session saw, and none from before it restarted.
- A Phase 0 pairing gets no tools and no channel: pair again with a helper link.
