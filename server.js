const ws = require('ws');

const inspect = Symbol.for('nodejs.util.inspect.custom');

// TODO the listeners are globals for all connections
// so if you create two socket servers
// both socket servers have the same listeners D:
class WebSocketListeners {
	static add(aClass) {
		aClass = new aClass();
		for (let method of Object.getOwnPropertyNames(aClass.__proto__)) {
			if (method !== 'constructor') {
				WebSocketListeners.prototype[method] = aClass[method];
			}
		}
		for (let member in aClass) {
			WebSocketListeners.prototype[member] = aClass[member];
		}
	}
}

class WebSocketServer {
	constructor(port, https) {
		this.timeout = 30 * 1000;
		this.now = WebSocketServer.now = Date.now();

		this.started = Date.now();

		this.pong = this.pong.bind(this);
		this.ping = this.ping.bind(this);
		this.updateNow = this.updateNow.bind(this);

		this.onconnect = this.onconnect.bind(this);
		this.onerror = this.onerror.bind(this);

		this.Listeners = WebSocketServer.Listeners = new WebSocketListeners();
		this.Listeners.io = this;
		this.Listeners.pong = this.pong;
		delete this.Listeners.add;

		// TODO setInterval(this.ping, this.timeout / 2);
		setInterval(this.updateNow, 500);

		let server;
		if (https) {
			let fs = require('fs');
			server = require('https').createServer({
				cert: fs.readFileSync(https.cert),
				key: fs.readFileSync(https.key),
			});
		} else {
			server = require('http').createServer();
		}

		this.io = new ws.Server({
			server: server,
			perMessageDeflate: false,
			maxPayload: 5 * 1024 * 1024, // 5mb TODO
		});

		this.io.on('connection', this.onconnect);
		this.io.on('error', this.onerror);

		server.listen(port);

		console.log((https ? 'wss' : 'ws') + ' Server started listening on port ' + port);
	}
	// returns all socket.io connected to the server
	sockets() {
		return this.io.clients;
	}
	// returns count of sockets connected to the server
	count() {
		return this.io.clients.size;
	}
	// emits to everyone connected to the server
	emit(k, v) {
		let d = JSON.stringify([
			{
				k,
				v,
			},
		]);
		for (let socket of this.io.clients) {
			if (socket.readyState === 1) {
				socket.send(d);
			} else {
				console.warn('socket not ready to emit on WebSocketServer.emit', socket, d);
			}
		}
	}

	// PRIVATE API

	onconnect(socket, request) {
		this.updateNow();

		socket = new WebSocket(socket);

		// set the ip and userAgent
		Object.assign(socket, {
			ip:
				this.ip(request.connection.remoteAddress) ||
				this.ip((request.headers['x-forwarded-for'] || '').split(/\s*,\s*/)[0]) ||
				request.connection.remoteAddress ||
				(request.headers['x-forwarded-for'] || '').split(/\s*,\s*/)[0],
			userAgent: request.headers['user-agent'] || '',
		});

		// set now time
		Object.assign(socket.io, {
			started: this.now,
			now: this.now,
			contacted: this.now,
			ping: 0,
		});

		// send first ping
		this.pingSocket(socket.io);

		// dispatch connect
		if (this.Listeners.connect) {
			this.Listeners.connect(socket);
		}
	}
	onerror(a, b) {
		console.error('WebSocketServer.onerror', a, b);
	}

	// ping stuff
	updateNow() {
		this.now = WebSocketServer.now = Date.now();
	}
	ping() {
		this.updateNow();
		for (let socket of this.io.clients) {
			if (this.now - socket.now > this.timeout) {
				// timedout
				if (this.Listeners.timeout) {
					this.Listeners.timeout(socket);
				}
				socket.terminate();
			} else {
				// ping
				// TODO maybe dont ping if they are sending messages
				this.pingSocket(socket);
			}
		}
	}
	pingSocket(socket) {
		socket.contacted = this.now;
		if (socket.readyState === 1) {
			socket.send('');
		} else {
			console.warn('socket not ready to emit ping on WebSocketServer.pingSocket', socket);
		}
	}
	pong(socket) {
		this.updateNow();
		socket.io.now = this.now;
		socket.io.ping = this.now - socket.io.contacted;
		if (this.Listeners.ping) {
			this.Listeners.ping(socket);
		}
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
	[inspect]() {
		return this.inspect();
	}
	toJSON() {
		return this.inspect();
	}
	inspect() {
		return {
			started: this.started,
			timeout: this.timeout,
			count: this.io.clients.size,
			sockets: this.io.clients, // todo may return the WebSocket class
		};
	}
}

WebSocketServer.Listeners = WebSocketListeners;

class WebSocket {
	constructor(socket) {
		this.Listeners = WebSocketServer.Listeners;
		this.messages = [];

		this.onclose = this.onclose.bind(this);
		this.onerror = this.onerror.bind(this);
		this.onmessage = this.onmessage.bind(this);

		this.nextTick = this.nextTick.bind(this);
		this.inspectIO = this.inspectIO.bind(this);

		this.io = socket;
		this.io.on('close', this.onclose);
		this.io.on('error', this.onerror);
		this.io.on('message', this.onmessage);
		this.io[inspect] = this.io.toJSON = this.inspectIO;
	}
	// time this socket was first seen
	get started() {
		return this.io.started;
	}
	// last seen
	get now() {
		return this.io.now;
	}
	// ping in miliseconds
	get ping() {
		return this.io.ping;
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

	disconnect() {
		this.io.close();
	}
	// private API
	onclose(a, b) {
		if (this.Listeners.disconnect) {
			this.Listeners.disconnect(this, a, b);
		}
	}
	onerror(a, b) {
		console.error('WebSocket.onerror', a, b, 'readyState is', this.io.readyState);
	}
	onmessage(e) {
		if (e === '') {
			this.Listeners.pong(this);
		} else {
			let messages = JSON.parse(e);
			for (let m of messages) {
				if (this.Listeners[m.k]) {
					this.Listeners[m.k](this, m.v);
				} else {
					console.warn(m.k, 'is not on WebSocketListeners class', m.v, this);
				}
			}
			this.io.now = WebSocketServer.now;
		}
	}

	nextTick() {
		if (this.io.readyState === 1) {
			this.io.send(JSON.stringify(this.messages));
		} else {
			console.warn('socket not ready to emit on WebSocket.emit', this);
		}
		this.messages = [];
	}

	[inspect]() {
		return Object.assign(
			{
				started: this.started,
				now: this.now,
				ping: this.ping,
				ip: this.ip,
				userAgent: this.userAgent,
			},
			this.toJSON ? this.toJSON() : {},
		);
	}
	inspectIO() {
		return {
			readyState: this.io.readyState,
		};
	}
}

module.exports = WebSocketServer;
