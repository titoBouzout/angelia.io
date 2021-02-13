const ws = require('ws');

const inspect = Symbol.for('nodejs.util.inspect.custom');

class WebSocketListeners {
	static add(aOriginClass) {
		let aClass = new aOriginClass();
		for (let member of Object.getOwnPropertyNames(aClass.__proto__)) {
			if (member !== 'constructor') {
				WebSocketListeners.prototype[member] = aClass[member];
				WebSocketListeners.prototype[member].WebSocketListenersClassName = aOriginClass.name;
			}
		}
		for (let member in aClass) {
			if (member !== 'constructor') {
				WebSocketListeners.prototype[member] = aClass[member];
				WebSocketListeners.prototype[member].WebSocketListenersClassName = aOriginClass.name;
			}
		}
	}
	[inspect]() {
		let listeners = [];
		for (let member of Object.getOwnPropertyNames(this)) {
			if (this[member].WebSocketListenersClassName)
				listeners.push(this[member].WebSocketListenersClassName + '.' + member);
		}
		for (let member in this) {
			if (this[member].WebSocketListenersClassName)
				listeners.push(this[member].WebSocketListenersClassName + '.' + member);
		}
		return listeners;
	}
}

class WebSocketServer {
	constructor(options) {
		Object.assign(this, {
			port: +options.port > 0 ? +options.port : 3001,
			maxMessageSize: +options.maxMessageSize > 0 ? +options.maxMessageSize : 5,

			since: Date.now(),
			now: Date.now(),

			socketsServed: 0,
			bytesReceived: 0,
			messagesSent: 0,
			messagesReceived: 0,
			messagesFail: 0,

			timeout: 30 * 1000,
			pong: this.pong.bind(this),
			ping: this.ping.bind(this),
			updateNow: this.updateNow.bind(this),
			onconnect: this.onconnect.bind(this),
			onerror: this.onerror.bind(this),
			inspect: this.inspect.bind(this),

			Listeners: new WebSocketListeners(),

			sockets: new Set(),
		});

		this[inspect] = this.toJSON = this.inspect;

		Object.assign(this.Listeners, {
			server: this,
			pong: this.pong,
		});
		delete this.Listeners.add;
		// ping
		setInterval(this.ping, this.timeout / 2);
		setInterval(this.updateNow, 500);

		// fire the server
		let server;
		if (options.cert && options.key) {
			let fs = require('fs');
			server = require('https').createServer({
				cert: fs.readFileSync(options.cert),
				key: fs.readFileSync(options.key),
			});
		} else {
			server = require('http').createServer();
		}

		let io = new ws.Server({
			server: server,
			perMessageDeflate: false,
			maxPayload: this.maxMessageSize * 1024 * 1024,
			clientTracking: false,
			backlog: 1024, // queue of pending connections
		});

		io.on('connection', this.onconnect);
		io.on('error', this.onerror);

		server.listen(this.port);
		this.Listeners.serverStarted && this.Listeners.serverStarted();
	}

	// emits to everyone connected to the server
	emit(k, v) {
		let d = {
			k,
			v,
		};

		for (let socket of this.sockets) {
			socket.emit(d);
		}
	}
	once(k, v) {
		let d = {
			k,
			v,
		};

		for (let socket of this.sockets) {
			socket.once(d);
		}
	}

	// PRIVATE API

	onconnect(socket, request) {
		this.updateNow();

		socket = new WebSocket(socket, this);

		// set the ip and userAgent
		Object.assign(socket, {
			ip:
				this.ip(request.connection.remoteAddress) ||
				this.ip((request.headers['x-forwarded-for'] || '').split(/\s*,\s*/)[0]) ||
				request.connection.remoteAddress ||
				(request.headers['x-forwarded-for'] || '').split(/\s*,\s*/)[0],
			userAgent: request.headers['user-agent'] || '',
		});

		this.socketsServed++;

		socket.listen();

		this.sockets.add(socket);

		// dispatch connect
		this.Listeners.connect && this.Listeners.connect(socket, request);
	}
	onerror(err) {
		console.error('WebSocketServer.onerror', err);
	}

