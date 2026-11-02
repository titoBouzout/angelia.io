# angelia.io

WebSockets Server and Client API for Node.js and the browser, with
rooms support.

The goal of this project is to provide a developer friendly API that
just works™.

## Installation

`npm install angelia.io`

## Example

```js
// server.js (node.js)

import Server from 'angelia.io/server'

class FancyChat {
	typing(socket, data) {
		console.log('Im', data ? ' typing' : ' not typing')
	}
	theMessage(socket, data, reply) {
		console.log('the message is', data, socket)
		socket.emit('gotIt', 'thanks')
		reply('yes Im sure')
	}
}

Server.on(FancyChat)

class myConnection {
	connect(socket, request) {
		console.log('socket connected', socket.ip, request.headers)
	}
	disconnect(socket, code, reason) {
		console.log('socket disconnected', socket, code, reason)
	}
}
Server.on(myConnection)

await Server.listen({ port: 3001 })

// index.js (browser)

import Client from 'angelia.io/client'

const socket = new Client({ url: 'ws://localhost:3001' })

socket.emit('typing', true)

setTimeout(() => {
	socket.emit('typing', false)
	socket.emit('theMessage', 'hi there!', data => {
		console.log('yep', data)
	})
}, 5000)

socket.on('gotIt', message => {
	console.log('Server got it', message)
})
```

## Server Documentation (Node.js)

### `Server.listen` Options

