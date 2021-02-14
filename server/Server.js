const inspect = Symbol.for('nodejs.util.inspect.custom');

const URL = require('url');

const Socket = require('./Socket.js');

class Server {
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

			Listeners: new Server.Listeners(),

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

		let ws = require('ws');
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
		this.Listeners.listen && this.Listeners.listen();
	}

	// emits to everyone connected to the server
	emit(k, v) {
		let d = [k, v];
		for (let socket of this.sockets) {
			socket.emit(d);
		}
	}
	once(k, v) {
		let d = [k, v];
		for (let socket of this.sockets) {
			socket.once(d);
		}
	}

	// PRIVATE API

	onconnect(socket, request) {
		this.updateNow();

		socket = new Socket(socket, this);

		// set the ip and userAgent
		Object.assign(socket, {
			ip:
				this.ip(request.connection.remoteAddress) ||
				this.ip((request.headers['x-forwarded-for'] || '').split(/\s*,\s*/)[0]) ||
				request.connection.remoteAddress ||
				(request.headers['x-forwarded-for'] || '').split(/\s*,\s*/)[0],
			userAgent: request.headers['user-agent'] || '',
			query: URL.parse(request.url, true).query,
		});

		this.socketsServed++;

		socket.listen();

		this.sockets.add(socket);

		// dispatch connect
		this.Listeners.connect && this.Listeners.connect(socket, request);
	}
	onerror(err) {
		console.error('Server.onerror', err);
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

Server.Listeners = require('./Listeners.js');

module.exports = Server;
