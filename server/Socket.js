import { parent } from './constants.js'

import {
	fromEntries,
	inspect,
	isArray,
	MapeableSet,
	parse,
} from './utils.js'

export class Socket {
	constructor(socket, server, request) {
		this.server = server
		this.io = socket
		this.socket = socket._socket

		this.ip = (
			(request.headers['x-forwarded-for'] || '')
				.split(',')[0]
				.trim() || request.connection.remoteAddress
		).replace(/^::ffff:/, '')
		this.userAgent = request.headers['user-agent'] || ''
		this.params = fromEntries(
			new URLSearchParams(request.url.slice(9)),
		)

		this.messages = []
		/** @type Function[]| Null[] */
		this.callbacks = [null]

		this.bytesSent = 0
		this.bytesReceived = 0
		this.messagesSent = 0
		this.messagesReceived = 0

		this.since = server.now
		this.seen = server.now
		this.contacted = server.now

		this.ping = 0
		this.timedout = false

		this.rooms = new MapeableSet()
	}
	emit(k, v, cb) {
		if (!this.messages.length) {
			this.server.nextQueue(this)
		}

		if (cb) {
			this.messages.push([k, v, this.callback(cb)])
		} else if (typeof v === 'function') {
			this.messages.push([k, 0, this.callback(v)])
		} else {
			this.messages.push(typeof k === 'object' ? k : [k, v])
		}
	}
	once(k, v) {
		if (!this.messages.length) {
			this.emit(k, v)
		} else {
			if (typeof k === 'object') {
				for (const m of this.messages) {
					if (m[0] === k[0]) {
						m[1] = k[1]
						return
					}
				}
			} else {
				for (const m of this.messages) {
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
			this.write(this.server.disconnectData)
		}
		this.io.close()
	}

	// private

	listen() {
		this.io.on('close', this.onclose)
		this.io.on('error', this.onerror)
		this.io.on('message', this.onmessage)
	}
	onclose = (code, message, isBinary) => {
		message = message.toString()

		this.server.sockets.delete(this)

		for (const room of this.rooms) {
			room[parent].leave(this, room.id)
		}

		this.server.events.disconnect &&
			this.server.events.disconnect(this, code, message)
	}
	onerror = err => {
		this.server.socketErrors++
		console.error('Socket.onerror', err, this)
	}

	// callbacks
	callback(c) {
		const i = this.callbacks.length
		this.callbacks[i] = c
		return i
	}
	oncallback(d, m) {
		if (!this.callbacks[d[0]]) {
			console.error('oncallback doesnt exits', this, m)
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
			return parse(o)
		} catch (e) {
			console.log('parser error', this, o)
			return false
		}
	}
	onmessage = (e, isBinary) => {
		e = e.toString()

		if (e === '') {
			this.server.pong(this)
		} else {
			this.seen = this.server.now

			this.server.bytesReceived += e.length
			this.bytesReceived += e.length

			const messages = this.parse(e)

			if (messages && isArray(messages)) {
				this.server.messagesReceived += messages.length
				this.messagesReceived += messages.length

				this.server.events.incoming &&
					this.server.events.incoming(this, messages)
				for (const m of messages) {
					if (m[0] === '') {
						this.oncallback(m[1], m)
					} else if (this.server.events[m[0]]) {
						this.server.events[m[0]](
							this,
							m[1],
							m[2] && this.doreply.bind(this, m[2]),
						)
					} else {
						this.server.messagesGarbage++
						this.server.events.garbage &&
							this.server.events.garbage(this, m)
					}
				}
			} else {
				this.server.messagesGarbage++
				this.server.events.garbage &&
					this.server.events.garbage(this, messages || e)
			}
		}
	}
	processQueue() {
		if (this.io.readyState === 1) {
			if (this.messages.length) {
				const messages = this.messages
				this.messages = []

				this.server.events.outgoing &&
					this.server.events.outgoing(this, messages)

				this.server.messagesSent += messages.length
				this.messagesSent += messages.length

				this.write(this.server.cacheMessages(messages, this))
			}
		}
		// this.messages = []
	}
	write(messages) {
		this.socket.cork()
		for (const m of messages) {
			this.socket.write(m)
		}
		this.socket.uncork()
	}
	toJSON() {
		return '[content of socket object omitted for toJSON]'
	}
	[inspect]() {
		return {
			...this,
			server: 'omitted',
			io: 'omitted',
			socket: 'omitted',

			messages: 'omitted',
			callbacks: 'omitted',

			readyState: this.io.readyState,
		}
	}
}
