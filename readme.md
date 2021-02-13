# angelia.io

Simple WebSockets Server and Client for node.js. The goal of this project is to provide a simple API that just works™.

## Installation

Install on node.js/browser `npm install angelia.io`

If you fancy for Client side a regular JavaScript file, then use https://github.com/titoBouzout/angelia.io/blob/master/client.js and include it as a regular script tag. For es5 remove `export default`

## Simple Example

### Socket Server (Node.js)

```JavaScript
// server.js
import WebSocketServer from 'angelia.io/server';

class Connection {
	async serverStarted() {
		console.log('-'.repeat(60));
		console.log('Server started listening on port ' + this.server.port);
		console.log(this.server);
	}
	async connect(socket, request) {
		console.log('socket connected', socket)
	}
	async disconnect(socket, code, message) {
		console.log('socket disconnected', code, message, socket);
	}
}
WebSocketServer.Listeners.add(Connection);

class FancyChat {
	async chatMessage(socket, message) {
		console.log('socket sent', message)
		socket.emit('chatMessage', 'Hi client nice to meet you')
	}
}
WebSocketServer.Listeners.add(FancyChat);

new WebSocketServer({
	port: 3001
});
```

### Socket Client (Browser)

```JavaScript
// index.js
import WebSocketClient from 'angelia.io/client';

const socket = new WebSocketClient({
	url: 'ws://localhost:3001',
	debug: true,
});

socket.on('chatMessage', (message) => {
	console.log('Server sent', message)
})

socket.emit('chatMessage', 'Hi there server, Im client')
```

## Server

### Listeners

To listen for a message you just create a class with any name, and give to a method the name of the thing you want to listen to. You then add your class to the listeners as `WebSocketServer.Listeners.add(MyClass);` and you are done.

If you are building a chat you may write something like this

```JavaScript
import WebSocketServer from 'angelia.io/server';

class FancyChat {
	async typing(socket, data) {
		console.log('Im', data ? ' typing' : ' not typing')
	}
	async theMessage(socket, data) {
		console.log('the message is', data, socket)
		socket.emit('gotIt', 'thanks')
	}
}

WebSocketServer.Listeners.add(FancyChat);

class Connection {
	async connect(socket, request) {
		console.log('socket connected', socket)
	}
	async disconnect(socket, code, message) {
		console.log('socket disconnected', code, message, socket);
	}
}
WebSocketServer.Listeners.add(Connection);

new WebSocketServer({
	port: 3001
});
```

Then, on client you may write something like

```JavaScript
import WebSocketClient from 'angelia.io/client';

const socket = new WebSocketClient({
	url: 'ws://localhost:3001',
	debug: true,
});

socket.emit('typing', true)

setTimeout(() => {
	socket.emit('typing', false)
	socket.emit('theMessage', 'hi there!')
}, 10000)

socket.on('gotIt', (message) => {
	console.log('Server got it yey', message)
})


```

### Server Options

Configurable options used by the constructor

```javascript
const server = new WebSocketServer({
	port: 3001,
	maxMessageSize: 5,
	cert: '/path/to/cert',
	key: '/path/to/key',
});
```

| name             | kind   | default   | description                           |
| ---------------- | ------ | --------- | ------------------------------------- |
| `port`           | number | 3001      | the port to use for this server       |
| `maxMessageSize` | number | 5         | max size in mb of a message received  |
| `cert`           | string | undefined | path to the cert file for using https |
| `key`            | string | undefined | path to the key file for using https  |

### Server Object

The server Object can be accessed from everywhere

```javascript
class className {
	methodName(socket) {
		console.log(this.server, 'also', socket.server);
	}
}
WebSocketServer.Listeners.add(className);

const server = new WebSocketServer();
```

Has the following properties

