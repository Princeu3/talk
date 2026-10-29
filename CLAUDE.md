# Talk

Node 24+ runs `server/*.ts` directly (type stripping): imports need `.ts` extensions, no enums or parameter properties. Database is `node:sqlite`.

## Commands
- `npm run dev`: server on :3000 plus Vite on :5173 (needs `SETUP_CODE` for a first account)
- `npm run check`: typecheck
- `npm test`: end-to-end tests (spawns the server)
- `railway up`: deploy (project `talk`, volume at `/data`)

## Gotchas
- Resolve paths from env with `path.resolve`; `res.sendFile` rejects relative paths.
- Set long-lived cache headers through `sendFile` options, never before the call, or a cached error sticks for a year.
- Write Tailwind classes as full literal strings; built names like `rounded-t${side}-md` never get generated.
- Railway sets `PORT=8080`; point domains at 8080.
- Calls are P2P through meetup, which only hands out STUN; Railway can't host TURN (no UDP).
