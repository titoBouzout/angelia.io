const inspect = Symbol.for('nodejs.util.inspect.custom');

class Socket {
	constructor(socket, server) {
		Object.assign(this, {
			server: server,

			messages: [],

			bytesSent: 0,
			bytesReceived: 0,
			messagesSent: 0,
			messagesReceived: 0,

			since: server.now,
			seen: server.now,
			contacted: server.now, // for ping
			ping: 0,
			timedout: false,

			onclose: this.onclose.bind(this),
			onerror: this.onerror.bind(this),
			onmessage: this.onmessage.bind(this),
			oncallback: this.oncallback.bind(this),

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
			this.server.nextMessages(this);
		}

		this.messages.push(typeof k !== 'string' ? k : [k, v]);
	}
	once(k, v) {
		if (!this.messages.length) {
			this.emit(k, v);
		} else {
			if (typeof k !== 'string') {
				for (let m of this.messages) {
					if (m[0] === k[0]) {
						m[1] = k[1];
						return;
					}
				}
			} else {
				for (let m of this.messages) {
					if (m[0] === k) {
						m[1] = v;
						return;
					}
				}
			}
			this.emit(k, v);
		}
	}

	disconnect(noReconnect) {
		if (noReconnect) {
			this.emit(['disconnect', true]);
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

		this.server.Listeners.disconnect && this.server.Listeners.disconnect(this, code, message);
	}
	onerror(err) {
		console.error('Socket.onerror', err, this.inspect());
	}
	oncallback(k, v) {
		this.emit('', [k, v]);
	}
	onmessage(e) {
		if (e === '') {
			this.server.Listeners.pong(this);
		} else {
			this.seen = this.server.now;

			this.server.bytesReceived += e.length;
			this.bytesReceived += e.length;

			let messages = JSON.parse(e);
			if (Array.isArray(messages)) {
				this.server.messagesReceived += messages.length;
				this.messagesReceived += messages.length;

				this.server.Listeners.incoming && this.server.Listeners.incoming(this, messages);
				for (let m of messages) {
					if (this.server.Listeners[m[0]]) {
						this.server.Listeners[m[0]](this, m[1], m[2] && this.oncallback.bind(null, m[2]));
					} else {
						this.server.Listeners.garbage && this.server.Listeners.garbage(this, m);
					}
				}
			} else {
				this.server.Listeners.garbage && this.server.Listeners.garbage(this, messages);
			}
		}
	}
	processMessages() {
		if (this.io.readyState === 1) {
			// regular
			if (this.messages.length) {
				this.server.Listeners.outgoing && this.server.Listeners.outgoing(this, this.messages);

				let messages = this.server.cacheMessages(this.messages);
				this.io.send(messages);

				this.server.bytesSent += messages.length;
				this.bytesSent += messages.length;

				this.server.messagesSent += this.messages.length;
				this.messagesSent += this.messages.length;
			}
		}
		this.messages = [];
	}

	[inspect]() {
		return Object.assign({}, this.toJSON ? this.toJSON() : {}, this.inspect());
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
			params: this.params,

			bytesSent: this.bytesSent,
			bytesReceived: this.bytesReceived,
			messagesSent: this.messagesSent,
			messagesReceived: this.messagesReceived,
			// functions
			emit: this.emit,
			once: this.once,
			disconnect: this.disconnect,
		};
	}
}

module.exports = Socket;
