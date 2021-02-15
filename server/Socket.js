const inspect = Symbol.for('nodejs.util.inspect.custom');

class Socket {
	constructor(socket, server) {
		Object.assign(this, {
			server: server,

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
			oncallback: this.oncallback.bind(this),

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
	oncallback(k, ...v) {
		this.emit('', [k, v]);
	}
	onmessage(e) {
		if (e === '') {
			this.server.Listeners.pong(this);
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

				this.server.Listeners.messages && this.server.Listeners.messages(this, messages);

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
	nextTick() {
		let length = this.messages.length;
		if (this.io.readyState === 1) {
			this.io.send(JSON.stringify(this.messages));
			this.server.messagesSent += length;
			this.messagesSent += length;
		} else {
			console.warn('socket not ready to emit on Socket.emit', this.inspect());
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
			query: this.query,

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

module.exports = Socket;
