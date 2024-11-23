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
	typing(socket, data, callback) {
		console.log('Im', data ? ' typing' : ' not typing')
	}
	theMessage(socket, data, callback) {
		console.log('the message is', data, socket)
		socket.emit('gotIt', 'thanks')
		callback('yes Im sure')
	}
}

Server.on(FancyChat)

class myConnection {
	connect(socket, request) {
		console.log('socket connected', socket)
	}
	disconnect(socket, code, message) {
		console.log('socket disconnected', code, message, socket)
	}
}
Server.on(myConnection)

Server.listen()

// index.js (browser)

import Client from 'angelia.io/client'

const socket = new Client('ws://localhost:3001')

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

| name                 | kind    | default   | description                                                                    |
| -------------------- | ------- | --------- | ------------------------------------------------------------------------------ |
| `hostname`           | String  | undefined | the hostname if any                                                            |
| `port`               | Number  | 3001      | the port to use for this server                                                |
| `maxMessageSize`     | Number  | 5         | max size in mb of a message received                                           |
| `maxPostSize`        | Number  | 50        | max size in mb of a POST message                                               |
| `skipUTF8Validation` | Boolean | false     | allows to skip utf8 validation                                                 |
| `timeout`            | Number  | 60000     | time in milliseconds after a socket is considered gone, minimum value is 10000 |

### `Server` Object

The `server` object can be accessed from everywhere

#### List of `Server` Object Properties

| signature                             | kind     | description                                                                                    |
| ------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `since`                               | Number   | timestamp of initialization                                                                    |
| `now`                                 | Number   | timestamp that updates every half a second                                                     |
| `port`                                | Number   | port used by this server                                                                       |
| `hostname`                            | String   | the hostname if any                                                                            |
| `maxMessageSize`                      | Number   | maximum message size in mb                                                                     |
| `maxPostSize`                         | Number   | maximum POST size in mb                                                                        |
| `timeout`                             | Number   | after how long the socket is considered gone, in ms                                            |
| `connections`                         | Number   | count of sockets connected                                                                     |
| `served`                              | Number   | count of sockets ever connected                                                                |
| `bytesReceived`                       | Number   | sum of bytes the server has ever received                                                      |
| `bytesSent`                           | Number   | sum of bytes sent by the server                                                                |
| `messagesGarbage`                     | Number   | count of messages without a listener                                                           |
| `messagesReceived`                    | Number   | count of messages ever received                                                                |
| `messagesSent`                        | Number   | count of messages ever sent                                                                    |
| `messagesSentCacheHit`                | Number   | count of messages ever sent that were cached                                                   |
| `serverErrors`                        | Number   | count of server errors                                                                         |
| `socketErrors`                        | Number   | count of socket errors                                                                         |
| `events`                              | Object   | ref to events, ex: server.events.typing() to dispatch typing to anyone listening to it         |
| `on(Class)`                           | Function | attaches all methods of a `Class` as listeners                                                 |
| `emit(key, [value])`                  | Function | emits to all connected sockets                                                                 |
| `once(key, [value])`                  | Function | emits to the sockets and replace if exists a pending message with the same `key`               |
| `broadcast(sender, key, [value])`     | Function | emits to all connected sockets except sender                                                   |
| `broadcastOnce(sender, key, [value])` | Function | emits to the sockets except sender and replace if exists a pending message with the same `key` |
| `sockets`                             | Set      | a Set() with all the current connected sockets                                                 |

### `Socket` Object

The `socket` object is given to you by a listener

#### List of `Socket` Object Properties

| signature                   | kind     | description                                                                   |
| --------------------------- | -------- | ----------------------------------------------------------------------------- |
| `server`                    | Object   | reference to the server                                                       |
| `ip`                        | String   | ip of the socket                                                              |
| `userAgent`                 | String   | user agent of the socket                                                      |
| `params`                    | Object   | the params sent via the client constructor                                    |
| `since`                     | Number   | timestamp of first seen                                                       |
| `seen`                      | Number   | timestamp of last received message                                            |
| `ping`                      | Number   | delay with the socket in milliseconds (full round trip)                       |
| `timedout`                  | Boolean  | whether we lost connection with this socket                                   |
| `bytesSent`                 | Number   | sum of bytes sent to this socket                                              |
| `bytesReceived`             | Number   | sum of bytes received from this socket                                        |
| `messagesSent`              | Number   | count of messages sent to this socket                                         |
| `messagesReceived`          | Number   | count of messages received from this socket                                   |
| `rooms`                     | Set      | a set with the rooms where this socket is in                                  |
| `emit(key, [value])`        | Function | emits to client                                                               |
| `once(key, [value])`        | Function | replace if exists a pending message with the same `key` from emit queue       |
| `disconnect([noReconnect])` | Function | disconnects the socket from the server, pass `true` to prevent re-connections |

