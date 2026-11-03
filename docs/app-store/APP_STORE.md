# App Store submission

Every field App Store Connect asks for, filled in for Talk 1.0. Copy each value as written. Limits are App Store Connect's own.

Demo account passphrases live in `docs/app-store/demo-accounts.local.md`, which is gitignored. Never paste them into this file.

## Before you start

The app ships under Abhishek Shekhar's paid team `34XFNGD2MY`, an Individual enrolment: only he, as Account Holder, can open Certificates, IDs & Profiles. Personal team `RMVX38Q6NU` is for device builds only and has no push.

1. Abhishek: Certificates, IDs & Profiles → Keys → create an APNs key. Its `.p8` and Key ID go to the relay (`APNS_KEY`, `APNS_KEY_ID` on Railway project `talk-push`), and `APNS_TEAM_ID` there becomes `34XFNGD2MY`. Without the key the relay refuses every push, so calls don't ring and notifications never arrive.
2. The App Store record uses bundle ID `com.abhishekshekhar.talk`, not the repo's `dev.princeuniverse.talk`. The archive needs that ID (plus `com.abhishekshekhar.talk.notifications` and `com.abhishekshekhar.talk.share` for the two extensions) with Push Notifications on, and the relay's `APNS_BUNDLE_ID` must match it.
3. The App Store Connect record exists: "Talk: Private Calls & Chat", app id 6828441266. Version 1.0 went live on 2026-11-02: https://apps.apple.com/app/id6828441266
4. Abhishek or Prince archives and uploads, following [TESTFLIGHT.md](TESTFLIGHT.md). Bump `CURRENT_PROJECT_VERSION` in `ios/project.yml` before every archive; App Store Connect refuses a build number it has seen.

## App Information

| Field | Value |
| --- | --- |
| Name (30) | `Talk: Private Calls & Chat` (26) |
| Subtitle (30) | `Encrypted chat for your circle` (30) |
| Bundle ID | `com.abhishekshekhar.talk` |
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

## Version page (1.1)

**Promotional text** (170, can change any time without review):

```
Encrypted messages and calls for your circle, on a server you or a friend runs. The app and server are open source on GitHub: github.com/Princeu3/talk
```

**Description** (4000):

```
Talk is a private messenger for family, friends and small teams. Connect to a Talk server using an invite link from its operator.

MESSAGES
Send text, photos, files and voice messages in one-to-one chats and groups. Reply, react, edit what you sent, and see when your messages are read. Messages are encrypted on your device before they leave it.

SEARCH AND SHARED MEDIA
Search all your chats. Search runs on your phone, so the server never sees what you look for. Links show a preview made on your device, and each chat keeps its photos, videos, links and files in one place.

CALLS
Make voice and video calls, one to one or with up to 8 people in a group, and ring more people in while a call is on. Incoming calls integrate with the iPhone lock screen through CallKit.

YOUR CIRCLE
Sign in with a name and a passphrase. Compare safety codes with your contacts, block people, report messages and delete your account from Settings.

YOUR SERVER
Talk is an open-source client for self-hosted Talk servers. You need a server address and an existing account or an invite link to get started. No phone number or email address is required for your Talk account. The server is open source too, so anyone can run their own.

Keep your passphrase safe: it cannot be reset to recover your encrypted message history.

Based on the open-source Talk project: https://github.com/Princeu3/talk
```

**Keywords** (100 bytes, comma separated, no spaces after commas, no words already in the name or subtitle):

```
messenger,e2ee,secure,voice,video,family,friends,self-hosted,invite,group,voip,open source
```

| Field | Value |
| --- | --- |
| Support URL | `https://push.princeuniverse.dev/support` |
| Marketing URL | `https://github.com/Princeu3/talk` |
| Version | 1.1 |
| Copyright | `2026 Talk` |
| Routing app coverage file | None |
| Version release | Manually release this version |
| Phased release | Not offered for 1.0 |

**What's New**: not shown for 1.0. For later versions, list the user-visible changes in plain sentences.

## Screenshots

Required set: **iPhone 6.3" (Dynamic Island, medium), 1206 × 2622 portrait**, PNG without alpha. Apple scales them for other iPhones. No iPad set (the app is iPhone only).

Upload in this order from `docs/app-store/screenshots/`:

| File | Shows | Headline on the image |
| --- | --- | --- |
| `01-chats.png` | Chat list with search | Private chats for your people |
| `02-chat.png` | A chat with a photo, a link preview, a voice message and a read receipt | Messages only you can read |
| `03-call.png` | A group call, with Add people | Group calls, add anyone |
| `04-search.png` | Search results across chats | Find any message |
| `05-media.png` | A group's shared media | Every photo, link and file |
| `06-safety.png` | Settings with safety codes | Check nobody swapped a key |
| `07-server.png` | Sign in with an invite link or server | Your server. Open code. (names github.com/Princeu3/talk) |

Each shows the real app (a Debug build on the iPhone 18 Pro Simulator against a local server with demo people; `-demoCall "<group title>"` shows a group call). A one-line subline sits under each headline, over a paper-cut background from Codex image generation in the palette; the photos in the chats are generated too, and the link card's image is a public-domain National Park Service photo. App Review allows this (guideline 2.3.3: show the app in use).

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

The app sets no `ITSAppUsesNonExemptEncryption` key, so App Store Connect asks the questions below once per uploaded build, under TestFlight → "Missing Compliance" → Manage ([TESTFLIGHT.md](TESTFLIGHT.md), step 1). With YES and no code the upload fails with 90592, and Apple only issues a code after reviewing an uploaded export document. Builds 1–4 were recorded as using no non-exempt encryption; build 5 was the first answered this way.

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
| Contact first and last name | The person who answers App Review's calls |
| Contact phone | Your phone |
| Contact email | Your personal email |
| Attachment | A short screen recording from a real iPhone: sign in, send a message, place a call that rings on a second device, answer, hang up |

**Notes** (4000 bytes; replace `<SAM PASSPHRASE>` with Sam's passphrase from `demo-accounts.local.md`):

```
Talk is a client for a self-hosted, open-source messaging server (https://github.com/Princeu3/talk). We run a demo server for review.

SIGN IN
1. In "Invite link or server" enter: server-production-0ecf.up.railway.app
2. Name: App Review
3. Passphrase: the password in the Sign-In Information above
4. Turn on "I agree to the terms of use" and tap Sign in.
New accounts need a one-time invite link from someone already on the server, so please use this account. Allow notifications when asked; calls and message alerts need them.

TO TEST MESSAGES AND CALLS WITH ONE iPHONE
The second demo account is "Sam" (passphrase: <SAM PASSPHRASE>). The server also hosts the web version of Talk:
1. On a Mac or PC, open https://server-production-0ecf.up.railway.app in Chrome or Safari and sign in as Sam.
2. On the iPhone, open the chat with Sam. Send a message; it appears in the browser.
3. Tap the phone or video icon to call. Answer in the browser. Calling the iPhone from the browser rings it through CallKit, also on the lock screen.

WHERE THINGS ARE
- Report a message: long-press a message from Sam → Report.
- Report or block a person: open the chat → tap the name at the top → Report or Block.
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
