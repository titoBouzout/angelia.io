# angelia.io

WebSockets Server and Client API for node.js and the browser, with rooms support.

The goal of this project is to provide a developer friendly API that just works™.

## Installation

Install on node.js/browser `npm install angelia.io`

If you fancy for Client side a regular JavaScript file, then use https://github.com/titoBouzout/angelia.io/blob/master/client/index.js and include it as a regular script tag. For es5 remove `export default` from it.

## Simple Example

### Server (Node.js)

```JavaScript
// server.js (node.js)
import Server from 'angelia.io/server';

class Connection {
	async listen() {
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
Server.on(Connection);

class FancyChat {
	async chatMessage(socket, message, callback) {
		console.log('socket sent', message)
		socket.emit('chatMessage', 'Hi client nice to meet you')
		callback('yes, got it')
	}
}
Server.on(FancyChat);

const server = new Server({
	port: 3001,
});
```

### Client (Browser)

```JavaScript
// index.js (browser)
import Client from 'angelia.io/client';

const socket = new Client({
	url: 'ws://localhost:3001',
	debug: true,
});

socket.on('chatMessage', (message) => {
	console.log('Server sent', message)
})

socket.emit('chatMessage', 'Hi there server, Im client', (data) =>{
	console.log('you got it?', data)
})
```

## Server (Node.js)

### Options

Configurable options used by the constructor

```javascript
// server.js (node.js)
import Server from 'angelia.io/server';

const server = new Server({
	hostname: 'localhost',
	port: 3001,
	maxMessageSize: 5,
	cert: '/path/to/cert/fullchain.pem',
	key: '/path/to/key/privkey.pem',
});
```

| name             | kind   | default   | description                                         |
| ---------------- | ------ | --------- | --------------------------------------------------- |
| `hostname`       | String | null      | the hostname if any                                 |
| `port`           | Number | 3001      | the port to use for this server                     |
| `maxMessageSize` | Number | 5         | max size in mb of a message received                |
| `cert`           | String | undefined | path to the cert file for using https fullchain.pem |
| `key`            | String | undefined | path to the key file for using https privkey.pem    |

### Server Object

The `server` object can be accessed from everywhere

```javascript
// server.js (node.js)
import Server from 'angelia.io/server';

class _ {
	connect(socket, request) {
		console.log(this.server, 'also', socket.server);
	}
}
Server.on(_);

const server = new Server({
	port: 3001,
});
```

#### Server Properties

| signature            | kind     | description                                                                            |
| -------------------- | -------- | -------------------------------------------------------------------------------------- |
| `since`              | Number   | timestamp of initialization                                                            |
| `port`               | Number   | port used by this server                                                               |
| `maxMessageSize`     | Number   | maximum message size in mb                                                             |
| `timeout`            | Number   | after how long the socket is considered gone, in ms                                    |
| `connections`        | Number   | count of sockets connected                                                             |
| `served`             | Number   | count of sockets ever connected                                                        |
| `bytesSent`          | Number   | sum of bytes sent by the server                                                        |
| `bytesReceived`      | Number   | sum of bytes the server has ever received                                              |
| `messagesSent`       | Number   | count of messages ever sent                                                            |
| `messagesReceived`   | Number   | count of messages ever received                                                        |
| `events`             | Object   | ref to events, ex: server.events.typing() to dispatch typing to anyone listening to it |
| `listeners`          | Array    | for debbuging: array of listeners as strings                                           |
| `on(Class)`          | Function | attaches all methods of a `Class` as listeners                                         |
| `on(Function)`       | Function | attaches a named `Function` as a listener                                              |
| `on(Object)`         | Function | attaches all properties of an object that are of the type `Function` as listeners      |
| `on(key, Function)`  | Function | attaches a `Function` as a listener for `key`                                          |
| `emit(key, [value])` | Function | emits to all connected sockets                                                         |
| `once(key, [value])` | Function | emits to the sockets and replace if exists a pending message with the same `key`       |
| `sockets`            | Set      | a Set() with all the current connected sockets                                         |

### Socket Object

The `socket` object is given to you by a listener

```javascript
// server.js (node.js)
import Server from 'angelia.io/server';

class _ {
	connect(socket, request) {
		console.log(socket, data, callback);
	}
}
Server.on(_);

new Server({
	port: 3001,
});
```

#### Socket Properties

| signature                 | kind     | description                                                                      |
| ------------------------- | -------- | -------------------------------------------------------------------------------- |
| `server`                  | Object   | reference to the server                                                          |
| `ip`                      | String   | ip of the socket                                                                 |
| `userAgent`               | String   | user agent of the socket                                                         |
| `params`                  | Object   | the params sent via the client constructor                                       |
| `since`                   | Number   | timestamp of first seen                                                          |
| `seen`                    | Number   | timestamp of last received message                                               |
| `ping`                    | Number   | delay with the socket in milliseconds (full round trip)                          |
| `timedout`                | Boolean  | whether we lost connection with this socket                                      |
| `bytesSent`               | Number   | sum of bytes sent to this socket                                                 |
| `bytesReceived`           | Number   | sum of bytes received from this socket                                           |
| `messagesSent`            | Number   | count of messages sent to this socket                                            |
| `messagesReceived`        | Number   | count of messages received from this socket                                      |
| `emit(key, [value])`      | Function | emits to this socket                                                             |
| `once(key, [value])`      | Function | emits to this socket and replace if exists a pending message with the same `key` |
| `disconnect([reconnect])` | Function | disconnects the socket from the server, pass true to prevent re-connections      |

### Listeners

