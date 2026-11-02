import { parent } from './constants.js'
import {
	NO_RECONNECT,
	PROTOCOL_KEY,
	assertCloseReason,
} from '../shared/protocol.js'

import {
	frame,
	inspect,
	isArray,
	params,
	parse,
	stringify,
} from './utils.js'

import { WebSocket } from 'ws'

const DISCONNECT = frame(stringify([[PROTOCOL_KEY, NO_RECONNECT]]))

export class Socket {
	/** Last callback id handed out; ids start at 1, as 0 means "none". */
	#lastCallbackId = 0

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
		/**
		 * Replies this socket's client still owes, by callback id.
		 *
		 * @type {Map<
		 * 	number,
		 * 	{ fire: (args: any[]) => void; cancel: (err: Error) => void }
		 * >}
		 */
		this.callbacks = new Map()

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

		/** @type {Set<import('./Room.js').Room>} */
		this.rooms = new Set()
	}

	/**
	 * Queue a message for the next batch. With a callback, returns a
	 * promise for the callback's result, rejected if the socket closes
	 * before the client replies.
	 *
	 * @overload
	 * @param {any} k
	 * @param {any} [v]
	 * @returns {void}
	 */
	/**
	 * @overload
	 * @param {any} k
	 * @param {Function} callback
	 * @returns {Promise<any>}
	 */
	/**
	 * @overload
	 * @param {any} k
	 * @param {any} v
	 * @param {Function} callback
	 * @returns {Promise<any>}
	 */
	/**
	 * @param {any} k
	 * @param {any} [v]
	 * @param {Function} [cb]
	 */
	emit(k, v, cb) {
		if (!this.messages.length) {
			this.server.nextQueue(this)
		}
		if (cb) {
			const [id, promise] = this.callback(cb)
			this.messages.push([k, v, id])
			return promise
		}
		if (typeof v === 'function') {
			const [id, promise] = this.callback(v)
			this.messages.push([k, 0, id])
			return promise
		}
		this.messages.push(typeof k === 'object' ? k : [k, v])
	}

	/**
	 * Close the connection.
	 *
	 * @param {boolean} [noReconnect] Pass `true` to also tell the client
	 *   not to reconnect.
	 * @param {string} [reason] Close reason sent to the client, up to
	 *   123 bytes.
	 */
	disconnect(noReconnect, reason = 'server disconnect') {
		assertCloseReason(reason)
		if (noReconnect) {
			this.write(DISCONNECT)
		}
		this.io.close(1000, reason)
		// The closing handshake completes later; we already know the
		// socket is gone, so clean up now. `onclose` is idempotent.
		this.onclose(1000, reason)
	}

	// private

	listen() {
		this.io.on('message', this.onmessage)
		this.io.on('close', this.onclose)
		this.io.on('error', this.onerror)
	}

	/** @param {Buffer} raw */
	onmessage = raw => {
		if (raw.length === 0) {
			this.server.pong(this)
			return
		}
		this.seen = this.server.now

		this.server.bytesReceived += raw.length
		this.bytesReceived += raw.length

		const message = raw.toString()
		const messages = this.parse(message)
		if (isArray(messages)) {
			this.dispatch(messages)
		} else {
			this.garbage(messages ?? message)
		}
	}

	/**
	 * @param {number} code Close code
	 * @param {Buffer | string} reason Close reason
	 */
	onclose = (code, reason) => {
		if (this.closed) return
		this.closed = true
		this.server.sockets.delete(this)

		const error = new Error('disconnected')
		for (const pending of this.callbacks.values()) pending.cancel(error)
		this.callbacks.clear()

		// Leaving deletes the room from this.rooms; Set iteration allows that.
		for (const room of this.rooms) {
			room[parent]
				? room[parent].leave(this, room.id)
				: room.leave(this)
		}

		this.server.hooks.disconnect?.(this, code, reason.toString())
	}

	onerror = err => {
		this.server.socketErrors++
		console.error('[angelia.io] socket error', err)
	}

	// callbacks

	/** @returns {[number, Promise<any>]} */
	callback(c) {
		const { promise, resolve, reject } = Promise.withResolvers()
		// Callers using only the callback never read the promise; its
		// rejection on close must not crash the process as unhandled.
		// Callers that await it still get the rejection.
		promise.catch(() => {})
		const id = ++this.#lastCallbackId
		this.callbacks.set(id, {
			fire: args => resolve(c(...args)),
			cancel: reject,
		})
		return [id, promise]
	}

	/**
	 * Settle the callback a reply is for.
	 *
	 * @param {unknown} d Reply payload, `[id, args]`
	 * @returns {boolean} Whether `d` answered a pending callback
	 */
	oncallback(d) {
		const pending =
			isArray(d) && isArray(d[1]) && this.callbacks.get(d[0])
		if (!pending) return false
		this.callbacks.delete(d[0])
		pending.fire(d[1])
		return true
	}

	// messages

	/** @returns {unknown} The parsed value, or undefined if not JSON. */
	parse(o) {
		try {
			return parse(o)
		} catch {
			return undefined
		}
	}

	/**
	 * Route an array of parsed messages through the registered event
	 * handlers. `events` only holds client-callable handlers, so a lookup
	 * miss is the whole validation a key needs.
	 */
	dispatch(messages) {
		this.server.messagesReceived += messages.length
		this.messagesReceived += messages.length

		this.server.hooks.incoming?.(this, messages)
		for (const m of messages) {
			if (!isArray(m)) {
				this.garbage(m)
			} else if (m[0] === PROTOCOL_KEY) {
				if (!this.oncallback(m[1])) this.garbage(m)
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
								this.emit(PROTOCOL_KEY, [m[2], v])
							}
						: undefined,
				)
			} else {
				this.garbage(m)
			}
		}
	}

	/** @param {unknown} m */
	garbage(m) {
		this.server.messagesGarbage++
		this.server.hooks.garbage?.(this, m)
	}

	processQueue() {
		// Reset before running any user hook: `outgoing` may emit mid-drain,
		// and `emit` only re-schedules on an empty queue.
		const messages = this.messages
		this.messages = []
		if (this.io.readyState !== WebSocket.OPEN) return

		this.server.hooks.outgoing?.(this, messages)
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
