# TestFlight upload

How to put the next Talk build on TestFlight from `master`. It is written for Abhishek, the Account Holder of team `34XFNGD2MY`, and for his Claude. Abhishek does step 1, the Xcode sign-in in step 2, and the App Store Connect parts of step 5, since they need his account. Claude can do the rest. Prince's Mac can stand in for steps 2 and 4: see [From Prince's Mac](#from-princes-mac).

State on 2026-11-01:

- The App Store Connect record "Talk: Private Calls & Chat" (app id 6828441266, bundle ID `com.abhishekshekhar.talk`).
- App IDs `com.abhishekshekhar.talk` (Push Notifications, Communication Notifications), `com.abhishekshekhar.talk.notifications` and `com.abhishekshekhar.talk.share` (no capabilities).
- The team has one registered iPhone. Keep at least one: Xcode signs the archive with a development profile, which needs a device.
- The push relay sends for team `34XFNGD2MY` and bundle `com.abhishekshekhar.talk`.
- Builds 1 to 4 are on TestFlight, all recorded as using no non-exempt encryption. The app now sets `ITSAppUsesNonExemptEncryption` to YES, and an upload with that was refused with error 90592: "The export compliance key value [] in the app's Info.plist doesn't match the key value of the app's export compliance documentation." The app has no encryption declaration yet.

## 1. Encryption declaration (Abhishek, once)

The bundled WebRTC library brings its own encryption for calls, which is why the app says YES. The answers are legal statements about the app, so a person files them, not Claude.

1. At developer.apple.com/account and appstoreconnect.apple.com, accept any pending agreements. Only the Account Holder can, and an open one can block signing and uploads.
2. App Store Connect → Apps → Talk → App Information → App Encryption Documentation → add a declaration.
3. Answer as listed in [APP_STORE.md, Export compliance](APP_STORE.md#export-compliance). For France, either upload the French declaration or untick France under Pricing and Availability.
4. Once Apple approves it, copy the code it shows for `ITSEncryptionExportComplianceCode`. A declaration with a document to review can take a few days.

If App Store Connect finishes without giving a code, stop and tell Prince. Uploading with YES and no code fails with 90592 again. Going back to NO, as builds 1 to 4 were recorded, is a decision for Prince and Abhishek, not for Claude.

## 2. Mac setup

- Xcode 27, signed in under Xcode → Settings → Accounts with the Apple ID that owns team `34XFNGD2MY` (Abhishek does this).
- XcodeGen: `brew install xcodegen`.
- The repo: `git clone https://github.com/Princeu3/talk.git`, or `git pull` on `master`.

## 3. Build number and compliance code

In `ios/project.yml`:

- Add the code from step 1 to the `Talk` target's `info` → `properties`, indented 8 spaces like `ITSAppUsesNonExemptEncryption` beside it:

```yaml
        ITSEncryptionExportComplianceCode: <code from step 1>
```

- Set `CURRENT_PROJECT_VERSION` one above the higher of its value on `master` and the newest build under App Store Connect → TestFlight. App Store Connect refuses a number it has seen. On 2026-11-01 both were 4, so the next is 5.

## 4. Archive and upload

From `ios/`:

```bash
xcodegen
```

```bash
xcodebuild archive -project Talk.xcodeproj -scheme Talk -configuration Release -destination generic/platform=iOS -archivePath build/Talk.xcarchive -xcconfig release/Release.xcconfig -allowProvisioningUpdates
```

```bash
xcodebuild -exportArchive -archivePath build/Talk.xcarchive -exportOptionsPlist release/ExportOptions.plist -exportPath build/export -allowProvisioningUpdates
```

`release/Release.xcconfig` swaps the repo's `dev.princeuniverse.*` bundle IDs for the `com.abhishekshekhar.*` ones and sets the team. `-allowProvisioningUpdates` lets Xcode make the signing profiles with the account from step 2. The export step uploads the build itself (`destination: upload` in `release/ExportOptions.plist`). `ios/build/` is gitignored.

If the archive works but the export can't sign or upload, run `open build/Talk.xcarchive` so Xcode adds it to Window → Organizer. Then choose Distribute App → Custom → App Store Connect → Upload, keep automatic signing, and untick "Manage version and build number". The one-click "TestFlight & App Store" option may change the build number.

| Error | Fix |
| --- | --- |
| 90592, "Invalid Export Compliance Code" | The code in `ios/project.yml` is missing, mistyped or not yet approved, or `xcodegen` didn't run after the edit |
| The bundle version must be higher | Raise `CURRENT_PROJECT_VERSION` again |
| "Your team has no devices from which to generate a provisioning profile" | Register an iPhone under Certificates, IDs & Profiles → Devices, then rerun the archive |
| "No Accounts" or no signing certificate | Sign in to Xcode as in step 2; Xcode makes an Apple Distribution certificate on the first export |

## 5. After the upload

- App Store Connect → TestFlight shows the build as Processing, which can take from a few minutes to over an hour.
- When it's ready, Abhishek adds it to the internal testing group if it isn't there yet. No compliance question should come up, since the build carries the code.
- What to Test:
  - calls
  - the microphone prompt at first launch, and the Settings link when the microphone or camera is off
  - the unread badge
  - chats opened offline
  - messages written offline, which send once, in order, when back online
  - Talk in the share sheet of Photos, Safari and Files, with Talk chats suggested in its top row
  - attachments over 25 MB, which download on a tap
- `xcodegen` also rewrites the tracked `ios/App/Info.plist`. Either open a pull request with `ios/project.yml` and `ios/App/Info.plist` together, or run `git checkout ios/App/Info.plist ios/project.yml` and send Prince the build number and the code, so later builds carry both.

## From Prince's Mac

Prince's Mac signs by hand, so it needs no Apple ID in Xcode. Only that Mac has the private key of the team's Apple Distribution certificate (`86L82FD4U9`, in the login keychain) and the team's App Store Connect API key (in `~/.appstoreconnect/private_keys`, with its key ID and issuer ID in `~/.appstoreconnect/talk.env`, outside the repo). It also has the profiles "Talk App Store", "Talk Notifications App Store" and "Talk Share App Store" installed. They are made with that certificate and can be downloaded again from the portal.

Builds 1 to 4 came from Abhishek's Mac. The one upload from Prince's Mac, on 2026-10-31, was refused with 90592 (no compliance code) and 90474 (iPad orientations, fixed since: the app is iPhone only). An archive of `master` signed this way on 2026-11-01 exports with all three targets signed correctly, but no build from this path has been accepted yet.

Step 1 still needs Abhishek: he sends Prince the code, and once step 3 puts it in `ios/project.yml`, later builds need nothing from him. Start from an up-to-date `master` with a clean `ios/` folder, do step 3, then run these from `ios/`:

```bash
rm -rf build && xcodegen
```

```bash
xcodebuild archive -project Talk.xcodeproj -scheme Talk -configuration Release -destination generic/platform=iOS -archivePath build/Talk.xcarchive -xcconfig release/Manual.xcconfig
```

```bash
xcodebuild -exportArchive -archivePath build/Talk.xcarchive -exportOptionsPlist release/ManualExportOptions.plist -exportPath build/export
```

```bash
. ~/.appstoreconnect/talk.env && xcrun altool --upload-app -f build/export/Talk.ipa -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER"
```

Then do step 5, except its last bullet: commit `ios/project.yml` and `ios/App/Info.plist` together on `master` and push, so the next build starts from this number and code. Pushing `master` also redeploys the push relay and the demo server.

The certificate and the three profiles expire at 02:45 UTC on 2027-09-12, the evening of 2027-09-11 in the US. By the end of August 2027, make a new Apple Distribution certificate from this Mac and remake the three profiles with it under the same names. The API key can do this: it registered the share App ID and made its profile on 2026-11-01.
