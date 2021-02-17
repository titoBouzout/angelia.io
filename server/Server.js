const inspect = Symbol.for('nodejs.util.inspect.custom');
const URL = require('url');
const toFastProperties = require('to-fast-properties');

const Socket = require('./Socket.js');
const Listeners = require('./Listeners.js');

class Server {
	constructor(options) {
		Object.assign(this, {
			port: +options.port > 0 && +options.port <= 65535 ? +options.port : 3001,
			maxMessageSize: +options.maxMessageSize > 0 ? +options.maxMessageSize : 5,
			timeout: 30 * 1000,

			messages: [],

			since: Date.now(),
			now: Date.now(),

			served: 0,
			bytesSent: 0,
			bytesReceived: 0,
			messagesSent: 0,
			messagesReceived: 0,
			messagesCached: 0,

			pong: this.pong.bind(this),
			ping: this.ping.bind(this),
			updateNow: this.updateNow.bind(this),

			onconnect: this.onconnect.bind(this),
			onerror: this.onerror.bind(this),

			processMessages: this.processMessages.bind(this),

			inspect: this.inspect.bind(this),

			Listeners: Listeners,

			sockets: new Set(),

			cacheIds: Symbol.for('Server.cacheIds'),
			cacheId: 1,
			cache: Object.create(null),
		});

		this[inspect] = this.toJSON = this.inspect;

		this.Listeners.add(this.pong);
		this.Listeners.server = this;
		Object.defineProperties(this.Listeners, {
			server: {
				writable: false,
				configurable: false,
				enumerable: false,
			},
		});

		this.ensureFastProperties();

		// ping
		setInterval(this.ping, this.timeout / 2);
		setInterval(this.updateNow, 500);

		// fire the server
		let server;
		if (options.cert && options.key) {
			let fs = require('fs');
			server = require('https').createServer({
				cert: fs.readFileSync(options.cert), // fullchain.pem
				key: fs.readFileSync(options.key), // privkey.pem
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
			backlog: 1024,
		});

		io.on('connection', this.onconnect);
		io.on('error', this.onerror);

		server.listen(this.port, options.hostname || null);

		for (let m of ['RESTART', 'SIGINT', 'SIGTERM']) {
			process.on(m, () => {
				if (!io.closing) {
					io.closing = true;
					console.log('Server Shutting Down\n', this);
					io.close();
				}
			});
		}

		console.log('Server Started Listening On Port ' + this.port);
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

	get connections() {
		return this.sockets.size;
	}
	// PRIVATE API

	onconnect(socket, request) {
		this.updateNow();

		socket = new Socket(socket, this);

		// set the ip and userAgent
		Object.assign(socket, {
			ip: (
				this.ip(request.connection.remoteAddress) ||
				this.ip((request.headers['x-forwarded-for'] || '').split(/\s*,\s*/)[0]) ||
				request.connection.remoteAddress ||
				(request.headers['x-forwarded-for'] || '').split(/\s*,\s*/)[0]
			).replace(/'^::ffff:'/, ''),
			userAgent: request.headers['user-agent'] || '',
			params: URL.parse(request.url, true).query,
		});

		this.served++;

		socket.listen();

		this.sockets.add(socket);

		// dispatch connect
		this.Listeners.connect && this.Listeners.connect(socket, request);

		this.pingSocket.bind(this, socket);
	}
	onerror(err) {
		console.error('Server.onerror', err);
	}

	// messages

	nextMessages(socket) {
		if (!this.messages.length) {
			process.nextTick(this.processMessages);
		}
		this.messages.push(socket);
	}

	processMessages() {
		let messages = this.messages;
		this.messages = [];
		for (let socket of messages) {
			socket.processMessages();
		}
		// clear cache
		this.cache = Object.create(null);
	}

	cacheMessages(messages) {
		let id = '';
		for (let m of messages) {
			if (!m[this.cacheIds]) {
				m[this.cacheIds] = this.cacheId++;
			}
			id += m[this.cacheIds] + ',';
		}
		if (!this.cache[id]) {
			this.cache[id] = JSON.stringify(messages);
		} else {
			this.messagesCached++;
		}
		return this.cache[id];
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
		this.updateNow();
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
			case '::ffff:127.0.0.1':
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
			now: this.now,
			// options
			port: this.port,
			maxMessageSize: this.maxMessageSize,
			timeout: this.timeout,
			// stats
			connections: this.connections,
			served: this.served,
			bytesSent: this.bytesSent,
			bytesReceived: this.bytesReceived,
			messagesSent: this.messagesSent,
			messagesReceived: this.messagesReceived,
			messagesCached: this.messagesCached,
			// listeners
			Listeners: this.Listeners.toJSON(),
			// functions
			emit: this.emit,
			once: this.once,
			// data
			sockets: this.sockets,
		};
	}
	ensureFastProperties() {
		// server
		toFastProperties(this);

		// the Listener class
		toFastProperties(this.Listeners);

		// listeners
		for (let l in this.Listeners) {
			// listener
			toFastProperties(this.Listeners[l]);
			// methods
			if (this.Listeners[l].fns) {
				for (let m in this.Listeners[l].fns) {
					toFastProperties(this.Listeners[l].fns[m]);
				}
			}
		}

		const Classes = Symbol.for('Listeners.Classes');

		// classes
		toFastProperties(this.Listeners[Classes]);
		for (let l in this.Listeners[Classes]) {
			// class
			toFastProperties(this.Listeners[Classes][l]);
			// methods
			for (let m in this.Listeners[Classes][l]) {
				toFastProperties(this.Listeners[Classes][l][m]);
			}
		}

		// this.fastPropertiesPrint();
	}
	fastPropertiesPrint() {
		// server
		console.log('this.server', this.HasFastProperties(this));
		console.log('this.Listeners', this.HasFastProperties(this.Listeners));

		// listeners
		for (let l in this.Listeners) {
			// listener
			console.log('this.Listeners.' + l, this.HasFastProperties(this.Listeners[l]));
			// methods
			if (this.Listeners[l].fns) {
				for (let m in this.Listeners[l].fns) {
					console.log(
						'this.Listeners.' + l + '.' + this.Listeners[l].fns[m].name,
						this.HasFastProperties(this.Listeners[l].fns[m]),
					);
				}
			}
		}

		const Classes = Symbol.for('Listeners.Classes');

		// classes
		console.log('this.Listeners.Classes', this.HasFastProperties(this.Listeners[Classes]));
		for (let m in this.Listeners[Classes]) {
			console.log(
				'this.Listeners.Classes.' + m,
				this.HasFastProperties(this.Listeners[Classes][m]),
			);
			// class
			for (let f in this.Listeners[Classes][m]) {
				// methods
				console.log(
					'this.Listeners.Classes.' + m + '.' + this.Listeners[Classes][m][f].name,
					this.HasFastProperties(this.Listeners[Classes][m][f]),
				);
			}
		}
	}
	HasFastProperties(o) {
		// return %HasFastProperties(o);
	}
}

Server.Listeners = Listeners;

module.exports = Server;