| name              | kind    | default     | description                                                                                                   |
| ----------------- | ------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `hostname`        | String  | `127.0.0.1` | the hostname (interface) to bind to                                                                           |
| `port`            | Number  | 3001        | the TCP port to listen on; `0` lets the OS pick one, read it from `Server.port` after `listen()`              |
| `path`            | String  | `/angelia`  | the WebSocket path; clients connect to it by putting it in their `url`                                        |
| `timeout`         | Number  | 60000       | time in milliseconds after a socket is considered gone, minimum value is 10000                                |
| `maxMessageSize`  | Number  | 5           | max size of a single incoming message, in megabytes                                                           |
| `skipUTF8Validation` | Boolean | true     | skip UTF-8 validation of incoming frames; pass `false` to close connections that send invalid UTF-8           |
| `cert`            | String  | undefined   | path to a PEM-encoded TLS certificate file. With `privKey`, the server speaks `wss://`; otherwise `ws://`      |
| `privKey`         | String  | undefined   | path to the PEM-encoded private key file                                                                      |
| `trustProxy`      | Boolean | false       | read client IP from `X-Forwarded-For` on the upgrade request (spoofable without a trusted proxy)              |
| `watch`           | Boolean | false       | watch the parent directories of `cert` / `privKey` and call `reloadCerts()` on change (Let's Encrypt renewal) |
| `watchDebounceMs` | Number  | 1000        | how long to wait after a watcher event before reloading, so cert + key written together reload once          |

### TLS

Pass `cert` and `privKey` to serve `wss://` directly, or terminate TLS
at a proxy in front and listen on plain `ws://` (with `trustProxy` so
`socket.ip` comes from `X-Forwarded-For`).

```js
await Server.listen({
	port: 3001,
	cert: '/etc/letsencrypt/live/example.com/fullchain.pem',
	privKey: '/etc/letsencrypt/live/example.com/privkey.pem',
	// Auto-reload on Let's Encrypt renewal (off by default)
	watch: true,
})
```

### `Server` Object

The `server` object can be accessed from everywhere

#### List of `Server` Object Properties

| signature                             | kind     | description                                                                            |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `since`                               | Number   | timestamp of initialization                                                            |
| `now`                                 | Number   | timestamp that updates every half a second                                             |
| `port`                                | Number   | port used by this server                                                               |
| `hostname`                            | String   | the hostname if any                                                                    |
| `timeout`                             | Number   | after how long the socket is considered gone, in ms                                    |
| `served`                              | Number   | count of sockets ever connected                                                        |
| `bytesReceived`                       | Number   | sum of bytes the server has ever received                                              |
| `bytesSent`                           | Number   | sum of bytes sent by the server                                                        |
| `messagesGarbage`                     | Number   | count of messages without a listener                                                   |
| `messagesReceived`                    | Number   | count of messages ever received                                                        |
| `messagesSent`                        | Number   | count of messages ever sent                                                            |
| `messagesSentCacheHit`                | Number   | count of messages ever sent that were cached                                           |
| `serverErrors`                        | Number   | count of server errors                                                                 |
| `socketErrors`                        | Number   | count of socket errors                                                                 |
| `events`                              | Object   | handlers for client messages, ex: server.events.typing() to dispatch typing to anyone listening to it |
| `hooks`                               | Object   | handlers for the predefined server events below (`connect`, `disconnect`, …)            |
| `on(Class)`                           | Function | attaches all methods of a `Class` as listeners                                         |
| `emit(key, [value])`                  | Function | emits to all connected sockets                                                         |
| `broadcast(sender, key, [value])`     | Function | emits to all connected sockets except sender                                           |
| `sockets`                             | Set      | every currently connected socket                                                       |
| `reloadCerts()`                       | Function | re-read `cert`/`privKey` from disk and swap them in. Open connections are untouched. Safe to call manually (e.g. on `SIGHUP`); the watcher uses it internally |

### `Socket` Object

The `socket` object is given to you by a listener

#### List of `Socket` Object Properties

| signature                      | kind     | description                                                                                                                                                                                                                       |
| ------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server`                       | Object   | reference to the server                                                                                                                                                                                                           |
| `ip`                           | String   | ip of the socket                                                                                                                                                                                                                  |
| `userAgent`                    | String   | user agent of the socket                                                                                                                                                                                                          |
| `params`                       | Object   | the params sent via the client constructor (parsed from the WebSocket URL query); includes `connid`, a per-client id stable across reconnects. The reserved `m` param (URL-packed messages) is parsed off and not exposed here |
| `since`                        | Number   | timestamp of first seen                                                                                                                                                                                                           |
| `seen`                         | Number   | timestamp of last received message                                                                                                                                                                                                |
| `ping`                         | Number   | delay with the socket in milliseconds (full round trip)                                                                                                                                                                           |
| `timedout`                     | Boolean  | whether we lost connection with this socket                                                                                                                                                                                       |
| `bytesSent`                    | Number   | sum of bytes sent to this socket                                                                                                                                                                                                  |
| `bytesReceived`                | Number   | sum of bytes received from this socket                                                                                                                                                                                            |
| `messagesSent`                 | Number   | count of messages sent to this socket                                                                                                                                                                                             |
| `messagesReceived`             | Number   | count of messages received from this socket                                                                                                                                                                                       |
| `rooms`                        | Set      | the rooms this socket is in                                                                                                                                                                                                       |
| `emit(key, [value, callback])` | Function | emits to client; with a callback, returns a promise for its result, rejected with `Error('disconnected')` if the socket closes first                                                                                                                                                                                                              |
| `disconnect([noReconnect, reason])` | Function | closes the WebSocket, pass `true` to prevent re-connections; `reason` (up to 123 bytes) is sent to the client                                                                                                              |

### Server Listeners

Listen to an event by creating a class with any name, and give to
methods the name of the things you want to listen to. Then add the
class to the listeners as `Server.on(MyClass)` and you are done.

On user defined listeners, the listener receives three things as sent
by the client: `socket`, `data` and a `callback`; Example:
`class FancyChat { typing(socket, data, callback?) { console.log(socket, data) }}`.

#### Restricting which methods become listeners

By default, **every** method on the class becomes an event handler —
including helpers you might have meant to keep internal. To opt in to
a specific subset, declare a `static listeners` array of method names:

```js
class Chat {
	static listeners = ['typing', 'theMessage']

	typing(socket, data) {
		/* … */
	}
	theMessage(socket, data, reply) {
		/* … */
	}

	formatMessage(text) {
		// not registered — not in the array
		return text.trim()
	}
}
Server.on(Chat)
```

When `static listeners` is omitted, both prototype methods and own
methods of the instance are registered. Private methods (`#name()`)
are never enumerated and are always safe to use for helpers.

A second way to keep helpers off the event surface is to put them on a
base class and extend it. `Server.on(Class)` only enumerates the
immediate prototype, so inherited methods are skipped:

```js
class Helpers {
	formatMessage(text) {
		// not registered — on the parent
		return text.trim()
	}
}
class Chat extends Helpers {
	typing(socket, data) {
		/* … */
	}
	theMessage(socket, data, reply) {
		/* … */
	}
}
Server.on(Chat)
```

#### List of Predefined `Server` Events

There's a bunch of handy predefined events dispatched. They are fired
by the server only and live in `Server.hooks`, apart from the handlers
in `Server.events` that clients call: a client message using one of
these names goes to `garbage`, as does any message that isn't a
`[key, value?]` array. `Server.on(Class)` sorts a class's methods into
the right one by name.

| signature                    | description                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen()`                   | when the server is about to listen                                                                                                                |
| `connect(socket, request)`   | when a socket connects; `request` is `{ headers, url }` from the upgrade — read cookies / auth / custom headers here, it's not kept on the socket |
| `disconnect(socket, code, reason)` | when a socket gets disconnected, with the WebSocket close code and reason (1006 and `''` when the connection just dropped)                                                                                                                |
| `ping(socket)`               | when we got an update of the ping for a socket                                                                                                    |
| `timeout(socket, delay)`     | when we are about to disconnect a timedout socket, gives the delay in milliseconds                                                                |
| `garbage(socket, data)`      | if the client sends a message that the server has no listener this will be dispatched                                                             |
| `incoming(socket, messages)` | for debugging: ref to array of incoming messages received before dispatching to listeners                                                         |
| `outgoing(socket, messages)` | for debugging: ref to array of outgoing messages before sending to socket                                                                         |

## Client API (Browser)

### `Client` Options

Arguments for the constructor

```js
const socket = new Client({
	url: 'ws://localhost:3001',
	params: function () {
		return { fast: 'data', test: 'a space' }
	},
	noConnect: true,
})
socket.connect()
```

`url` must be `ws://` or `wss://`. Without a path the client connects
to `/angelia`, the server's default; include the path
(`wss://example.com/chat`) when the server sets another `path`.

#### Web Worker

By default the WebSocket runs in a Web Worker: messages are still
stringified and parsed on the main thread, but the browser's own send
and receive work and the heartbeat reply happen off it. In Chromium
that work is the expensive part of moving large payloads; Firefox
still routes a worker's socket events through the main thread, so it
gains less. `npm run bench:worker` measures it.

The worker is built from a `blob:` URL so the package needs no extra
file. Under a Content Security Policy without `worker-src blob:`, pass
`worker: false` to keep the socket on the main thread. Environments
without `Worker` (Node.js) use the main thread automatically.

### `Client` API

The client API is similar to regular event handling

| signature                      | kind     | description                                                                                                                                                |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connected`                    | Boolean  | `true` when the socket is connected else `false`                                                                                                           |
| `connect()`                    | Function | connects to the server, it auto-connects on disconnection                                                                                                  |
| `disconnect([noReconnect, reason])` | Function | disconnects from the server, pass `true` to prevent re-connections; `reason` (up to 123 bytes) is sent to the server                                  |
| `on(key, callback)`            | Function | listens for an event, returns an `off` function to stop listening                                                                                          |
| `emit(key, [value, callback])` | Function | emits data to the server                                                                                                                                   |

#### List of Predefined `Client` Events

As in `socket.on('connect', () => console.log('connect happened!'))`

| signature    | description                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `connect`    | **this happens only once** when we connect to the server, any future connection is a `reconnect`         |
| `reconnect`  | if we were connected at least once, then any re-connection will dispatch this event instead of `connect` |
| `disconnect` | when we disconnect from the server                                                                       |

#### Messages sent before connecting

Messages emitted before the first connection opens ride on the connect
URL (as many as fit, in order) and are dispatched as soon as the
server accepts the socket; the rest follow over the socket. Packing
keeps the handshake's request line within nginx's default 8 KB header
buffer. If that connection fails, they are queued again and later
attempts send everything over the socket, in case the URL itself was
rejected. Packed messages show up in proxy and server access logs.

#### Reconnect behavior

When a connection that was up for a while drops, the client reconnects
right away. Failed attempts, and connections dropped as soon as they
opened, are retried after a random 2–4s delay so clients don't all
come back at once.

On reconnect, any messages still queued for send are dropped, and
pending `emit` reply promises reject with `Error('reconnecting')`.
The library can't tell which queued messages are safe to replay (a
typing indicator: yes; a "transfer $100": maybe not), so recovery is
the application's responsibility — listen for the `reconnect` event
and re-send whatever your protocol needs.

## Rooms

### Via a `Rooms` list

1. Create a room class that extends `Room`
2. Create a room list that will allow joining sockets
3. Join a socket in a room, a socket may join multiple rooms. Rooms
   are created when the `id` of the room doesn't exists, and deleted
   when there are no sockets in the room and the room doesn't have the
   flag `persistent`
4. A socket will leave automatically all rooms on disconnection
5. `socket.rooms` is an array with all the rooms the socket joined
6. `id` is assigned to the room on creation

```js
import { Room, Rooms } from 'angelia.io/server'

class GameRoom extends Room {
	persistent = false

	onCreate(socket) {
		console.log('creating room', this.id, socket)
	}
	onDelete(socket) {
		console.log('deleting room', this.id, socket)
	}

	onJoin(socket) {
		console.log('socket joined room', this.id, socket)
		socket.game = this
		this.emit('user joined', 'data here')
	}
	onLeave(socket) {
		console.log('socket left room', this.id, socket)
		socket.game = undefined
		this.emit('user left', 'data here')
	}
}

// games is a room list
const games = new Rooms(GameRoom)

class Connection {
	connect(socket) {
		games.join(socket, 'room id here')
		socket.game.id === 'room id here'
		console.log(socket.rooms)
		games.leave(socket, 'room id here')

		games.join(socket, 'a different room')
		socket.game.id === 'a different room'
		games.leave(socket, 'a different room')
	}
}

Server.on(Connection)
Server.listen()
```

#### `Rooms` Class

| signature                             | kind   | description                                    |
| ------------------------------------- | ------ | ---------------------------------------------- |
| `get(id)`                             | method | gets room with such an `id`                    |
| `join(socket, [id])`                  | method | adds socket to room `id`                       |
| `leave(socket, [id])`                 | method | removes socket from room `id`                  |
| `sockets`                             | Set    | sockets across every room in this list, each once |
| `list`                                | Array  | every room in this room list                   |
| `emit(key, [value])`                  | method | emits to all sockets in this room list         |
| `broadcast(socket, key, [value])`     | method | emits to other sockets in this room list       |

### Via a `Room`

1. Create a room instance that extends `Room`
2. Join a socket in a room, a socket may join multiple rooms.
3. A socket will leave automatically all rooms on disconnection
4. `socket.rooms` is an array with all the rooms the socket joined
5. Keep in mind that `onCreate` and `onDelete` are not dispatched when
   the room is manged by yourself. The construtor could be used for
   simulating `onCreate` and `onDelete` only you will know when to
   dispose such a variable.

```js
import { Room } from 'angelia.io/server'

class Lobby extends Room {
	persistent = true
	id = 'lobby'
	onJoin(socket) {
		console.log('socket joined room', this.id, socket)
	}
}

// lobby is just 1 room
const lobby = new Lobby()

class Connection {
	connect(socket) {
		lobby.join(socket)

		lobby.leave(socket)
	}
}

Server.on(Connection)
Server.listen()
```

#### `Room` Class

| signature                             | kind    | description                                      |
| ------------------------------------- | ------- | ------------------------------------------------ |
| `onCreate(socket)`                    | method  | dispatched when the room is created              |
| `onDelete(socket)`                    | method  | dispatched when the room is deleted              |
| `onJoin(socket)`                      | method  | dispatched when a socket joins the room          |
| `onLeave(socket)`                     | method  | dispatched when a socket leaves the room         |
| `persistent`                          | boolean | to not delete rooms when there are no sockets in |
| `sockets`                             | Set     | sockets in the room                              |
| `emit(key, [value])`                  | method  | emits to all sockets in the room                 |
| `broadcast(socket, key, [value])`     | method  | emits to other sockets in the room               |
| `id`                                  | any     | the room id                                      |
| `join(socket)`                        | method  | adds a socket to the room                        |
| `leave(socket)`                       | method  | remves a socket from the room                    |

### `sockets` in `Server`, `Room` and `Rooms`

A `Set` of sockets, so joins, leaves and disconnects stay O(1) at any
size. Use `size` for the count, `for…of` to walk it, and
`sockets.values().map(…)` / `.filter(…)` or `[...sockets]` for array
methods.

## Typed events

Declare your events in one `declare module` block and every `emit`,
`on`, `reply`, and `Server.on(Class)` on both sides becomes
type-checked. Without a declaration everything stays loose (`any`), so
this is opt-in — but the DX win is big.

```ts
// types/events.d.ts — or anywhere in your project
declare module 'angelia.io/server' {
	// data the client sends to the server
	interface ServerEvents {
		typing: boolean
		theMessage: string
	}
	// data the server sends to the client
	interface ClientEvents {
		gotIt: string
		bigState: { rows: string[] }
	}
	// reply shapes when the OTHER side handles a callback-bearing emit
	interface ServerReplies {
		theMessage: string // server's reply when client emits `theMessage`
	}
	interface ClientReplies {} // usually empty
}
```

Four interfaces cover the four directions:

| interface       | meaning                                          |
| --------------- | ------------------------------------------------ |
| `ServerEvents`  | payloads the **client emits** (server handles)   |
| `ClientEvents`  | payloads the **server emits** (client handles)   |
| `ServerReplies` | what the **server replies** to a client callback |
| `ClientReplies` | what the **client replies** to a server callback |

With the map in place:

```ts
// server
class Chat {
	typing(socket, data) {
		// data: boolean (inferred from ServerEvents)
	}
	theMessage(socket, data, reply) {
		// data: string
		reply?.(data.toUpperCase()) // reply arg: string (from ServerReplies)
	}
}
Server.on(Chat)

socket.emit('gotIt', 'yes') // ✓
socket.emit('gotIt', 42) // ✗ type error
socket.emit('unknown', 'x') // ✗ type error

// client
client.emit('typing', true) // ✓
const answer = await client.emit('theMessage', 'hi', r => r.length)
// answer: number (promise resolves with cb's return value)

client.on('gotIt', msg => msg.toUpperCase()) // msg: string
```

Only declare the keys you care about — undeclared keys stay `any`.
Extra methods on listener classes (helpers, predefined events like
`connect` / `disconnect`) are allowed alongside event handlers.

## Authors

- Tito Bouzout https://github.com/titoBouzout
- Anthony K. https://github.com/boredofnames

## URLs

- https://github.com/titoBouzout/angelia.io
- https://www.npmjs.com/package/angelia.io