	// ping
	updateNow() {
		this.now = Date.now();
	}
	ping() {
		this.updateNow();
		for (let socket of this.sockets) {
			let delay = this.now - socket.seen;
			if (delay > this.timeout) {
				// timedout
				socket.timedout = true;
				this.Listeners.timeout && this.Listeners.timeout(socket, delay);
				socket.io.terminate();
			} else {
				// ping
				this.pingSocket(socket);
			}
		}
	}
	pingSocket(socket) {
		socket.contacted = this.now;
		if (socket.io.readyState === 1) {
			socket.io.send('');
		}
	}
	pong(socket) {
		this.updateNow();
		socket.seen = this.now;
		socket.ping = this.now - socket.contacted;
		this.Listeners.ping && this.Listeners.ping(socket);
	}
	// returns false if the ip is a private ip like 127.0.0.1
	ip(i) {
		switch (i) {
			case undefined:
			case null:
			case false:
			case 0:
			case '127.0.0.1':
			case '':
			case '::':
			case '::1':
			case '::ffff:':
			case 'fe80::1': {
				return false;
			}
			default: {
				if (
					/^(::f{4}:)?10\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(i) ||
					/^(::f{4}:)?192\.168\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(i) ||
					/^(::f{4}:)?172\.(1[6-9]|2\d|30|31)\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(i) ||
					/^(::f{4}:)?127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(i) ||
					/^(::f{4}:)?169\.254\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(i) ||
					/^f[cd][0-9a-f]{2}:/i.test(i) ||
					/^fe80:/i.test(i)
				)
					return false;
				return i;
			}
		}
	}
	// console.log and toJSON
	inspect() {
		return {
			// started
			since: this.since,
			// settings
			port: this.port,
			maxMessageSize: this.maxMessageSize,
			timeout: this.timeout,
			// stats
			socketsServed: this.socketsServed,
			bytesReceived: this.bytesReceived,
			messagesSent: this.messagesSent,
			messagesReceived: this.messagesReceived,
			messagesFail: this.messagesFail,
			// listeners
			Listeners: this.Listeners,
			// data
			emit: this.emit,
			sockets: this.sockets,
		};
	}
}

WebSocketServer.Listeners = WebSocketListeners;

class WebSocket {
	constructor(socket, server) {
		Object.assign(this, {
			server: server,

			Listeners: server.Listeners,

			messages: [],
			messagesSent: 0,
			messagesReceived: 0,
			bytesReceived: 0,

			since: server.now,
			seen: server.now,
			contacted: server.now,
			ping: 0,
			timedout: false,

			onclose: this.onclose.bind(this),
			onerror: this.onerror.bind(this),
			onmessage: this.onmessage.bind(this),

			nextTick: this.nextTick.bind(this),
			inspect: this.inspect.bind(this),

			io: socket,
		});
		this.toJSON = this.inspect;

		Object.assign(socket, {
			[inspect]: this.inspect,
			toJSON: this.inspect,
		});
	}

	emit(k, v) {
		if (!this.messages.length) {
			process.nextTick(this.nextTick);
		}

		this.messages.push(
			typeof k !== 'string'
				? k
				: {
						k,
						v,
				  },
		);
	}
	once(k, v) {
		if (!this.messages.length) {
			this.emit(k, v);
		} else {
			if (typeof k !== 'string') {
				for (let m of this.messages) {
					if (m.k === k.k) {
						m.v = k.v;
						return;
					}
				}
			} else {
				for (let m of this.messages) {
					if (m.k === k) {
						m.v = v;
						return;
					}
				}
			}
			this.emit(k, v);
		}
	}

	disconnect(noReconnect) {
		if (noReconnect) {
			this.emit({ k: 'disconnect', v: true });
		} else {
			this.io.close();
		}
	}
	// private API
	listen() {
		this.io.on('close', this.onclose);
		this.io.on('error', this.onerror);
		this.io.on('message', this.onmessage);
	}
	onclose(code, message) {
		this.server.sockets.delete(this);

		this.Listeners.disconnect && this.Listeners.disconnect(this, code, message);
	}
	onerror(err) {
		console.error('WebSocket.onerror', err, 'readyState is', this.io.readyState);
	}
	onmessage(e) {
		if (e === '') {
			this.Listeners.pong(this);
		} else {
			this.seen = this.server.now;

			let length = e.length;
			this.bytesReceived += length;
			this.server.bytesReceived += length;

			let messages = JSON.parse(e);
			if (Array.isArray(messages)) {
				let length = messages.length;
				this.messagesReceived += length;
				this.server.messagesReceived += length;

				this.Listeners.messages && this.Listeners.messages(this, messages);

				for (let m of messages) {
					if (this.Listeners[m.k]) {
						this.Listeners[m.k](this, m.v);
					} else {
						this.Listeners.garbage && this.Listeners.garbage(this, m);
					}
				}
			} else {
				this.Listeners.garbage && this.Listeners.garbage(this, messages);
			}
		}
	}
	nextTick() {
		let length = this.messages.length;
		if (this.io.readyState === 1) {
			this.io.send(JSON.stringify(this.messages));
			this.server.messagesSent += length;
			this.messagesSent += length;
		} else {
			console.warn('socket not ready to emit on WebSocket.emit', this);
			this.server.messagesFail += length;
		}
		this.messages = [];
	}

	[inspect]() {
		return Object.assign(this.toJSON ? this.toJSON() : {}, this.inspect());
	}
	inspect() {
		return {
			// data
			readyState: this.io.readyState,

			since: this.since,
			seen: this.seen,
			contacted: this.contacted,
			ping: this.ping,
			timedout: this.timedout,

			ip: this.ip,
			userAgent: this.userAgent,

			messagesSent: this.messagesSent,
			messagesReceived: this.messagesReceived,
			bytesReceived: this.bytesReceived,
			// functions
			emit: this.emit,
			once: this.once,
			disconnect: this.disconnect,
		};
	}
}

module.exports = WebSocketServer;
