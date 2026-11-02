# angelia.io demo

A small chat that exercises the whole API surface. Each button maps to
one feature so it's easy to see what produces what on the wire.

## What's demonstrated

**Connecting**

- `params: { name, room }` rides on the connect URL — the server reads
  `socket.params.name` / `socket.params.room` in its `connect` handler
- `connect` / `reconnect` / `disconnect` listener events drive the
  status pill

**Messaging**

- `client.emit(k, v)` — send (the **send** button, plus **send 64KB**
  for a large payload)
- `client.emit(k, v, cb)` — the reply-callback promise. Used for chat
  ack, RTT measurement, and the big-payload size confirmation.

**Fan-out**

- `room.emit` — the `msg` handler reaches every member of the room
- `room.broadcast` — **whisper** and the typing indicator skip the
  sender
- `Server.emit` — **shout to everyone** reaches every connected socket
  regardless of room

**Server-initiated**

- `socket.emit` — server pushes `roster` / `joined` / `left`
- **ask server to push** has the server `socket.emit` an 8KB payload
- `socket.disconnect(noReconnect, reason)` — **server-side disconnect**
  closes the connection with a reason; client auto-reconnects

**Disconnect / reconnect**

- `client.disconnect()` — soft, the client reconnects on its own (at
  once if the connection had been up a while, else after 2–4s)
- `client.disconnect(true, reason)` — hard, disables auto-reconnect.
  The page exposes a **reload** button to recreate the Client.

**Rooms**

- `Rooms` + `Room` from `angelia.io/server` — created on first join,
  deleted on last leave (non-persistent default). Switch live via the
  input at the top, or paste a `#room` URL hash.

## Run

1. Boot both servers:
   ```sh
   npm run demo
   ```
2. Open <http://localhost:8000>. Open multiple tabs
   to chat with yourself. Each tab can be in a different room — the
   room follows the URL hash, so:
   - <http://localhost:8000/#general>
   - <http://localhost:8000/#random>

## Layout

```
tests/demo/
├── server.js      — angelia.io on :3001 + page server on :8000
├── index.html     — page shell (CSS, importmap, mount point)
└── src/
    ├── main.js          — entry; imports connection, mounts <App/>
    ├── identity.js      — sessionStorage-backed name + initial room
    ├── state.js         — signals (status, room, online, messages, …)
    ├── connection.js    — Client instance + event → state wiring
    ├── actions.js       — user-triggered functions (one per button)
    └── components/
        ├── App.js          — top-level layout + xml.define
        ├── Header.js       — status pill + RTT + identity
        ├── RoomBar.js      — room label + switch input
        ├── ChatLog.js      — message log + typing indicator
        ├── ChatForm.js     — chat input + send / whisper
        ├── Roster.js       — "in this room: …"
        ├── FanOut.js       — fan-out + payload buttons
        ├── Stats.js        — server / socket / rooms snapshot
        └── Connection.js   — disconnect / reconnect controls
```

The flow is:

- `connection.js` owns the Client and writes to the signals in
  `state.js` whenever the server fires an event (`roster`, `joined`,
  `msg`, `push`, …).
- `actions.js` exposes one function per button — each captures the
  wire-protocol pattern for that feature (e.g. `sendMessage` is
  `client.emit('msg', text, ack)`).
- Components in `src/components/` import state to read it reactively
  and import actions to invoke them. They never touch the Client
  directly except for the chat input's typing indicator.

On the server side, `server.js` registers three listener classes —
`Chat`, `Probes`, `Admin` — via three `Server.on()` calls. Each class
covers one slice of the demo (chat lifecycle, payload probes,
introspection + kick). A `DemoRoom extends Room` flags the `lobby`
room as persistent in `onCreate`, so it sticks around when empty.

The page server (in `server.js`) serves
[pota](https://pota.quack.uy/) source straight out of `node_modules`
so the importmap can resolve `pota`/`pota/xml` without a CDN or
bundler.
