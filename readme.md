# angelia.io

Simple WebSockets Server and Client for node.js. The goal of this project is to provide something that just works with a simple API.

## Installation

You may run on a node.js Server and also on Client `npm install angelia.io`

If you fancy for Client side a regular JavaScript file, then use https://github.com/titoBouzout/angelia.io/blob/master/client.js and include it as a regular script tag. For es5 remove `export default`

## Usage

### Node.js Socket Server

```JavaScript
	import WebSocketServer from 'angelia.io/server';

	// all the predefined listeners you may want to use
	class Listeners {

		async connect(socket, request) {
	    	console.log('socket connected', socket)
	    	console.log('server info', this.server);
	    }
		async ping(socket) {
	    	console.log('socket sent a ping request', socket)
	    	console.log('ping is ', socket.ping);
	    }
		async message(socket, data) {
	    	console.log('socket sent a message', socket, data)
	    }
	    async garbage(socket, data) {
	    	console.log('socket hacked into the connection and sent weird stuff', socket, data);
	    }
	    async timeout(socket, delay) {
	    	console.log('socket timedout', socket)
	    	console.log('client has not been seen for at least', delay, 'ms');
	    }
	    async disconnect(socket, code, message) {
	    	console.log('socket disconnected', socket, code, message);
	    }
	}

	WebSocketServer.Listeners.add(Listeners);

	new WebSocketServer({
		port: process.env.PORT , // defaults to 3001
		// maxMessageSize: 5, // in mb defaults to 5
		// cert: '/path/to/cert', // for https defaults to empty
		// key: '/path/to/key', // for https defaultss to empty
	});
```

## Authors

- Tito Bouzout https://github.com/titoBouzout
- Anthony K. https://github.com/boredofnames

## URL

https://github.com/titoBouzout/angelia.io
