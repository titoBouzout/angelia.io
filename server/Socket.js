import { parent } from './constants.js'

import {
	encode,
	inspect,
	isArray,
	params,
	parse,
	remove,
	stringify,
} from './utils.js'

// Shared no-op handler for fire-and-forget `writer.write()` — avoids
// allocating a new closure per write.
const noop = () => {}

export class Socket {
	/**
	 * @param {any} session WebTransport session
	 * @param {any} controlStream Bidi stream for queued messages
	 * @param {any} server
	 */
	constructor(session, controlStream, server) {
		this.server = server
		this.session = session
		this.control = controlStream

		// Writer for outgoing frames on the control stream.
		this.writer = controlStream.writable.getWriter()

		const headers = session.header || {}
		this.userAgent = headers['user-agent'] || ''
		this.params = params(headers[':path'] || '')

		/**
		 * Pending outbound messages, split by transport — same shape
		 * as the client's `#messages`. Both kinds debounce via the
		 * server's `nextQueue` next-tick scheduler.
		 *
		 * @type {{ emit: any[]; http: any[] }}
		 */
		this.messages = { emit: [], http: [] }
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

	/**
	 * Client IP. Prefers `X-Forwarded-For` when `trustProxy` is on
	 * (LB/proxy in front), otherwise the QUIC peer address. Strips
	 * the port and any IPv6-mapped-IPv4 (`::ffff:`) prefix. Computed
	 * on access so it tracks the live `session.peerAddress` if it
	 * ever updates (e.g., on QUIC connection migration).
	 */
	get ip() {
		const headers = this.session.header || {}
		let ip = ''
		if (this.server.trustProxy) {
			ip = (headers['x-forwarded-for'] || '').split(',')[0].trim()
		}
		if (!ip) {
			const peer = (this.session.peerAddress || '').toString()
			const lastColon = peer.lastIndexOf(':')
			ip = lastColon === -1 ? peer : peer.slice(0, lastColon)
		}
		return ip.replace(/^::ffff:/, '')
	}

	/** Queue a message for the next control-stream batch. */
	emit(k, v, cb) {
		this.enqueue(this.messages.emit, k, v, cb)
	}

	/**
	 * Queue a message for the next out-of-band batch — sent on a fresh
	 * send-only stream rather than the control stream so big payloads
	 * don't head-of-line-block. Multiple `http()` calls in the same
	 * tick coalesce into one stream; fan-out emits (`Emitter.http`)
	 * pass the same array reference to every recipient so the
	 * encoding is cached and shared.
	 */
	http(k, v, cb) {
		this.enqueue(this.messages.http, k, v, cb)
	}

	/**
	 * Send pre-encoded bytes on a fresh send-only stream. Internal —
	 * called from `processQueue` once per http batch.
	 * Fire-and-forget: per-stream failures are swallowed so a dead
	 * socket can't take down a fan-out.
	 */
	httpBytes(bytes) {
		this.server.bytesSent += bytes.length
		this.bytesSent += bytes.length
		try {
			return this.session
				.createUnidirectionalStream()
				.then(stream => {
					const w = stream.getWriter()
					return w.write(bytes).then(() => w.close())
				})
				.catch(noop)
		} catch {
			// `createUnidirectionalStream()` throws synchronously (not a
			// rejection) when the session is already closed/failed — an
			// `http()` racing a disconnect. Swallow it like the rejected
			// path; escaping here would crash the whole drain (nextTick
			// has no handler above us).
		}
	}

	/**
	 * Close the session.
	 *
	 * @param {boolean} [noReconnect] Pass `true` to also write a
	 *   `disconnect` protocol frame so the client suppresses its
	 *   auto-reconnect.
	 * @param {string} [reason] Human-readable reason carried in QUIC's
	 *   `CONNECTION_CLOSE` frame; surfaced on the client-side
	 *   `WebTransportError`. Up to 1024 bytes.
	 */
	disconnect(noReconnect, reason = 'server disconnect') {
		if (noReconnect) {
			this.write(encode(stringify([['disconnect', true]]) + '\n'))
		}
		try {
			this.session.close({ closeCode: 0, reason })
		} catch {}
		// QUIC graceful close drains for ~2s with active streams; we
		// already know the socket is gone, so fire cleanup synchronously.
		// `onclose` is idempotent.
		this.onclose()
	}

	// private

	listen() {
		// Two ways the socket's life ends, both feed `onclose`:
		//   1. The control-stream pump returns (reader done or thrown).
		//   2. The session's `closed` promise settles — covers
		//      server-initiated `session.close()` which doesn't always
		//      wake the reader promptly.
		// `onclose` is idempotent so double-firing is safe.
		this.pump(this.control.readable).then(this.onclose, this.onclose)
		this.session.closed.then(this.onclose, this.onclose)
	}

	/**
	 * Pump a readable: dispatch each `\n`-terminated frame mid-stream
	 * via `onframe`, plus any un-terminated leftover when the stream
	 * ends. Shared by the long-lived control stream and the short
	 * per-call http payload streams (which carry one batch then
	 * close).
	 */
	async pump(readable) {
		const decode = TextDecoder.prototype.decode.bind(
			new TextDecoder(),
		)
		const reader = readable.getReader()
		let buf = ''
		try {
			while (true) {
				const { value, done } = await reader.read()
				if (done) {
					if (buf) this.onframe(buf)
					break
				}
				// Count actual UTF-8 bytes here, not `line.length` later
				// (which is UTF-16 code units). Symmetric with `write`,
				// which counts `bytes.length` of the outgoing buffer.
				this.server.bytesReceived += value.byteLength
				this.bytesReceived += value.byteLength
				buf += decode(value, { stream: true })
				let nl
				while ((nl = buf.indexOf('\n')) !== -1) {
					const line = buf.slice(0, nl)
					buf = buf.slice(nl + 1)
					this.onframe(line)
				}
			}
		} catch {
			// Stream closed / network error — parser errors land in
			// garbage via `parse`'s try/catch.
		}
	}

	/** Handle one newline-delimited frame from the control stream. */
	onframe(line) {
		if (line === '') {
			this.server.pong(this)
			return
		}
		this.seen = this.server.now

		const messages = this.parse(line)
		if (messages && isArray(messages)) {
			this.dispatch(messages)
		} else {
			this.server.messagesGarbage++
			this.server.events.garbage?.(this, messages || line)
		}
	}

	onclose = () => {
		if (this.closed) return
		this.closed = true
		remove(this.server.sockets, this)

		// Drop any outstanding RPC callbacks — the client just went
		// away, so the replies they're waiting for will never arrive.
		// Holding the cb references would also pin user closures.
		this.callbacks = [null]

		// Room.leave mutates this.rooms via splice — iterate a snapshot
		for (const room of this.rooms.slice()) {
			room[parent]
				? room[parent].leave(this, room.id)
				: room.leave(this)
		}

		this.server.events.disconnect?.(this)
	}

	/**
	 * Shared push+schedule logic for `emit` and `http`. The first
	 * push when both queues are empty triggers `nextQueue` so the
	 * server schedules a drain on the next tick. Mirrors the
	 * client's `#enqueue`.
	 */
	enqueue(queue, k, v, cb) {
		if (!this.messages.emit.length && !this.messages.http.length) {
			this.server.nextQueue(this)
		}
		if (cb) {
			queue.push([k, v, this.callback(cb)])
		} else if (typeof v === 'function') {
			queue.push([k, 0, this.callback(v)])
		} else {
			queue.push(typeof k === 'object' ? k : [k, v])
		}
	}

	// callbacks
	callback(c) {
		const i = this.callbacks.length
		this.callbacks[i] = c
		return i
	}

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
			if (m[0] === '') {
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
		const { emit, http } = this.messages
		// Reset BOTH queues before running any user hook. An
		// `events.outgoing` handler may enqueue mid-drain, and `enqueue`
		// only re-schedules when it sees both queues empty — a stale
		// non-empty queue here would leave that message (and every one
		// after it) undelivered forever.
		this.messages = { emit: [], http: [] }
		if (emit.length) {
			this.server.events.outgoing?.(this, emit)
			this.server.messagesSent += emit.length
			this.messagesSent += emit.length
			this.write(this.server.cacheMessages(emit))
		}
		if (http.length) {
			this.server.events.outgoing?.(this, http)
			this.server.messagesSent += http.length
			this.messagesSent += http.length
			this.httpBytes(this.server.cacheMessages(http))
		}
	}

	/** Write a Uint8Array frame to the control stream. */
	write(bytes) {
		this.server.bytesSent += bytes.length
		this.bytesSent += bytes.length
		// Fire-and-forget: writer.write() returns a Promise that rejects
		// if the session is gone. Swallow it — onclose handles cleanup.
		this.writer.write(bytes).catch(noop)
	}

	toJSON() {
		return '[content of socket object omitted for toJSON]'
	}

	[inspect]() {
		return {
			...this,
			// Spread misses prototype getters — surface `ip` explicitly.
			ip: this.ip,
			server: 'omitted',
			session: 'omitted',
			control: 'omitted',
			writer: 'omitted',

			messages: 'omitted',
			callbacks: 'omitted',
		}
	}
}
