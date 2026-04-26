# angelia.io demo

A small chat that exercises the whole API:

- pre-connect emit (the `name` and initial `room` params go in the
  connect URL)
- server-initiated emit (`roster`, `joined`, `left`)
- broadcast that skips the sender (`typing`)
- reply callback round-trip (delivery ack on each `msg`, room name on
  each `switch`)
- per-room fan-out via `Rooms` — `room.emit` reaches members,
  `room.broadcast` reaches members minus the sender
- room lifecycle: rooms are created on first join, deleted on last
  leave (non-persistent default)

## Run

1. Generate a self-signed cert (once every two weeks):
   ```sh
   npm run gen-cert
   ```
2. Boot both servers:
   ```sh
   node tests/demo/server.js
   ```
3. Open <http://localhost:8000> in Chrome or Edge. Open multiple tabs
   to chat with yourself. Each tab can be in a different room — the
   room follows the URL hash, so:
   - <http://localhost:8000/#general>
   - <http://localhost:8000/#random>

   You can also switch rooms live via the input at the top of the page,
   or by editing the hash.

## Layout

- `server.js` — angelia.io server on `:3001` (WebTransport) plus a tiny
  HTTP page server on `:8000`. The page server injects the cert SHA-256
  into the HTML so the browser can pin it without needing a real CA.
- `index.html` — UI shell with a status pill, message log, typing
  indicator, and roster.
- `demo.js` — browser-side glue using `client/index.js` directly.

WebTransport requires a secure context. `http://localhost` counts as
secure for browsers, so the page itself doesn't need TLS — only the
WebTransport server does.
