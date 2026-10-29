# Native iPhone app and self-hosting plan

Goal: real phone-style calls (lock screen ringing, CallKit, Recents), native push for messages, and a one-click Railway template so anyone can run their own server. The live server at talk.princeuniverse.dev keeps working the whole time: every server change is backward compatible with the web app.

## Architecture

```
iPhone app (SwiftUI)  ─┐                      ┌─ web app (React PWA, unchanged)
                       ├─ Socket.IO + REST ───┤
                       │   your Talk server   │   one per group of friends, on Railway
                       │   (Node, SQLite)     │
                       │         │ "wake device X"
                       │         ▼
                       │   push relay (ours) ── APNs ── iPhone
                       └─ WebRTC media P2P, or Cloudflare TURN
```

- Each Talk server is self-hosted. The APNs key belongs to the app's developer, so servers send pushes through one small relay we run (like Bitwarden's push relay and Element's Sygnal). Pushes carry ids only: never message text, never keys.
- Calls: a VoIP push (PushKit) wakes the app, which reports the call to CallKit right away (required since iOS 13; iOS 26 SDK kills apps that don't). Media is WebRTC (`stasel/WebRTC`), audio started only in `provider(_:didActivate:)`.
- Messages: an alert push with `mutable-content`; a Notification Service Extension fetches the sealed message and decrypts the preview on device, using keys shared through an App Group keychain.
- Crypto is byte-for-byte the web scheme (see `src/lib/crypto.ts`): PBKDF2-SHA256 600k, X25519, HKDF-SHA256 (zero salt, `talk:wrap:v1`), AES-256-GCM with iv(12) + ciphertext + tag(16). Swift tests decrypt vectors made by the web code.
- Socket: a small Socket.IO v5 client over `URLSessionWebSocketTask` (websocket transport only), since `socket.io-client-swift` is barely maintained.

## Phase 1: server, relay, template

1. Server: device registration (`/api/devices`, APNs + VoIP tokens), pushes via the relay, VoIP push on `call:start`, `GET /api/calls/:id` so a late push can tell a cancelled call.
2. App Review needs: in-app account deletion (`DELETE /api/me`), block (server-enforced) and report.
3. Push relay: `relay/` in this repo, its own Railway project. Holds the `.p8` key, sends HTTP/2 to APNs, rate-limits per token, serves the privacy policy and support pages.
4. Railway template from this repo: service + `/data` volume + generated `SETUP_CODE` + optional `CF_TURN_*`; healthcheck `/healthz`; serverless off. Test it as a new project (it becomes the App Review demo server). The live `talk` project is not touched.
5. README: Deploy on Railway button, Cloudflare TURN steps (Realtime → TURN Server → Create; first 1,000 GB/month free).

## Phase 2: iPhone app (`ios/`, XcodeGen)

1. Project: app + Notification Service Extension sharing the account through a keychain access group (no App Group), push, VoIP background mode, mic/camera/photos purpose strings.
2. Core: crypto (with interop tests), API client (cookie session), Socket.IO client, store.
3. Screens (Mobbin-checked, sage/olive palette): join with an invite link (server + code in one), sign in (server address + name + passphrase), chat list, chat (text, photos, files, voice messages, call log lines), settings (safety codes, invites, block list, delete account).
4. Calls: PushKit, CallKit provider (incoming, outgoing, mute, end, audio session), WebRTC engine matching `src/lib/useCall.ts`, in-call video UI, call history in Recents.
5. Notifications: NSE decrypts previews; communication notifications with sender avatars.

## Phase 3: TestFlight and App Store

1. Internal TestFlight first (no review): real lock-screen calls for us.
2. Listing: privacy policy, support URL, screenshots, age rating, `ITSAppUsesNonExemptEncryption`, French declaration only if France is listed, China mainland unticked (CallKit).
3. Review notes: demo server URL, two demo accounts for calls, how the bring-your-own-server model works.
4. Make the repo public and publish the Railway template.

## Needs the account owner

- Apple: an APNs auth key (`.p8`), App Store Connect app record, TestFlight testers.
- Cloudflare: the existing TURN key is reused for our server; template users make their own.
