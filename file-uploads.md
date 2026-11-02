# File uploads / binary data

Design notes for adding binary-data support to angelia.io. Not yet
implemented — capturing the plan so we agree on the shape before
shipping it.

## The gap

Today the lib has no binary path. `emit` `JSON.stringify`s its payload,
so a file has to be base64-encoded first: a 50 MB file balloons to
~67 MB, runs a multi-megabyte stringify, and while it's on the wire it
blocks every other message on the socket.

The server currently treats any binary frame as garbage
(`Socket.onmessage` ignores ws's `isBinary` flag).

## What ws gives us

- **Binary frames** (opcode 2) carry raw bytes; ws hands the server a
  `Buffer` with `isBinary = true`. Browsers send `Blob`, `ArrayBuffer`
  and typed arrays as binary frames directly.
- **One ordered channel per connection.** Unlike WebTransport there are
  no parallel streams: a large frame delays everything queued behind
  it — replies, typing indicators, pings. Anything big has to be
  chunked or go elsewhere.
- **`maxPayload`** (`maxMessageSize`, 5 MB default) caps each frame;
  anything larger closes the connection.
- **The worker client** can take a `Blob` over `postMessage` without
  copying its bytes and `send()` it from the worker, so uploads don't
  touch the main thread.

## Three viable shapes

### Option 1 — `emit` with embedded binaries (the everyday case)

`emit` walks the value and detects any `Blob` / `File` / `Uint8Array`
/ `ArrayBuffer` anywhere in the tree. If it finds any, it replaces each
with a placeholder and sends the JSON message followed by one binary
frame per attachment. If it finds none, behavior is exactly today
(JSON only, batched).

```js
// Client — just put blobs anywhere in your value.
socket.emit('chat', {
  text: 'check these out',
  attachments: [
    { name: 'a.jpg', file: blob1 },
    { name: 'b.png', file: blob2 },
  ],
})

// Server — handler is the regular (socket, value, reply) shape.
// Blobs come back as Buffers in the same place they appeared in the
// source value.
class Chat {
  chat(socket, { text, attachments }, reply) {
    for (const { name, file } of attachments) {
      // file is a Buffer
    }
    reply?.('stored')
  }
}
```

This is essentially how socket.io handles binary. Caller never thinks
about the wire shape; it just works. Each attachment must fit
`maxMessageSize`.

### Option 2 — chunked `stream(k, meta, payload, cb?)` over the socket

Single binary payload, split into chunks (e.g. 64 KB) sent as binary
frames; the server handler gets a `ReadableStream` it can pipe to disk
without buffering. Other messages interleave between chunks, so a big
upload delays them by one chunk at most rather than the whole file.

```js
// Client
await socket.stream(
  'upload',
  { name: 'video.mp4', mime: 'video/mp4' },
  hugeFile,
)

// Server
class Files {
  async upload(socket, meta, stream, reply) {
    const path = `/uploads/${meta.name}`
    await pipeline(Readable.fromWeb(stream), createWriteStream(path))
    reply?.({ url: `https://cdn/${path}` })
  }
}
```

Different handler signature (4 args including the stream); that's what
flags this as the streaming variant. Needs flow control: the sender
should wait on `bufferedAmount` (and the server on the stream's
backpressure) so a fast client can't queue the whole file in memory.

### Option 3 — HTTP upload next to the socket

The server already owns an HTTP(S) server (everything but the upgrade
returns 404). A `POST /angelia/upload` endpoint, authenticated by the
socket's `connid`, streams the body to a handler. It's a separate TCP
connection, so it never blocks the socket, and it's what nginx,
CDNs and browsers already handle well (progress events via `fetch` /
XHR, `client_max_body_size`). The pre-WebTransport code had a
commented-out `formidable` stub for exactly this.

Cost: a second request path to secure and document, and nginx needs a
`location` for it.

## Wire format (Options 1 and 2)

Text frames stay JSON batches. Binary frames start with a type byte:

```
0x01  <id: u32> <bytes>                      ← attachment for a pending emit
0x02  <id: u32> <seq: u32> <bytes>           ← stream chunk (empty = end)
```

For Option 1 the JSON message is `[k, value, cbId?]` with every binary
replaced by `{ __bin: id }`; the receiver holds the message until each
referenced id has arrived, swaps the placeholders for `Buffer`s and
dispatches. For Option 2 a JSON message `[k, meta, cbId?, streamId]`
opens the stream; chunks follow.

Replies come back through the usual `''`-key mechanism. Uniform
dispatch.

## Recommendation

Ship Option 1 for small binaries, and pick one of 2 or 3 for big
files.

| use case                      | API                                          |
| ----------------------------- | -------------------------------------------- |
| Chat with attached images     | `emit('msg', { text, images: [blob, …] })`   |
| Message with crypto signature | `emit('sign', { tx, sig: u8 })`              |
| Form submit with photo        | `emit('submit', { name, age, photo: blob })` |
| 500 MB video upload           | Option 2 `stream(...)` or Option 3 `POST`    |
| Server-pushed CSV export      | Option 2 `socket.stream(...)`                |

Option 3 is simpler and more robust for uploads; Option 2 also covers
server-to-client streaming and keeps one auth path.

## Trade-offs and subtleties

### Buffering vs streaming

- **Option 1 buffers all attachments** before firing the handler. Fine
  for KB–MB payloads. Bad for GB-scale.
- **Options 2 and 3 stream** — the handler pipes bytes through without
  buffering the whole payload.

### `ReadableStream` inside `emit`

Rule: **`emit` only handles concrete-bytes types** (`Blob`, `File`,
`Uint8Array`, `ArrayBuffer`). `ReadableStream` is reserved for
`stream`. Document the boundary.

### Reply latency on Option 1

The server can't reply until all attachments arrive. For "ack as soon
as you see this", send a small message first and the bytes separately.

### Fan-out semantics

- `Server.emit` / `Room.emit` with embedded binaries: the JSON frame
  and each attachment frame are framed once and shared across
  recipients, like today's `Server.cacheMessages`.
- `Server.stream` / `Room.stream`: slow consumers buffer up; v1 could
  skip fan-out and let apps loop over `room.sockets`.

### Abuse limits

A client could open many streams or send attachments that never
complete. Cap concurrent streams and pending attachments per socket,
and time out incomplete ones.

## Open questions before implementing

1. **Big files: Option 2 or Option 3?**
2. **Naming** for Option 2 — `stream`, `send`, `upload`?
3. **Server handler shape** for Option 2 —
   `(socket, meta, stream, reply)` 4-arg form OK, or a single
   `(socket, ctx)` object?
4. **Defer fan-out** of streams to a follow-up — yes?
5. **Defer progress events** — yes?
