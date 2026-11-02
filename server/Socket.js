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
	parse,
	stringify,
} from './utils.js'

import { WebSocket } from 'ws'

/** @import { ClientEvents, ClientReplies, EventKey, EventValue } from './index.js' */
/** @import { Room } from './Room.js' */
/** @import { Server } from './Server.js' */

const DISCONNECT = frame(stringify([[PROTOCOL_KEY, NO_RECONNECT]]))

// Rejection message for replies the client can no longer send.
const DISCONNECTED = 'disconnected: the socket closed before the client replied'

// Marks a reply promise as handled; shared so no closure is made per call.
const ignore = () => {}

/** `request()`'s callback: resolve with the reply as it is. */
const settle = reply => reply

/** One client connection, handed to every event handler and hook. */
export class Socket {
	/** Last callback id handed out; ids start at 1, as 0 means "none". */
	#lastCallbackId = 0

	/** @internal When the last ping was sent, to time the pong. */
	contacted = 0

	/**
	 * @internal Messages waiting for the next batch.
	 * @type {any[]}
	 */
	messages = []
	/**
	 * @internal Replies this socket's client still owes, by callback id.
	 * @type {Map<
	 * 	number,
	 * 	{ fire: (args: any[]) => void; cancel: (err: Error) => void }
	 * >}
	 */
	callbacks = new Map()

	/**
	 * @internal Created by the server for each connection.
	 * @param {WebSocket} io
	 * @param {import('node:http').IncomingMessage} request Upgrade request
	 * @param {Server} server
	 * @param {Record<string, string>} params The connect URL's query params
	 */
	constructor(io, request, server, params) {
		this.server = server
		/** The underlying `ws` WebSocket. */
		this.io = io

		const headers = request.headers
		/** Client IP; from `X-Forwarded-For` when `trustProxy` is on. */
		this.ip = clientIp(request, server.trustProxy)
		this.userAgent = headers['user-agent'] || ''
		/** The connect URL's query params, including `connid`. */
		this.params = params

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

		/** @type {Set<Room>} The rooms this socket is in. */
		this.rooms = new Set()
	}

	/**
	 * Queue a message for the next batch. With a callback, returns a
	 * promise for the callback's result, rejected if the socket closes
	 * before the client replies.
	 *
	 * @template {EventKey<ClientEvents>} K
	 * @overload
	 * @param {K} k
	 * @param {EventValue<ClientEvents, K>} v
	 * @returns {void}
	 */
	/**
	 * @template {EventKey<ClientEvents>} K
	 * @template R
	 * @overload
	 * @param {K} k
	 * @param {EventValue<ClientEvents, K>} v
	 * @param {(reply: EventValue<ClientReplies, K>) => R} callback
	 * @returns {Promise<R>}
	 */
	/**
	 * @param {any} k
	 * @param {any} [v]
	 * @param {Function} [cb]
	 * @returns {Promise<any> | void}
	 */
	emit(k, v, cb) {
		if (cb) {
			const [id, promise] = this.callback(cb)
			this.queue([k, v, id])
			return promise
		}
		this.queue([k, v])
	}

	/**
	 * @internal Queue a wire tuple; fan-outs pass one tuple to every
	 * recipient so `Server.cacheMessages` encodes it once.
	 * @param {any[]} message
	 */
	queue(message) {
		if (!this.messages.length) {
			this.server.nextQueue(this)
		}
		this.messages.push(message)
	}

	/**
	 * Emit and resolve with the client's reply; rejected with
	 * a `disconnected:` Error if the socket closes first.
	 *
	 * @template {EventKey<ClientEvents>} K
	 * @overload
	 * @param {K} k
	 * @returns {Promise<EventValue<ClientReplies, K>>}
	 */
	/**
	 * @template {EventKey<ClientEvents>} K
	 * @overload
	 * @param {K} k
	 * @param {EventValue<ClientEvents, K>} v
	 * @returns {Promise<EventValue<ClientReplies, K>>}
	 */
	/**
	 * @param {any} k
	 * @param {any} [v]
	 * @returns {Promise<any>}
	 */
	request(k, v) {
		return this.emit(k, v, settle)
	}

