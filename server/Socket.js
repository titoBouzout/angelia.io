import { LIFECYCLE_EVENTS, parent } from './constants.js'

import {
	frame,
	inspect,
	isArray,
	params,
	parse,
	remove,
	stringify,
} from './utils.js'

import { WebSocket } from 'ws'

const DISCONNECT = frame(stringify([['disconnect', true]]))

export class Socket {
	/**
	 * @param {WebSocket} io
	 * @param {import('node:http').IncomingMessage} request Upgrade request
	 * @param {any} server
	 */
	constructor(io, request, server) {
		this.server = server
		this.io = io

		const headers = request.headers
		this.ip = clientIp(request, server.trustProxy)
		this.userAgent = headers['user-agent'] || ''
		this.params = params(request.url)

		/** @type {any[]} */
		this.messages = []
		/** @type {(Function | null)[]} */
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
		this.closed = false

		this.rooms = []
	}

	/** Queue a message for the next batch. */
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

	/**
	 * Close the connection.
	 *
	 * @param {boolean} [noReconnect] Pass `true` to also send a
	 *   `disconnect` frame so the client suppresses its auto-reconnect.
	 * @param {string} [reason] Close reason sent to the client, up to
	 *   123 bytes.
	 */
	disconnect(noReconnect, reason = 'server disconnect') {
		if (noReconnect) {
			this.write(DISCONNECT)
		}
		this.io.close(1000, reason)
		// The closing handshake completes later; we already know the
		// socket is gone, so clean up now. `onclose` is idempotent.
		this.onclose()
	}

	// private

	listen() {
		this.io.on('message', this.onmessage)
		this.io.on('close', this.onclose)
		this.io.on('error', this.onerror)
	}

	/** @param {import('ws').RawData} raw */
	onmessage = raw => {
		const message = raw.toString()
		if (message === '') {
			this.server.pong(this)
			return
		}
		this.seen = this.server.now

		const bytes = Buffer.byteLength(message)
		this.server.bytesReceived += bytes
		this.bytesReceived += bytes

		const messages = this.parse(message)
		if (messages && isArray(messages)) {
			this.dispatch(messages)
		} else {
			this.server.messagesGarbage++
			this.server.events.garbage?.(this, messages || message)
		}
	}

	onclose = () => {
		if (this.closed) return
		this.closed = true
		remove(this.server.sockets, this)

		// The replies these wait for will never arrive; holding them
		// would also pin user closures.
		this.callbacks = [null]

		// Room.leave mutates this.rooms via splice — iterate a snapshot
		for (const room of this.rooms.slice()) {
			room[parent]
				? room[parent].leave(this, room.id)
				: room.leave(this)
		}

		this.server.events.disconnect?.(this)
	}

	onerror = err => {
		this.server.socketErrors++
		console.error('[angelia.io] socket error', err)
	}

	// callbacks
	callback(c) {
		const i = this.callbacks.length
		this.callbacks[i] = c
		return i
	}

	/** @param {[number, any[]]} d Reply payload, already shape-checked */
	oncallback(d, m) {
		const cb = this.callbacks[d[0]]
		if (!cb) {
			console.error("oncallback doesn't exist", this, m)
		} else {
			cb(...d[1])
			this.callbacks[d[0]] = null
		}
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

	/**
	 * Route an array of parsed messages through the registered event
	 * handlers.
	 */
	dispatch(messages) {
		this.server.messagesReceived += messages.length
		this.messagesReceived += messages.length

		this.server.events.incoming?.(this, messages)
		for (const m of messages) {
			if (!isMessage(m)) {
				this.server.messagesGarbage++
				this.server.events.garbage?.(this, m)
			} else if (m[0] === '') {
				this.oncallback(m[1], m)
			} else if (this.server.events[m[0]]) {
				let replied = false
				this.server.events[m[0]](
					this,
					m[1],
					m[2]
						? (...v) => {
								if (replied) {
									console.error(
										`reply() already called for "${m[0]}"`,
									)
									return
								}
								replied = true
								this.emit('', [m[2], v])
							}
						: undefined,
				)
			} else {
				this.server.messagesGarbage++
				this.server.events.garbage?.(this, m)
			}
		}
	}

	processQueue() {
		// Reset before running any user hook: `events.outgoing` may emit
		// mid-drain, and `emit` only re-schedules on an empty queue.
		const messages = this.messages
		this.messages = []
		if (this.io.readyState !== WebSocket.OPEN) return

		this.server.events.outgoing?.(this, messages)
		this.server.messagesSent += messages.length
		this.messagesSent += messages.length
		this.write(this.server.cacheMessages(messages))
	}

	/**
	 * Write a pre-built frame (see `utils.frame`); dropped once the socket
	 * is closing. Goes through ws's frame writer instead of `send()`, which
	 * would re-frame per socket. Safe because the server never enables
	 * permessage-deflate nor sends Blobs, the only states that make ws queue.
	 *
	 * @param {Buffer[]} chunks
	 */
	write(chunks) {
		if (this.io.readyState !== WebSocket.OPEN) return
		let bytes = 0
		for (const chunk of chunks) bytes += chunk.length
		this.server.bytesSent += bytes
		this.bytesSent += bytes
		this.io._sender.sendFrame(chunks)
	}

	toJSON() {
		return '[content of socket object omitted for toJSON]'
	}

	[inspect]() {
		return {
			...this,
			server: 'omitted',
			io: 'omitted',

			messages: 'omitted',
			callbacks: 'omitted',

			readyState: this.io.readyState,
		}
	}
}

/**
 * Whether a parsed client message has a shape `dispatch` can route: a
 * reply `['', [id, args]]`, or `[key, value?, callbackId?]` naming a
 * user event. Lifecycle names are rejected so clients can't fire them.
 *
 * @param {unknown} m
 */
function isMessage(m) {
	if (!isArray(m) || typeof m[0] !== 'string') return false
	if (m[0] === '') {
		const d = m[1]
		return isArray(d) && typeof d[0] === 'number' && isArray(d[1])
	}
	return !LIFECYCLE_EVENTS.has(m[0])
}

/**
 * Client IP. Prefers `X-Forwarded-For` when `trustProxy` is on,
 * otherwise the TCP peer address, without any `::ffff:` prefix.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {boolean} trustProxy
 */
function clientIp(request, trustProxy) {
	const forwarded = request.headers['x-forwarded-for']
	const ip =
		(trustProxy && typeof forwarded === 'string'
			? forwarded.split(',')[0].trim()
			: '') ||
		request.socket.remoteAddress ||
		''
	return ip.replace(/^::ffff:/, '')
}