| signature          | kind     | description                                                                     |
| ------------------ | -------- | ------------------------------------------------------------------------------- |
| `since`            | number   | timestamp of initialization                                                     |
| `port`             | number   | port used by this server                                                        |
| `maxMessageSize`   | number   | maximum message size in mb                                                      |
| `timeout`          | number   | after how long the socket is considered gone, in ms                             |
| `socketsServed`    | number   | total count of sockets ever connected                                           |
| `messagesReceived` | number   | total count of messages ever received                                           |
| `messagesSent`     | number   | total count of messages ever sent                                               |
| `bytesReceived`    | number   | sum of bytes the server has ever received                                       |
| `Listeners`        | Object   | console.log(server.Listeners) will pretty list them as an array                 |
| `emit(key, value)` | Function | function to emit to all connected sockets                                       |
| `once(key, value)` | Function | emits to the socket and replace if exists a pending message with the same `key` |
| `sockets`          | Set      | a Set() with all the current connected sockets                                  |

### Socket Object

The socket Object is given to you by a listener

```javascript
class className {
	methodName(socket, data) {
		console.log(socket, data);
	}
}
WebSocketServer.Listeners.add(className);
```

Has the following properties

| signature                 | kind     | description                                                                      |
| ------------------------- | -------- | -------------------------------------------------------------------------------- |
| `server`                  | Object   | reference to the server                                                          |
| `ip`                      | string   | ip of the socket                                                                 |
| `userAgent`               | string   | user agent of the socket                                                         |
| `since`                   | number   | timestamp of first seen                                                          |
| `seen`                    | number   | timestamp of last received message                                               |
| `ping`                    | number   | delay with the socket in milliseconds (full round trip)                          |
| `timedout`                | boolean  | whether we lost connection with this socket                                      |
| `messagesReceived`        | number   | count of messages received from this socket                                      |
| `messagesSent`            | number   | count of messages sent to this socket                                            |
| `bytesReceived`           | number   | sum of bytes received from this socket                                           |
| `emit(key, value)`        | Function | emits to this socket                                                             |
| `once(key, value)`        | Function | emits to this socket and replace if exists a pending message with the same `key` |
| `disconnect([reconnect])` | Function | disconnects the socket from the server, pass true to prevent re-connections      |

### Predefined Listeners

There's a bunch of handy predefined listeners for some socket events that you may add to any class

```JavaScript
import WebSocketServer from 'angelia.io/server';

class _ {
	async serverStarted() {
		console.log('Server started listening on port ' + this.server.port);
	}
	async connect(socket) {
		console.log('a socket connected!', socket)
	}
}

WebSocketServer.Listeners.add(_);

new WebSocketServer();
```

All of the predefined listeners

| signature                           | description                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `serverStarted()`                   | when the server is about to listen                                                    |
| `connect(socket, request)`          | when a socket connects                                                                |
| `disconnect(socket, code, message)` | when a socket gets disconnected                                                       |
| `ping(socket)`                      | when we got an update of the ping for a socket                                        |
| `timeout(socket, delay)`            | when we are about to disconnect the socket, gives the delay in milliseconds           |
| `garbage(socket, data)`             | if the client sends a message that the server has no listener this will be dispatched |
| `messages(socket, messages)`        | for debugging: array of messages received before dispatching to listeners             |

## Client (Browser)

### Client (Browser) Options

Configurable options used by the constructor

```javascript
const socket = new WebSocketClient({
	url: '',
	debug: true,
});
```

| name    | kind    | default   | description                                             |
| ------- | ------- | --------- | ------------------------------------------------------- |
| `url`   | string  | undefined | url of the socket server, example 'ws://localhost:3001' |
| `debug` | boolean | false     | to console.log some messages                            |

### Client (Browser) API

The client API is similar to regular event handling

| signature                 | kind     | description                                                          |
| ------------------------- | -------- | -------------------------------------------------------------------- |
| `connect()`               | Function | to connect to the server, it auto-connects on disconnection          |
| `connected`               | boolean  | `true` when the socket is connected else `false`                     |
| `disconnect([reconnect])` | Function | to disconnect from the server, pass `true` to prevent re-connections |
| `on(key, callback)`       | Function | to listen for an event, returns a function to stop listening         |
| `off(key, [callback])`    | Function | to turn off listening for an event                                   |
| `emit(key, value)`        | Function | to emit data to the server                                           |

## Authors

- Tito Bouzout https://github.com/titoBouzout
- Anthony K. https://github.com/boredofnames

## URL

https://github.com/titoBouzout/angelia.io
