# Talk

Node 24+ runs `server/*.ts` directly (type stripping): imports need `.ts` extensions, no enums or parameter properties. Database is `node:sqlite`.

## Commands
- `npm run dev`: server on :3000 plus Vite on :5173 (needs `SETUP_CODE` for a first account)
- `npm run check`: typecheck
- `npm test`: end-to-end tests (spawns the server)
- `railway up`: deploy (project `talk`, volume at `/data`)
- `railway up relay --path-as-root -p 093e4eba-958d-4c1e-8d34-915c4288894a -e production -s relay`: deploy the push relay (project `talk-push`); plain `railway up .` from `relay/` fails with "prefix not found"
- `cd ios && xcodegen`: regenerate `Talk.xcodeproj` from `project.yml` (the project file is not committed)
- `xcodebuild test -project ios/Talk.xcodeproj -scheme Talk -destination 'platform=iOS Simulator,name=iPhone 18 Pro'`: iPhone crypto interop tests

## Gotchas
- Keep every server change backward compatible: the live web app and the iPhone app talk to the same API.
- APNs pushes carry ids only; the relay (`relay/index.ts`) builds payloads itself, so never pass text through it.
- Resolve paths from env with `path.resolve`; `res.sendFile` rejects relative paths.
- Set long-lived cache headers through `sendFile` options, never before the call, or a cached error sticks for a year.
- Write Tailwind classes as full literal strings; built names like `rounded-t${side}-md` never get generated.
- Railway sets `PORT=8080`; point domains at 8080.
- Calls are 1:1 WebRTC, signaled over our socket (`server/calls.ts`, `src/lib/useCall.ts`) and never stored. `/api/ice` hands out Cloudflare TURN credentials from `CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN`, since Railway can't host TURN (no UDP). To test the cellular path, force `iceTransportPolicy: 'relay'` in the browser.
- The iPhone app's crypto must match `src/lib/crypto.ts` byte for byte; `ios/Tests/vectors.json` comes from `ios/Tests/make-vectors.ts`, so regenerate it after any web crypto change.
- The Simulator ends every CallKit call (no system call UI there), so calls only test on a device. Messages, sign-in and settings test fine against a local server (`http://localhost:<port>/?invite=...`, allowed by `NSAllowsLocalNetworking`).
- Test browser profiles may keep year-cached 500s for old attachments; a 500 with no server log line is that cache, not a bug.

## Design
- Palette: soft white `#e8e9df`, sage `#a9b887`, deep olive `#2e3d28`, split 60/30/10: backgrounds / your own bubbles and selected states / actions, badges, focus. Use the tokens in `src/styles.css`, never raw hex or `text-white` in components (the black call and photo overlays are the exception).
- Each token holds both themes as `light-dark()`. Theme choice (system/light/dark) is per device: `localStorage` `theme` plus `data-theme` on `<html>`, set before paint in `index.html` and by `src/lib/theme.ts`. Don't use Tailwind `dark:`; it only follows the system.
- Put text on `bg-fill` as `text-on-fill`: fill is olive in light and sage in dark, so white text fails in dark.
- Avatars are generated SVG art seeded by name (`Avatar` in `Sidebar.tsx`), drawn from the palette shades; keep backgrounds to the middle shades so circles show on both page colors.
- Check new UI patterns against Mobbin (iOS and web) before building them.