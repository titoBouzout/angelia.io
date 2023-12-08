const inspect = Symbol.for('nodejs.util.inspect.custom')

import { leave } from './rooms/constants.js'

export class Socket {
	constructor(socket, server) {
		Object.assign(this, {
			server: server,

			ip: '',
			userAgent: '',
			params: {},

			messages: [],
			callbacks: [() => {}],

			bytesSent: 0,
			bytesReceived: 0,
			messagesSent: 0,
			messagesReceived: 0,

			since: server.now,
			seen: server.now,
			contacted: server.now,
			ping: 0,
			timedout: false,

			onclose: this.onclose.bind(this),
			onerror: this.onerror.bind(this),
			onmessage: this.onmessage.bind(this),
			doreply: this.doreply.bind(this),

			inspect: this.inspect.bind(this),

			io: socket,
			proxy: server.tracking ? server.observe(this) : this,
			rooms: new Set(),

			null: Object.create(null),
		})
		this.toJSON = this[inspect] = this.inspect

		Object.assign(socket, {
			[inspect]: this.inspect,
			toJSON: this.inspect,
		})
	}
	emit(k, v, cb) {
		if (!this.messages.length) {
			this.server.nextQueue(this)
		}

		if (cb) {
			this.messages.push([k, v, this.callback(cb)])
		} else if (typeof v === 'function') {
			this.messages.push([k, this.null, this.callback(v)])
		} else {
			this.messages.push(typeof k === 'object' ? k : [k, v])
		}
	}
	once(k, v) {
		if (!this.messages.length) {
			this.emit(k, v)
		} else {
			if (typeof k === 'object') {
				for (let m of this.messages) {
					if (m[0] === k[0]) {
						m[1] = k[1]
						return
					}
				}
			} else {
				for (let m of this.messages) {
					if (m[0] === k) {
						m[1] = v
						return
					}
				}
			}
			this.emit(k, v)
		}
	}
	disconnect(noReconnect) {
		if (noReconnect) {
			for (let m of this.server.disconnectData)
				this.io._socket.write(m)
		}
		this.io.close()
	}

	// PRIVATE API
	listen() {
		this.io.on('close', this.onclose)
		this.io.on('error', this.onerror)
		this.io.on('message', this.onmessage)
	}
	onclose(code, message) {
		this.server.sockets.delete(this)

		for (let room of this.rooms) {
			room[leave](this.proxy)
		}

		this.server.events.disconnect &&
			this.server.events.disconnect(this.proxy, code, message)
	}
	onerror(err) {
		this.server.socketErrors++
		console.error('Socket.onerror', err, this.inspect())
	}

	// callbacks
	callback(c) {
		let i = this.callbacks.length
		this.callbacks[i] = c
		return i
	}
	oncallback(d, m) {
		if (!this.callbacks[d[0]]) {
			console.log('oncallback doesnt exits', this, m)
		} else {
			this.callbacks[d[0]](...d[1])
			this.callbacks[d[0]] = null
		}
	}
	doreply(k, ...v) {
		this.emit('', [k, v])
	}

	// messages
	parse(o) {
		try {
			return JSON.parse(o)
		} catch (e) {
			console.log('parser error', this, o)
			return false
		}
	}
	onmessage(e) {
		if (e === '') {
			this.server.pong(this)
		} else {
			this.seen = this.server.now

			this.server.bytesReceived += e.length
			this.bytesReceived += e.length

			let messages = this.parse(e)

			if (messages && Array.isArray(messages)) {
				this.server.messagesReceived += messages.length
				this.messagesReceived += messages.length

				this.server.events.incoming &&
					this.server.events.incoming(this.proxy, messages)
				for (let m of messages) {
					if (m[0] === '') {
						this.oncallback(m[1], m)
					} else if (this.server.events[m[0]]) {
						this.server.events[m[0]](
							this.proxy,
							m[1],
							m[2] && this.doreply.bind(null, m[2]),
						)
					} else {
						this.server.messagesGarbage++
						this.server.events.garbage &&
							this.server.events.garbage(this.proxy, m)
					}
				}
			} else {
				this.server.messagesGarbage++
				this.server.events.garbage &&
					this.server.events.garbage(this.proxy, messages || e)
			}
		}
	}
	processQueue() {
		if (this.io.readyState === 1) {
			if (this.messages.length) {
				let messages = this.messages
				this.messages = []

				this.server.events.outgoing &&
					this.server.events.outgoing(this.proxy, messages)

				this.server.messagesSent += messages.length
				this.messagesSent += messages.length

				messages = this.server.cacheMessages(messages, this)

				for (let m of messages) this.io._socket.write(m)
			}
		}
		this.messages = []
	}

	inspect() {
		return {
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

			rooms: this.rooms,

			// functions
			emit: this.emit,
			once: this.once,
			disconnect: this.disconnect,
		}
	}
}