	/**
	 * Close the connection.
	 *
	 * @param {boolean} [noReconnect] Pass `true` to also tell the client
	 *   not to reconnect.
	 * @param {string} [reason] Close reason sent to the client, up to
	 *   123 bytes; longer throws a `RangeError` before anything closes.
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

	/** @internal */
	listen() {
		this.io.on('message', this.onmessage)
		this.io.on('close', this.onclose)
		this.io.on('error', this.onerror)
	}

	/** @internal @param {Buffer} raw */
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
	 * @internal
	 * @param {number} code Close code
	 * @param {Buffer | string} reason Close reason
	 */
	onclose = (code, reason) => {
		if (this.closed) return
		this.closed = true
		this.server.sockets.delete(this)

		// An Error captures a stack trace: only build one when it's needed.
		if (this.callbacks.size) {
			const error = new Error(DISCONNECTED)
			for (const pending of this.callbacks.values()) pending.cancel(error)
			this.callbacks.clear()
		}

		// Leaving deletes the room from this.rooms; Set iteration allows that.
		for (const room of this.rooms) {
			room[parent]
				? room[parent].leave(this, room.id)
				: room.leave(this)
		}

		this.server.hooks.disconnect?.(this, code, reason.toString())
	}

	/** @internal @param {Error} err */
	onerror = err => {
		this.server.socketErrors++
		console.error(
			'[angelia.io] socket error, counted in socketErrors. ws closes that connection.',
			err,
		)
	}

	// callbacks

	/**
	 * @internal
	 * @param {Function} c
	 * @returns {[number, Promise<any>]}
	 */
	callback(c) {
		const { promise, resolve, reject } = Promise.withResolvers()
		// Callers using only the callback never read the promise; its
		// rejection on close must not crash the process as unhandled.
		// Callers that await it still get the rejection.
		promise.catch(ignore)
		const id = ++this.#lastCallbackId
		// Already closed: `onclose` won't run again to settle it.
		if (this.closed) {
			reject(new Error(DISCONNECTED))
			return [id, promise]
		}
		this.callbacks.set(id, {
			fire: args => resolve(c(...args)),
			cancel: reject,
		})
		return [id, promise]
	}

	/**
	 * @internal Settle the callback a reply is for.
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

	/**
	 * @internal
	 * @param {string} o
	 * @returns {unknown} The parsed value, or undefined if not JSON.
	 */
	parse(o) {
		try {
			return parse(o)
		} catch {
			return undefined
		}
	}

	/**
	 * @internal Route an array of parsed messages through the registered event
	 * handlers. `events` only holds client-callable handlers, so a lookup
	 * miss is the whole validation a key needs.
	 *
	 * @param {unknown[]} messages
	 */
	dispatch(messages) {
		this.server.messagesReceived += messages.length
		this.messagesReceived += messages.length

		this.server.hooks.incoming?.(this, messages)
		let handler
		for (const m of messages) {
			if (!isArray(m)) {
				this.garbage(m)
			} else if (m[0] === PROTOCOL_KEY) {
				if (!this.oncallback(m[1])) this.garbage(m)
			} else if ((handler = this.server.events[m[0]])) {
				let replied = false
				handler(
					this,
					m[1],
					m[2]
						? (...v) => {
								if (replied) {
									console.error(
										`[angelia.io] reply() already called for "${m[0]}": a message gets one reply, so this one was dropped.`,
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

	/** @internal @param {unknown} m */
	garbage(m) {
		this.server.messagesGarbage++
		this.server.hooks.garbage?.(this, m)
	}

	/** @internal */
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
	 * @internal Write a pre-built frame (see `utils.frame`); dropped once the socket
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

	/**
	 * `console.log(socket)` shows who it is and how it's doing, not internals.
	 *
	 * @param {number} _depth
	 * @param {import('node:util').InspectOptionsStylized} options
	 * @param {typeof import('node:util').inspect} inspectValue
	 */
	[inspect](_depth, options, inspectValue) {
		const summary = {
			ip: this.ip,
			userAgent: this.userAgent,
			params: this.params,
			closed: this.closed,
			timedout: this.timedout,
			ping: this.ping,
			since: this.since,
			seen: this.seen,
			rooms: [...this.rooms].map(room => room.id),
			queued: this.messages.length,
			pendingReplies: this.callbacks.size,
			bytesSent: this.bytesSent,
			bytesReceived: this.bytesReceived,
			messagesSent: this.messagesSent,
			messagesReceived: this.messagesReceived,
		}
		return `Socket ${inspectValue(summary, options)}`
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
