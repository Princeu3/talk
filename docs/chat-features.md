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
- now, search: a search field at the top of the list (web) or pulled down from the title (iPhone). Results in two sections: **Chats** (name or a member's name matches) and **Messages** (newest first: chat name, sender, date, and the matching line with the match in bold). Tapping a message opens the chat at it and flashes it. Matching ignores case and accents, needs 2+ characters for messages, and covers text, file names and link titles, not system lines or call logs. It runs on the device over decrypted history: results from loaded messages show at once, older pages are fetched in the background with "Searching older messages…" under the results.
- later: archive, filters (Unread, Groups), mark unread.

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
  - **Link previews**: typing a link shows a card above the composer (image, title, site) with an X to drop it. The sent bubble shows the card under the text; tapping it opens the link. The sender's device makes the card and seals it inside the message, so readers never contact the site and old apps just show the text. iPhone makes it on the phone (LinkPresentation). The web can't fetch other sites, so it asks our server: the server sees that one link (never logged or stored). A message keeps its card only while the text holds its link, with or without `http://` or `https://` (the iPhone saves a typed www.x.com as http://www.x.com); both apps check this when sealing a send or an edit. Readers drop a card whose link isn't http(s).
- later: select multiple, star, message info screen, mentions, stickers and GIFs, disappearing messages, "Delete for me".

### Chat info: DM
- now: big avatar, name, "End-to-end encrypted"; buttons row: Voice call, Video call; Safety code with how to compare it; Mute notifications; Pin chat; Block / Unblock; Report (red).
- now: **Media, links and docs** row, opening a screen with three tabs: Media (photo and video grid, newest first; tap opens the viewer), Links (title or link, site, date; tap opens it), Docs (files that aren't photos, videos or voice messages: name, size, date). It pages through the chat's history the same way search does.
- later: search in chat, custom notification sound.

### Chat info: group
- now: big avatar, group name with Rename, "N people"; buttons row: Voice call, Video call; members list ("You" first), each opening a member sheet; "Add people"; Mute notifications; Pin chat; Leave group (red, with confirm).
- Member sheet: avatar, name, safety code; Message (opens or creates the DM); Remove from group (red, with confirm). Not for yourself.
- now: **Media, links and docs**, as in a DM.
- later: group photo, admins, invite link.

### Calls
- built: 1:1 voice and video; ringing, CallKit on iPhone, minimize to a bar, mute, camera, flip, end.
- now, group calls:
  - **Incoming**: group name as the title, "Alice · Group video call" under it; Decline / Join. iPhone rings through CallKit with the group name.
  - **In call**: a grid of tiles. 1 other person: their video fills the screen with your own tile in the corner (as today). 2: two stacked tiles. 3–4: 2×2. 5–8: two columns that scroll. Each tile: video, or the avatar when their camera is off; name and a muted mic icon at the bottom.
  - **Status** line: "Waiting for others…" while you're alone; the timer once someone joins.
  - Controls as today (mute, camera, flip, end). Ending leaves the call; the call goes on for the others while two remain.
  - **Join** from the chat banner or the chat list pill, also after declining.
- now, add people: **Add people** in a group call lists the chat's members who aren't in it, each with Ring (or "Ringing…"). Their tiles show "Ringing…" until they join, decline or 45 s pass; then Ring again works. Someone added to the group during a call sees the banner and can join.
- now, blocks: two people where either blocked the other can't be in one group call: they aren't rung, and joining fails ("Unblock Bob to join this call." / "You can't join this call.").
- now, performance: each phone caps what it sends per person as the call grows (see Group call video below), so a mesh of 8 stays inside a phone's upload.
- later: speaker highlight, screen share, call links, a calls tab.

### Settings
- built: invite link, notifications, theme, safety codes, delete account (iPhone), sign out.
- Read receipts are always on; there is no toggle.
- later: profile photo.

## Wire contract

Types live in `shared/types.ts` (mirrored in `ios/Shared/Models.swift`). The server never sees content: reactions, edits, replies and system lines are all sealed with the chat key.

| What | How |
| --- | --- |
| React | `PUT /api/messages/:id/reaction {body}`, body = sealed `ReactionBody {from, to, emoji}`. `DELETE` the same path removes it. Socket `reaction {messageId, convId, userId, body \| null}`. Messages carry `reactions: [{userId, body}]`. Ignore a reaction whose `from`/`to` don't match its row. |
| Edit | `PATCH /api/messages/:id {body}` (sender, 15 min) → `{message}`. Socket `edit` (the Message with `editedAt` but no `reactions`: keep the ones you have). |
| Unsend | `DELETE /api/messages/:id` (sender). Socket `unsend {id, convId}`, then `sync`. |
| Reply, forward | Fields in the sealed MessageBody: `reply {id, from, preview}`, `forwarded: true`. No server change. |
| System line | Send a MessageBody with `system: true` and the sentence in `text`, with `quiet: true, seen: true`. |
| Read receipts | `Conversation.reads {userId: lastReadId}`. Socket `read {convId, userId, upTo}`, only when `upTo` moves forward. |
| Typing | Emit `typing {convId}` at most every 3 s while the composer has text. Socket `typing {convId, userId}`. |
| Mute, pin | `PATCH /api/conversations/:id/me {muted?, pinned?}` → `sync`. `Conversation.muted`, `.pinned`; `/api/me` lists pinned first. |
| Rename group | `PATCH /api/conversations/:id {title}` → `sync`. |
| Leave, remove | `DELETE /api/conversations/:id/members/:userId` (your id to leave) → `sync`. |
| History pages | `GET /api/conversations/:id/messages?before=&limit=`, limit 1–500 (default 50). Search and shared media page with `limit=500`, keep what they fetched for the session, and apply `edit`, `unsend` and blocks to it like the open chat. Nothing decrypted is stored on disk. |
| Link preview | `MessageBody.preview {url, title?, description?, site?, image?}`. `image` is a base64 JPEG, longest side ≤ 320 px, ≤ 24 KB. Web gets the page through `POST /api/unfurl {url}` → `{url, title?, description?, site?, image?, imageType?}`, where `url` is after redirects and `image` is the raw `og:image` (≤ 1 MB, base64) for the client to shrink. 400 for a link it won't fetch, 429 past 20 a minute. |
| Add to a group call | Socket `call:add {id, users}` → ack `{error?}`, from someone in the call. Rings each listed member who isn't in it (again if already ringing), with its own 45 s timeout. `GroupCall.ringing` lists who's being rung. |
| Blocks in calls | `call:join` fails when the joiner and anyone in the call blocked each other; starting and adding skip them. |
| Group calls | See the comment at the top of `server/calls.ts`. Connect the socket with `?v=2`, and register iPhone push tokens with `v: 2`, or group calls never ring. Group rings carry `group: true`. `Conversation.call` is the live call; socket `call:update {convId, call}` keeps it current. |

Older apps keep working: every new field is optional, DM calls keep the 1:1 protocol, and older apps never hear group rings.

## Group call video

A mesh sends a separate copy of your video to each person, so each phone caps every video sender (`RTCRtpSender.setParameters`, no renegotiation) whenever the number of others changes. 1:1 calls get the first row: uncapped, a 720p sender climbs to about 2.5 Mbps and overshoots a cellular upload, which breaks audio too. Read the sender's parameters, change `encodings[0]`, set them back.

| Others in the call | maxBitrate | scaleResolutionDownBy | maxFramerate |
| --- | --- | --- | --- |
| 1 | 1.5 Mbps | 1 | 30 |
| 2 | 900 kbps | 1 | 30 |
| 3 | 600 kbps | 1.5 | 30 |
| 4–5 | 400 kbps | 2 | 24 |
| 6–7 | 250 kbps | 2.5 | 15 |

Audio stays at the defaults: 7 Opus streams cost little.
