# Changelog

## Unreleased

Changes since 4.0.91, the last published version. The wire protocol
changed: upgrade the client and the server together.

### Breaking

- **Lifecycle handlers moved to `Server.hooks`.** `connect`,
  `disconnect`, `listen`, `ping`, `timeout`, `garbage`, `incoming` and
  `outgoing` no longer live in `Server.events`, so clients can't
  trigger them. `Server.on(Class)` sorts methods automatically; only
  code assigning `Server.events.connect = …` directly needs to change.
- **`listen()` is async** and rejects on failure; call `stop()` before
  listening again.
- **Default `hostname` is `127.0.0.1`.** It used to listen on every
  interface. Pass `hostname: '0.0.0.0'` when no proxy sits in front.
- **Client `url` must be `ws://` or `wss://`**, passed as
  `{ url }`; the `new Client('ws://…')` string form is gone. A path in
  the URL is now used instead of always connecting to `/angelia`.
- **Telling a client not to reconnect** is a protocol message sent by
  `socket.disconnect(true)`. Emitting `disconnect` to a client no longer
  closes it.
- **`client.disconnect()` without `true` reconnects** afterwards; it
  used to stay disconnected. Pass `true` to stay closed.
- **Reconnects drop queued messages** and reject pending reply
  promises with `Error('reconnecting')`, instead of replaying them.
- **`X-Forwarded-For` is only read with `trustProxy: true`.**
- **`skipUTF8Validation` defaults to `true`.**
- **Removed:** `once` / `broadcastOnce`, `connections`, `Rooms.map` /
  `Rooms.filter`, `maxPostSize`, and the client's `decode()` with its
  Blob / ArrayBuffer encoding. Binary support is being redesigned.
- **`Rooms.sockets` is a `Set`**, like `Server.sockets`,
  `Room.sockets` and `socket.rooms`, and lists each socket once.

### Added

- TLS: `cert` / `privKey` serve `wss://`; `watch` and `reloadCerts()`
  swap renewed certs in without dropping connections. `stop()`.
- `path` option, and `port: 0` for an OS-assigned port.
- `socket.emit(k, v, cb)` returns a promise for the callback's result,
  rejected with `Error('disconnected')` if the socket closes first.
- `disconnect(socket, code, reason)` gets the close reason, and both
  `disconnect()` methods take a `reason`.
- `worker: false` client option, to keep the socket on the main thread
  under a Content Security Policy without `worker-src blob:`.
- TypeScript declarations with typed event maps.

### Changed

- Reconnect timing: at once when a connection that was up drops; after
  a random 2–4s delay when an attempt fails or a connection drops right
  after opening.

### Fixed

- Malformed client messages go to `garbage` instead of crashing the
  server.
- A socket that joins a room after disconnecting is ignored instead of
  staying in the room forever.
