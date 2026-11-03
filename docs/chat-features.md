# Chat features: screens and flows

What Talk needs so that someone moving from Apple Messages, FaceTime or WhatsApp finds what they expect. Patterns come from Mobbin (WhatsApp, Messages, Signal, Telegram) and Apple's support pages. Status: **built** (shipped before), **now** (this pass), **later** (not yet).

## Defaults

- Reactions: 👍 ❤️ 😂 😮 😢 🙏 (WhatsApp's set). One per person per message; picking another replaces yours; picking yours again removes it.
- Edit: 15 minutes after sending (Apple and WhatsApp). The server enforces it.
- Unsend ("Delete for everyone"): your own messages, any time. The message is gone for everyone, with no placeholder (older apps couldn't show one).
- Message menu, your own: Reply, Copy, Forward, Edit (first 15 min), Delete (red, last). Someone else's: Reply, Copy, Forward, Report (red).
- Read receipts: DM shows "Read" or "Sent" under your newest message. Groups show "Read by Alice, Bob" (or "Read by 4") there.
- Typing: "typing…" (DM) or "Alice is typing…" (group, up to two names, then "3 people are typing…"). Gone 6 s after the last signal or when their message lands.
- Group calls: up to 8 people, each connected to each other (mesh). Rings everyone in the group who hasn't muted it; anyone in the chat can join while it's on.

## Screens

### Chat list
- built: rows with avatar, name, preview, time, unread badge; empty state; settings and compose buttons.
- now: pinned chats first with a pin icon; muted chats show a crossed bell; "typing…" replaces the preview; a live group call shows a green "Join" pill. iPhone: swipe actions (leading Pin/Unpin, trailing Mute/Unmute); web: the same toggles live in chat info.
- later: search, archive, filters (Unread, Groups), mark unread.

### Chat (thread)
- built: bubbles grouped by sender and time, day separators, photos, files, voice messages, call logs with Call back, pending rows with retry, load earlier.
- now:
  - **Header** is a button that opens chat info (avatar + name + subtitle). Subtitle: "typing…" when someone types; group: member names; DM: "End-to-end encrypted".
  - **Call buttons** in DMs and groups (voice, video). In a group with a live call, a banner under the header: "Group video call · 3 people · Join" (or "Return to call" if you're in it).
  - **Long-press (iPhone) / hover button or right-click (web)** on a bubble: reaction bar above (6 emoji), menu below (see Defaults).
  - **Reactions** show as a small pill under the bubble's bottom edge, aligned to the bubble's side: emoji with counts, yours highlighted. Tap a reaction pill: lists who reacted; tap your own entry to remove it.
  - **Reply**: swipe a bubble right (iPhone) or choose Reply. A bar above the composer shows a 3 pt accent line, the sender name ("You" for yours), one line of preview, and an X. The sent bubble carries a quote block (name + two-line preview); tapping it scrolls to the original and flashes it, if it's loaded.
  - **Edit**: the composer fills with the text, shows "Editing" with an X, and the send button becomes a check. Edited bubbles show "Edited" next to the time.
  - **Delete**: confirm "Delete for everyone?" with a red Delete button. The bubble disappears for everyone.
  - **Forward**: pick a chat from a list; text and files are sent again (files are re-encrypted for that chat). Forwarded bubbles show a small "Forwarded" label.
  - **Read receipt** line under your newest message; **typing bubble** (three dots) at the bottom of the thread on iPhone.
  - **System lines** for group events, centered and small: "Alice added Bob", "Bob left", "Alice named the group “Hike club”", "Alice removed Carol".
- later: message search, select multiple, star, message info screen, link previews, mentions, stickers and GIFs, disappearing messages, "Delete for me".

### Chat info: DM
- now: big avatar, name, "End-to-end encrypted"; buttons row: Voice call, Video call; Safety code with how to compare it; Mute notifications; Pin chat; Block / Unblock; Report (red).
- later: shared media, search in chat, custom notification sound.

### Chat info: group
- now: big avatar, group name with Rename, "N people"; buttons row: Voice call, Video call; members list ("You" first), each opening a member sheet; "Add people"; Mute notifications; Pin chat; Leave group (red, with confirm).
- Member sheet: avatar, name, safety code; Message (opens or creates the DM); Remove from group (red, with confirm). Not for yourself.
- later: shared media, group photo, admins, invite link.

### Calls
- built: 1:1 voice and video; ringing, CallKit on iPhone, minimize to a bar, mute, camera, flip, end.
- now, group calls:
  - **Incoming**: group name as the title, "Alice · Group video call" under it; Decline / Join. iPhone rings through CallKit with the group name.
  - **In call**: a grid of tiles. 1 other person: their video fills the screen with your own tile in the corner (as today). 2: two stacked tiles. 3–4: 2×2. 5–8: two columns that scroll. Each tile: video, or the avatar when their camera is off; name and a muted mic icon at the bottom.
  - **Status** line: "Waiting for others…" while you're alone; the timer once someone joins.
  - Controls as today (mute, camera, flip, end). Ending leaves the call; the call goes on for the others while two remain.
  - **Join** from the chat banner or the chat list pill, also after declining.
- later: add people mid-call, speaker highlight, screen share, call links, a calls tab.

### Settings
- built: invite link, notifications, theme, safety codes, delete account (iPhone), sign out.
- later: read receipts toggle, profile photo.

## Wire contract

Types live in `shared/types.ts` (mirrored in `ios/Shared/Models.swift`). The server never sees content: reactions, edits, replies and system lines are all sealed with the chat key.

| What | How |
| --- | --- |
| React | `PUT /api/messages/:id/reaction {body}`, body = sealed `ReactionBody {from, to, emoji}`. `DELETE` the same path removes it. Socket `reaction {messageId, convId, userId, body \| null}`. Messages carry `reactions: [{userId, body}]`. Ignore a reaction whose `from`/`to` don't match its row. |
| Edit | `PATCH /api/messages/:id {body}` (sender, 15 min) → `{message}`. Socket `edit` (the whole Message, with `editedAt`). |
| Unsend | `DELETE /api/messages/:id` (sender). Socket `unsend {id, convId}`, then `sync`. |
| Reply, forward | Fields in the sealed MessageBody: `reply {id, from, preview}`, `forwarded: true`. No server change. |
| System line | Send a MessageBody with `system: true` and the sentence in `text`, with `quiet: true, seen: true`. |
| Read receipts | `Conversation.reads {userId: lastReadId}`. Socket `read {convId, userId, upTo}`. |
| Typing | Emit `typing {convId}` at most every 3 s while the composer has text. Socket `typing {convId, userId}`. |
| Mute, pin | `PATCH /api/conversations/:id/me {muted?, pinned?}` → `sync`. `Conversation.muted`, `.pinned`; `/api/me` lists pinned first. |
| Rename group | `PATCH /api/conversations/:id {title}` → `sync`. |
| Leave, remove | `DELETE /api/conversations/:id/members/:userId` (your id to leave) → `sync`. |
| Group calls | See the comment at the top of `server/calls.ts`. Connect the socket with `?v=2`, and register iPhone push tokens with `v: 2`, or group calls never ring. `Conversation.call` is the live call; socket `call:update {convId, call}` keeps it current. |

Older apps keep working: every new field is optional, DM calls keep the 1:1 protocol, and older apps never hear group rings.
