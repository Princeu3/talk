# Talk

Private messages, files and calls for a few people. Runs at https://talk.princeuniverse.dev.

Messages and files are encrypted on your device before they leave it. The server stores only ciphertext plus who talked to whom and when. Calls open in the meetup app as a direct (peer-to-peer) video call.

## Join (for friends)

1. Open the invite link you were sent. It works once and expires in 7 days.
2. Pick a name and a passphrase. Four random words works well.
   - Your passphrase is your key. Nobody can reset it. Forget it and your old messages are gone.
   - Use the same name and passphrase on every device.
3. On iPhone, add Talk to your Home Screen: tap Share, then **Add to Home Screen**, then open Talk from the new icon. iPhone only sends notifications to apps added this way.
4. In Talk, tap the person icon (top left) to open Settings, then tap **Turn on notifications**.
5. Check safety codes: on a call or in person, open Settings and compare the code next to each name. If they match on both phones, nobody swapped a key.

## Calls

Tap the video icon in a chat. The other person gets a ringing banner (and a notification if Talk is closed). Calls are direct between devices. If a call can't connect, tap **Open in browser** in the call screen.

## Run locally

Needs Node 24 or newer.

```bash
npm install
SETUP_CODE=local-setup npm run dev
```

Open http://localhost:5173/?invite=local-setup to create the first account.

```bash
npm run check   # typecheck
npm test        # end-to-end tests
```

## Deploy

Railway project `talk`, one service with a volume at `/data`. Deploy with `railway up`.

| Variable | Purpose |
| --- | --- |
| `DATA_DIR` | Where the database and encrypted files live (`/data` on Railway) |
| `NODE_ENV` | `production` turns on secure cookies |
| `CALL_URL` | Meetup base URL (defaults to the meetup Railway app) |
| `SETUP_CODE`, `SESSION_SECRET`, `VAPID_KEYS` | Optional; generated and stored in the database when unset |

The first-account link (`/?invite=<setup code>`) is printed in the deploy logs while no account exists.

## What it doesn't do

- No forward secrecy: anyone who gets a passphrase can read that person's history.
- Removing someone from a group isn't supported.
- Railway sees metadata (who, when, message sizes), never content.
