# App Store submission

Every field App Store Connect asks for, filled in for Talk 1.0. Copy each value as written. Limits are App Store Connect's own.

Demo account passphrases live in `docs/app-store/demo-accounts.local.md`, which is gitignored. Never paste them into this file.

## Before you start

1. Apple Developer account (team RMVX38Q6NU): Certificates, IDs & Profiles → Keys → create an APNs key. Give its `.p8` and Key ID to the relay (`APNS_KEY`, `APNS_KEY_ID` on Railway project `talk-push`).
2. Identifiers: `dev.princeuniverse.talk` (Push Notifications on) and `dev.princeuniverse.talk.notifications`. Xcode's automatic signing creates both on the first device build.
3. App Store Connect → Apps → + → New App: platform iOS, name below, primary language English (U.S.), bundle ID `dev.princeuniverse.talk`, SKU `talk-ios`, user access Full Access.
4. Archive in Xcode (Product → Archive) and upload. The build appears under TestFlight after processing.

## App Information

| Field | Value |
| --- | --- |
| Name (30) | `Talk: Private Calls & Chat` (26) |
| Subtitle (30) | `Encrypted chat for your circle` (30) |
| Bundle ID | `dev.princeuniverse.talk` |
| SKU | `talk-ios` |
| Primary language | English (U.S.) |
| Primary category | Social Networking |
| Secondary category | Utilities |
| Content rights | No, the app does not contain, show or access third-party content |
| Age rating | See below |
| License agreement | Apple's standard EULA. Talk's own terms are at the URL below and are accepted in the app |
| Privacy policy URL | `https://push.princeuniverse.dev/privacy` |
| Privacy choices URL | Leave empty |
| EU Digital Services Act | Not a trader (free, no ads, no purchases, personal project). Choose "trader" only if you start earning from it; traders must publish an address, phone and email |
| Regulated medical device | No |

If the name is taken when you create the record, use `Talk Circle: Private Calls`. The home-screen name stays `Talk` (from `CFBundleDisplayName`).

## Pricing and Availability

| Field | Value |
| --- | --- |
| Price | Free |
| Availability | All countries and regions except **China mainland** (App Review rejects CallKit apps there) |
| France | Either upload the French encryption declaration (see Export compliance) or untick France for 1.0 |
| Pre-orders | No |
| Distribution | Public on the App Store |
| Apple silicon Macs | Off for 1.0 (CallKit and PushKit behave differently there; turn on once tested) |
| Apple Vision Pro | Off |

## Version 1.0 page

**Promotional text** (170, can change any time without review):

```
Messages, photos, voice notes and calls that only you and your people can read. Invite-only and end-to-end encrypted, on a server you can run yourself.
```

**Description** (4000):

```
Talk is a private messenger for a small circle: family, close friends, a team of a few people. Everything you send is encrypted on your phone before it leaves it.

MESSAGES
• Text, photos, files and voice messages
• One-to-one chats and groups
• Read state and unread counts

CALLS
• Voice and video calls between two people
• Calls ring like phone calls, on the lock screen and in Recents
• Calls go directly between phones when they can, and through an encrypted relay when a network blocks that

PRIVATE BY DESIGN
• End-to-end encrypted: the server stores only ciphertext
• No phone number and no email: you sign in with a name and a passphrase that never leaves your device
• Safety codes let you check that nobody swapped a key
• Notifications are decrypted on your phone; push servers see only ids
• No ads, no tracking, no analytics

YOUR OWN SERVER
Talk connects to a Talk server. Someone in your circle runs one (it deploys to Railway in a few minutes, and the code is open source), then sends invite links. Open the link, choose a name and a passphrase, and you're in.

SAFETY
Block anyone, report a message or a person, and delete your account from Settings at any time.

Talk needs an invite link from someone who runs a Talk server.
```

**Keywords** (100 bytes, comma separated, no spaces after commas, no words already in the name or subtitle):

```
messenger,e2ee,secure,voice,video,family,friends,self-hosted,invite,group,voip,open source
```

| Field | Value |
| --- | --- |
| Support URL | `https://push.princeuniverse.dev/support` |
| Marketing URL | `https://github.com/Princeu3/talk` |
| Version | 1.0 |
| Copyright | `2026 Prince Upadhyay` |
| Routing app coverage file | None |
| Version release | Manually release this version |
| Phased release | Not offered for 1.0 |

**What's New**: not shown for 1.0. For later versions, list the user-visible changes in plain sentences.

## Screenshots

Required set: **iPhone 6.3" (Dynamic Island, medium), 1206 × 2622 portrait**, PNG without alpha. Apple scales them for other iPhones. No iPad set (the app is iPhone only).

Upload in this order from `docs/app-store/screenshots/`:

| File | Shows | Caption on the image |
| --- | --- | --- |
| `01-chats.png` | Chat list | Your people, nobody else |
| `02-chat.png` | A conversation with a photo and a voice message | Messages only you can read |
| `03-call.png` | In-call screen | Calls that ring like a phone |
| `04-group.png` | A group chat | Groups for the whole circle |
| `05-safety.png` | Settings with safety codes | Check that nobody swapped a key |
| `06-join.png` | Join with an invite link | Join with one invite link |

