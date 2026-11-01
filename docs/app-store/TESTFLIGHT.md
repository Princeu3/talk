# TestFlight upload

How to put the next Talk build on TestFlight from `master`. It is written for Abhishek, the Account Holder of team `34XFNGD2MY`, and for his Claude. Abhishek does step 1, the Xcode sign-in in step 2, and the App Store Connect parts of step 5, since they need his account. Claude can do the rest.

State on 2026-11-01:

- The App Store Connect record "Talk: Private Calls & Chat" (app id 6828441266, bundle ID `com.abhishekshekhar.talk`).
- App IDs `com.abhishekshekhar.talk` (Push Notifications, Communication Notifications) and `com.abhishekshekhar.talk.notifications`. The share extension's `com.abhishekshekhar.talk.share` doesn't exist yet. Xcode registers it in step 4.
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

- Set `CURRENT_PROJECT_VERSION` one above the highest build ever uploaded. Build 4 is the highest, so use 5. App Store Connect refuses a number it has seen.

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

`release/Release.xcconfig` swaps the repo's `dev.princeuniverse.*` bundle IDs for the `com.abhishekshekhar.*` ones and sets the team. `-allowProvisioningUpdates` lets Xcode register the share extension's ID and make the signing profiles with the account from step 2. The export step uploads the build itself (`destination: upload` in `release/ExportOptions.plist`). `ios/build/` is gitignored.

If the archive works but the export can't sign or upload, run `open build/Talk.xcarchive` so Xcode adds it to Window → Organizer. Then choose Distribute App → Custom → App Store Connect → Upload, keep automatic signing, and untick "Manage version and build number". The one-click "TestFlight & App Store" option may change the build number.

| Error | Fix |
| --- | --- |
| 90592, "Invalid Export Compliance Code" | The code in `ios/project.yml` is missing, mistyped or not yet approved, or `xcodegen` didn't run after the edit |
| The bundle version must be higher | Raise `CURRENT_PROJECT_VERSION` again |
| "Your team has no devices from which to generate a provisioning profile" | Register an iPhone under Certificates, IDs & Profiles → Devices, then rerun the archive |
| No profile or App ID for `com.abhishekshekhar.talk.share` | Register it in Certificates, IDs & Profiles → Identifiers (no capabilities), then rerun the archive |
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
