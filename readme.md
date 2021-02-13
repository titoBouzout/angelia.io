# angelia.io

Simple WebSockets Server and Client for node.js. The goal of this project is to provide a simple API.

## Installation

You may install on a node.js Server and on the Client by running `npm install angelia.io`

If you fancy for Client side a regular JavaScript file, then use https://github.com/titoBouzout/angelia.io/blob/master/client.js and include it as a regular script tag. For es5 remove `export default`

## Simple Example

### Socket Server (Node.js)

```JavaScript
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

## Server Listeners

The listeners for client messages are defined by the names of the methods of classes. You can add as many classes as you want to the collection of listeners. The name of the classes doesn't matter, only the method names.

If you are building a chat you may write something like this:

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

Then, on client you may write something like:

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

## Server Options

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

## Server Object

The server Object can be accessed from everywhere

```javascript
const server = new WebSocketServer();
class className {
	methodName(socket) {
		console.log(this.server, 'also', socket.server);
	}
}
WebSocketServer.Listeners.add(className);
```

Has the following properties:

| name               | kind     | description                                                         |
| ------------------ | -------- | ------------------------------------------------------------------- |
| `since`            | number   | timestamp of initialization                                         |
| `port`             | number   | port used by this server                                            |
| `maxMessageSize`   | number   | max size in mb of a message received                                |
| `timeout`          | number   | after how long the socket is considered gone, in ms                 |
| `socketsServed`    | number   | total count of sockets ever connected                               |
| `bytesReceived`    | number   | sum of bytes the server has ever received                           |
| `messagesSent`     | number   | total count of messages ever sent                                   |
| `messagesReceived` | number   | total count of messages ever received                               |
| `Listeners`        | Object   | when doing console.log(server.Listeners) will list them as an array |
| `emit(key, value)` | Function | function to emit to all connected sockets                           |
| `sockets`          | Set      | a Set() with all the current connected sockets                      |

## Socket Object

The socket Object is given to you by a listener

```javascript
class className {
	methodName(socket, data) {
		console.log(socket, data);
	}
}
WebSocketServer.Listeners.add(className);
```

Has the following properties:

| name               | kind     | description                                                                    |
| ------------------ | -------- | ------------------------------------------------------------------------------ |
| `server`           | Object   | reference to the server                                                        |
| `ip`               | string   | if of the socket                                                               |
| `userAgent`        | string   | user agent of the socket                                                       |
| `since`            | number   | timestamp of connection                                                        |
| `seen`             | number   | timestamp of last received message                                             |
| `ping`             | number   | delay with the socket in milliseconds (full round trip)                        |
| `timedout`         | boolean  | delay with the socket in milliseconds (full round trip)                        |
| `messagesReceived` | number   | count of messages received from this socket                                    |
| `messagesSent`     | number   | count of messages sent to this socket                                          |
| `bytesReceived`    | number   | sum of bytes received from this socket                                         |
| `emit(key, value)` | Function | emits to this socket                                                           |
| `once(key, value)` | Function | emits to this socket and replace if exists and pending message with same `key` |
| `disconnect`       | Function | disconnects the socket from the server                                         |

## Predefined Listeners

There's a bunch of handy predefined listeners for some user events that you may add to any class. Example:

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

new WebSocketServer({
	port: 3001
});
```

All of the predefined listeners:

| signature                           | description                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `serverStarted()`                   | when the server is about to listen                                                    |
| `connect(socket, request)`          | when a socket connects                                                                |
| `disconnect(socket, code, message)` | when a socket gets disconnected                                                       |
| `ping(socket)`                      | when we got an update of the ping for a socket                                        |
| `timeout(socket, delay)`            | when we are about to disconnect the socket, gives the delay in milliseconds           |
| `garbage(socket, data)`             | if the client sends a message that the server has no listener this will be dispatched |
| `messages(socket, messages)`        | for debugging: array of messages received before dispatching to listeners             |

## Authors

- Tito Bouzout https://github.com/titoBouzout
- Anthony K. https://github.com/boredofnames

## URL

https://github.com/titoBouzout/angelia.io
