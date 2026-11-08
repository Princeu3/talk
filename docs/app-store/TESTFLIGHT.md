# TestFlight upload

How to put the next Talk build on TestFlight from `master`. It is written for Abhishek, the Account Holder of team `34XFNGD2MY`, and for his Claude. Abhishek or Prince (Admin) does step 1. Abhishek does the Xcode sign-in in step 2 and the App Store Connect parts of step 5, since they need his account. Claude can do the rest. Prince's Mac can stand in for steps 2 and 4: see [From Prince's Mac](#from-princes-mac).

State on 2026-11-08:

- The App Store Connect record "Talk: Private Calls & Chat" (app id 6828441266, bundle ID `com.abhishekshekhar.talk`).
- App IDs `com.abhishekshekhar.talk` (Push Notifications, Communication Notifications), `com.abhishekshekhar.talk.notifications` and `com.abhishekshekhar.talk.share` (no capabilities).
- The team has one registered iPhone. Keep at least one: Xcode signs the archive with a development profile, which needs a device.
- The push relay sends for team `34XFNGD2MY` and bundle `com.abhishekshekhar.talk`.
- Builds 1 to 7 are on TestFlight (6 and 7 are version 1.1). Builds 8 to 10 are version 1.1.1 (2026-11-07), since 1.1 was approved and its train closed. Build 9 adds the speaker button in calls, build 10 Picture in Picture for video calls. Builds 1 to 4 were recorded as using no non-exempt encryption. The app sets no `ITSAppUsesNonExemptEncryption` key: with YES and no code, the upload is refused with error 90592, and App Store Connect only issues an `ITSEncryptionExportComplianceCode` after it reviews an uploaded export document (the "App Encryption Documentation" dialog under App Information is the gate in front of that upload, and saves nothing on its own). With the key absent, TestFlight shows each new build as "Missing Compliance" and asks the questions per build instead. Build 5 went through that way on 2026-11-01.
- Version 1.1.1 with build 10 is Waiting for Review since 2026-11-08, set to release once approved. Build 10 is the first with Picture in Picture, which the Simulator can't run, so it still needs a test on two phones. Swapping in a newer build means pulling the submission (Remove from Review), attaching the build, and submitting again, which puts it at the back of the queue.

## 1. Encryption questions (Abhishek or Prince, per build)

The bundled WebRTC library brings its own encryption for calls, so the app can't honestly say NO, and YES needs a code Apple only gives for a reviewed export document. So the app carries neither key, and whoever has the Account Holder, Admin or App Manager role answers in App Store Connect once per build. The answers are legal statements about the app, so a person clicks them, not Claude.

After step 4, App Store Connect → TestFlight → iOS shows the build as "Missing Compliance" with a Manage link. The answers, from [APP_STORE.md, Export compliance](APP_STORE.md#export-compliance):

1. Algorithms: "Standard encryption algorithms instead of, or in addition to, using or accessing the encryption within Apple's operating system". Not proprietary, not both, not none.
2. Available in France: No. France is already excluded under Pricing and Availability; keep the two in step.
3. No document is asked for. If one ever is, stop and tell Prince.

The build then reads "Ready to Submit".

## 2. Mac setup

- Xcode 27, signed in under Xcode → Settings → Accounts with the Apple ID that owns team `34XFNGD2MY` (Abhishek does this).
- XcodeGen: `brew install xcodegen`.
- The repo: `git clone https://github.com/Princeu3/talk.git`, or `git pull` on `master`.

## 3. Build number

In `ios/project.yml`:

- Set `CURRENT_PROJECT_VERSION` one above the higher of its value on `master` and the newest build under App Store Connect → TestFlight. App Store Connect refuses a number it has seen. On 2026-11-08 build 10 went up, so the next is 11.

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
| 90592, "Invalid Export Compliance Code" | `ITSAppUsesNonExemptEncryption` crept back into `ios/project.yml`. Remove it and rerun `xcodegen` |
| The bundle version must be higher | Raise `CURRENT_PROJECT_VERSION` again |
| 90186 "train version is closed" or 90062 | That version was approved. Raise `MARKETING_VERSION` (1.1 to 1.1.1), rerun `xcodegen` and archive again |
| "Your team has no devices from which to generate a provisioning profile" | Register an iPhone under Certificates, IDs & Profiles → Devices, then rerun the archive |
| "No Accounts" or no signing certificate | Sign in to Xcode as in step 2; Xcode makes an Apple Distribution certificate on the first export |

## 5. After the upload

- App Store Connect → TestFlight shows the build as Processing, which can take from a few minutes to over an hour.
- When it's ready, Abhishek answers the compliance questions (step 1) and adds the build to the internal testing group if it isn't there yet.
- What to Test:
  - calls
  - the microphone prompt at first launch, and the Settings link when the microphone or camera is off
  - the unread badge
  - chats opened offline
  - messages written offline, which send once, in order, when back online
  - Talk in the share sheet of Photos, Safari and Files, with Talk chats suggested in its top row
  - attachments over 25 MB, which download on a tap
- `xcodegen` also rewrites the tracked `ios/App/Info.plist`. Either open a pull request with `ios/project.yml` and `ios/App/Info.plist` together, or run `git checkout ios/App/Info.plist ios/project.yml` and send Prince the build number, so later builds start above it.

## From Prince's Mac

Prince's Mac signs by hand, so it needs no Apple ID in Xcode. Only that Mac has the private key of the team's Apple Distribution certificate (`86L82FD4U9`, in the login keychain) and the team's App Store Connect API key (in `~/.appstoreconnect/private_keys`, with its key ID and issuer ID in `~/.appstoreconnect/talk.env`, outside the repo). It also has the profiles "Talk App Store", "Talk Notifications App Store" and "Talk Share App Store" installed. They are made with that certificate and can be downloaded again from the portal.

Builds 1 to 4 came from Abhishek's Mac. The one upload from Prince's Mac, on 2026-10-31, was refused with 90592 (no compliance code) and 90474 (iPad orientations, fixed since: the app is iPhone only). Build 6 (version 1.1) went up this way on 2026-11-03, the first upload from this path that App Store Connect accepted, and build 7 the same day.

Step 1 still needs a person after every upload: Abhishek or Prince answers the compliance questions in TestFlight. Start from an up-to-date `master` with a clean `ios/` folder, do step 3, then run these from `ios/`:

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

Then do step 5, except its last bullet: commit `ios/project.yml` and `ios/App/Info.plist` together on `master` and push, so the next build starts from this number. Pushing `master` also redeploys the push relay and the demo server.

The certificate and the three profiles expire at 02:45 UTC on 2027-09-12, the evening of 2027-09-11 in the US. By the end of August 2027, make a new Apple Distribution certificate from this Mac and remake the three profiles with it under the same names. The API key can do this: it registered the share App ID and made its profile on 2026-11-01.

The same API key also does the App Store Connect clicks after an upload, apart from the compliance answers. On 2026-11-08 it added build 10 to the Talk Team group (`POST /v1/betaGroups/{id}/relationships/builds`), set What to Test (`PATCH /v1/betaBuildLocalizations/{id}`), and attached build 10 to version 1.1.1 (`PATCH /v1/appStoreVersions/{id}/relationships/build`).