To listen for a client message/event you may do the familiar way `Server.on('connect', (socket) => {console.log('socket connected!', socket)})`

However, to ease organization and development you may listen to an event by creating a class with any name, and give to methods the name of the things you want to listen to. You then add your class to the listeners as `Server.on(MyClass);` and you are done.

On user defined listeners, the listener receives three things as sent by the client: `socket`, `data` and a `callback`; Example `class FancyChat { async typing(socket, data, callback) {console.log(socket, data);callback('got it')}}`.

If you are building a chat you may write something like this

```JavaScript
// server.js (node.js)
import Server from 'angelia.io/server';

class FancyChat {
	async typing(socket, data, callback) {
		console.log('Im', data ? ' typing' : ' not typing')
	}
	async theMessage(socket, data, callback) {
		console.log('the message is', data, socket)
		socket.emit('gotIt', 'thanks')
		callback('yes Im sure')
	}
}

Server.on(FancyChat);

class Connection {
	async connect(socket, request) {
		console.log('socket connected', socket)
	}
	async disconnect(socket, code, message) {
		console.log('socket disconnected', code, message, socket);
	}
}
Server.on(Connection);

const server = new Server({
	port: 3001,
});

// index.js (browser)
import Client from 'angelia.io/client';

const socket = new Client({
	url: 'ws://localhost:3001',
});

socket.emit('typing', true)

setTimeout(() => {
	socket.emit('typing', false)
	socket.emit('theMessage', 'hi there!', (data) =>{
		console.log('you sure?', data)
	})
}, 10000)

socket.on('gotIt', (message) => {
	console.log('Server got it yey', message)
})
```

#### Syntax For Listeners

Listeners have the following alternative syntax if you feel like

```javascript
// server.js (node.js)
import Server from 'angelia.io/server';

// listen via the names of methods of a class
Server.on(
	class Connection {
		async connect(socket, request) {
			console.log('connect in Class');
		}
		async something(socket, data, callback) {
			console.log('something is dispatched');
		}
	},
);

// listen via the name of a function
Server.on(function connect(socket, request) {
	console.log('connect in Function');
});

// listen via the properties of an object to all of the functions of it
Server.on({
	connect: function(socket, request) {
		console.log('connect in Object');
		this.works();
	},
	works: function() {
		console.log('this works yep');
	},
});

// named listener with callback
Server.on('connect', (socket, request) => {
	console.log('connect in arrow function');
});

// named listener with a random named callback (the callback name doesnt matter)
Server.on('connect', function fancyConnect(socket, request) {
	onsole.log('connect in named function');
});

const server = new Server({
	port: 3001,
});
```

### Predefined Events

There's a bunch of handy predefined events dispatched whenever you add listeners for them.

```JavaScript
// server.js (node.js)
import Server from 'angelia.io/server';

class _ {
	async listen() {
		console.log('Server started listening on port ' + this.server.port);
	}
	async connect(socket, request) {
		console.log('a socket connected!', socket)
	}
	...
}

Server.on(_);

const server = new Server({
	port: 3001,
});
```

#### List of Predefined Events

| signature                           | description                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `listen()`                          | when the server is about to listen                                                        |
| `connect(socket, request)`          | when a socket connects                                                                    |
| `disconnect(socket, code, message)` | when a socket gets disconnected                                                           |
| `ping(socket)`                      | when we got an update of the ping for a socket                                            |
| `timeout(socket, delay)`            | when we are about to disconnect the socket, gives the delay in milliseconds               |
| `garbage(socket, data)`             | if the client sends a message that the server has no listener this will be dispatched     |
| `incoming(socket, messages)`        | for debugging: ref to array of incoming messages received before dispatching to listeners |
| `outgoing(socket, messages)`        | for debugging: ref to array of outgoing messages before sending to socket                 |

`this` object on listeners has some predefined properties

| property  | description                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| `server`  | reference to server object                                                                                           |
| `events`  | reference to event dispatcher, ex: `this.events.typing()` will dispatch the `typing` event to anyone listening to it |
| `classes` | EXPERIMENTAL reference to all functions that have been attached as listeners , ex: `this.classes.MyFancyChat.typing` |

## Client API (Browser)

### Options

Configurable options used by the constructor

```javascript
const socket = new Client({
	url: 'ws://localhost:3001',
	debug: true,
	params: { fast: 'data', test: 'a space' },
});
```

| property | kind    | default                                     | description                                                              |
| -------- | ------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| `url`    | string  | 'ws(s)://\${window.location.hostname}:3001' | url of the socket server, example 'ws://localhost:3001'                  |
| `debug`  | boolean | false                                       | to console.log some messages                                             |
| `params` | Object  | {}                                          | to send data while connecting, accesible via `socket.params` server side |

You may also do like this if you don't need any option

```javascript
const socket = new Client('ws://localhost:3001');
```

### API

The client API is similar to regular event handling

| signature                      | kind     | description                                                        |
| ------------------------------ | -------- | ------------------------------------------------------------------ |
| `connect()`                    | Function | connects to the server, it auto-connects on disconnection          |
| `connected`                    | Boolean  | `true` when the socket is connected else `false`                   |
| `disconnect([reconnect])`      | Function | disconnects from the server, pass `true` to prevent re-connections |
| `on(key, callback)`            | Function | listens for an event, returns an `off` function to stop listening  |
| `off(key, callback)`           | Function | turns off listening for an event                                   |
| `emit(key, [value, callback])` | Function | emits data to the server                                           |

## Authors

- Tito Bouzout https://github.com/titoBouzout
- Anthony K. https://github.com/boredofnames

## URL

https://github.com/titoBouzout/angelia.io