Each shows the real app. Captions sit above the screenshot on the palette background, which App Review allows (guideline 2.3.3: show the app in use).

App preview video: optional; skip for 1.0.

## App Privacy

Privacy policy URL as above. "Do you or your third-party partners collect data from this app?" → **Yes**.

| Data type | Collected | Linked to the user | Used for tracking | Purpose |
| --- | --- | --- | --- | --- |
| Identifiers → User ID (the name and account id) | Yes | Yes | No | App Functionality |
| Identifiers → Device ID (push tokens) | Yes | Yes | No | App Functionality |
| User Content → Emails or Text Messages | Yes | Yes | No | App Functionality |
| User Content → Photos or Videos | Yes | Yes | No | App Functionality |
| User Content → Audio Data | Yes | Yes | No | App Functionality |
| User Content → Other User Content (files) | Yes | Yes | No | App Functionality |

Everything else (contact info, location, contacts, browsing, search, purchases, usage data, diagnostics, health, financial, sensitive info) → Not collected.

Why declare encrypted content: Apple's definition counts data sent off the device and kept longer than the request needs. The server keeps ciphertext it cannot read; declaring it is the cautious answer and costs nothing. This matches `PrivacyInfo.xcprivacy` in the app.

## Age rating

| Question | Answer |
| --- | --- |
| Parental controls | No |
| Age assurance | No |
| Unrestricted web access | No |
| User-generated content | No (nothing is published or broadcast; chats are private and invite-only) |
| Messaging and chat | **Yes** |
| Social media | No |
| Advertising | No |
| Every mature-theme, medical, sexual content, nudity, violence, profanity, horror, alcohol/drug, gambling and contest question | None / No |

Expected result: the lowest tier that allows messaging (Apple computes it). Do not override.

## Export compliance

`ITSAppUsesNonExemptEncryption` is `YES` in the app, so App Store Connect asks on the first build:

| Question | Answer |
| --- | --- |
| Does your app use encryption? | Yes |
| Which type? | Standard encryption algorithms instead of, or in addition to, the encryption in Apple's operating system (CryptoKit for messages; the bundled WebRTC library's DTLS-SRTP for calls) |
| Proprietary or non-standard algorithms? | No |
| Available in France? | If yes, upload the French encryption declaration (ANSSI "déclaration de fourniture d'un moyen de cryptologie"). If you'd rather not, untick France in Availability |

US: X25519, HKDF, AES-GCM, PBKDF2 and DTLS-SRTP are standard, mass-market encryption under EAR 740.17(b)(1). Since 2021 that needs no annual self-classification report, and the code is public. This is a reading of the rules, not legal advice.

## App Review Information

| Field | Value |
| --- | --- |
| Sign-in required | Yes |
| User name | `App Review` |
| Password | The passphrase for `App Review` in `demo-accounts.local.md` |
| Contact first and last name | Your name |
| Contact phone | Your phone |
| Contact email | Your personal email |
| Attachment | A short screen recording from a real iPhone: sign in, send a message, place a call that rings on a second device, answer, hang up |

**Notes** (4000 bytes; replace the two passphrase placeholders):

```
Talk is a client for a self-hosted, open-source messaging server (https://github.com/Princeu3/talk). We run a demo server for review.

SIGN IN
1. In the first field enter: server-production-0ecf.up.railway.app
2. Name: App Review
3. Passphrase: <APP REVIEW PASSPHRASE>
4. Turn on "I agree to the terms of use" and tap Sign in.
New accounts need a one-time invite link from someone already on the server, so please use this account.

TO TEST MESSAGES AND CALLS WITH ONE iPHONE
The second demo account is "Sam" (passphrase: <SAM PASSPHRASE>). The server also hosts the web version of Talk:
1. On a Mac or PC, open https://server-production-0ecf.up.railway.app in Chrome or Safari and sign in as Sam.
2. On the iPhone, open the chat with Sam. Send a message; it appears in the browser.
3. Tap the phone or video icon to call. Answer in the browser. Calling the iPhone from the browser rings it through CallKit, also on the lock screen.

WHERE THINGS ARE
- Report a message: long-press a message from Sam → Report.
- Report or block a person: open the chat → "…" menu at the top right.
- Delete account: Settings (gear, top left) → Delete account. Deleting the demo account breaks later review steps, so please test it last or create a throwaway account with an invite link (Settings → Create invite link, then sign out and open the link).
- Terms of use: https://push.princeuniverse.dev/terms (accepted at sign-in and sign-up). Reports reach the server operator (us, for this server), who acts within 24 hours.

WHY THESE CAPABILITIES
- VoIP push and background audio: only for incoming calls through CallKit and for keeping a call's audio running when the app is in the background. Every VoIP push reports a call to CallKit.
- Notification service extension: decrypts message previews on the device. Our push relay sends only ids, never content.
- Local network: WebRTC connects calls directly when both phones are on the same network.
- Messages are end-to-end encrypted, so the server cannot filter content. Instead: invite-only accounts, per-message reporting, blocking, and removal of offending accounts within 24 hours.
```

## After approval

- Release manually from App Store Connect.
- Keep the demo server running; App Review uses it again for every update.
- To ship an update: bump `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `ios/project.yml`, archive, upload, fill "What's New", submit.