### Server Listeners

Listen to an event by creating a class with any name, and give to
methods the name of the things you want to listen to. Then add the
class to the listeners as `Server.on(MyClass)` and you are done.

On user defined listeners, the listener receives three things as sent
by the client: `socket`, `data` and a `callback`; Example:
`class FancyChat { typing(socket, data, callback?) { console.log(socket, data) }}`.

#### List of Predefined `Server` Events

There's a bunch of handy predefined events dispatched

| signature                           | description                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `listen()`                          | when the server is about to listen                                                        |
| `connect(socket, request)`          | when a socket connects                                                                    |
| `disconnect(socket, code, message)` | when a socket gets disconnected                                                           |
| `ping(socket)`                      | when we got an update of the ping for a socket                                            |
| `timeout(socket, delay)`            | when we are about to disconnect a timedout socket, gives the delay in milliseconds        |
| `garbage(socket, data)`             | if the client sends a message that the server has no listener this will be dispatched     |
| `incoming(socket, messages)`        | for debugging: ref to array of incoming messages received before dispatching to listeners |
| `outgoing(socket, messages)`        | for debugging: ref to array of outgoing messages before sending to socket                 |

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

You may also do like this if you don't need any option

```js
const socket = new Client('ws://localhost:3001')
```

### `Client` API

The client API is similar to regular event handling

| signature                      | kind     | description                                                        |
| ------------------------------ | -------- | ------------------------------------------------------------------ |
| `connected`                    | Boolean  | `true` when the socket is connected else `false`                   |
| `connect()`                    | Function | connects to the server, it auto-connects on disconnection          |
| `disconnect([noReconnect])`    | Function | disconnects from the server, pass `true` to prevent re-connections |
| `on(key, callback)`            | Function | listens for an event, returns an `off` function to stop listening  |
| `emit(key, [value, callback])` | Function | emits data to the server                                           |

#### List of Predefined `Client` Events

As in `socket.on('connect', () => console.log('connect happened!'))`

| signature    | description                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `connect`    | **this happens only once** when we connect to the server, any future connection is a `reconnect`         |
| `reconnect`  | if we were connected at least once, then any re-connection will dispatch this event instead of `connect` |
| `disconnect` | when we disconnect from the server                                                                       |

## Rooms

1. Create a room class that extends `Room`
2. Create a room list that will allow joining sockets
3. Join a socket in a room, a socket may join multiple rooms. Rooms
   are created when the `id` of the room doesn't exists, and deleted
   when there are no sockets in the room and the room doesn't have the
   flag `persistent`

```js
import { Room, Rooms } from 'angelia.io/server'

class GameRoom extends Room {
	persistent = true

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

const games = new Rooms(GameRoom)

class Connection {
	connect(socket) {
		game.join(socket, 'room id here')
		socket.room.id === 'room id here'
		game.leave(socket, 'room id here')

		game.join(socket, 'a different room')
		socket.room.id === 'a different room'
		game.leave(socket, 'a different room')
	}
}

Server.on(Connection)
Server.listen()
```

### `Room` Class

| signature                             | kind    | description                                      |
| ------------------------------------- | ------- | ------------------------------------------------ |
| `onCreate(socket)`                    | method  | dispatched when the room is created              |
| `onDelete(socket)`                    | method  | dispatched when the room is deleted              |
| `onJoin(socket)`                      | method  | dispatched when a socket joins the room          |
| `onLeave(socket)`                     | method  | dispatched when a socket leaves the room         |
| `persistent`                          | boolean | to not delete rooms when there are no sockets in |
| `connections`                         | number  | number of sockets in the room                    |
| `sockets`                             | Set     | sockets in the room                              |
| `emit(key, [value])`                  | method  | emits to all sockets in the room                 |
| `once(key, [value])`                  | method  | emits once all sockets in the room               |
| `broadcast(socket, key, [value])`     | method  | emits to other sockets in the room               |
| `broadcastOnce(socket, key, [value])` | method  | emits once to other sockets in the room          |
| `id`                                  | any     | the room id                                      |

## Authors

- Tito Bouzout https://github.com/titoBouzout
- Anthony K. https://github.com/boredofnames

## URLs

- https://github.com/titoBouzout/angelia.io
- https://www.npmjs.com/package/angelia.io
