import {
	empty,
	encode,
	isArray,
	ListenerTemplate,
	now,
	parse,
	stringify,
} from './utils.js'

import {
	DEFAULT_PORT,
	DEFAULT_TIMEOUT_MS,
	MAX_PORT,
	MIN_TIMEOUT_MS,
} from './constants.js'

import { Socket } from './Socket.js'
import { Emitter } from './Emitter.js'

import { nextTick } from 'node:process'
import { randomBytes } from 'node:crypto'

const randomSecret = () => randomBytes(32).toString('hex')

// Ping/pong frame is a constant byte — encode once, reuse forever.
const PING = encode('\n')

/** Creates a new Socket Server (singleton). */
export default new (class Server extends Emitter {
	constructor() {
		super()

		this.sockets = []

		this.hostname = ''
		this.port = DEFAULT_PORT

		this.timeout = DEFAULT_TIMEOUT_MS
		this.timeoutCheck = DEFAULT_TIMEOUT_MS / 2

		/**
		 * When true, read `x-forwarded-for` from the upgrade headers for
		 * the client IP. Only enable when a trusted proxy is in front.
		 */
		this.trustProxy = false

		this.since = 0
		this.now = 0

		this.served = 0
		this.bytesReceived = 0
		this.bytesSent = 0
		this.messagesGarbage = 0
		this.messagesReceived = 0
		this.messagesSent = 0
		this.messagesSentCacheHit = 0
		this.serverErrors = 0

		this.queue = []

		this.cacheSymbol = Symbol('cache')
		this.cached = 1
		this.cache = empty()

		this.events = empty()
	}

	/**
	 * Start listening over WebTransport (HTTP/3 / QUIC).
	 *
	 * @param {import('./Server.js').ServerListenOptions} options
	 */
	async listen(options) {
		// Guard against double-listen: would otherwise overwrite
		// `this.io`/`this.pingTimer`/`this.nowTimer` and leak the old
		// server + intervals (no way to clear them after reassignment).
		if (this.io) {
			throw new Error(
				'Server.listen() already called; call stop() first.',
			)
		}

		this.hostname = options.hostname || this.hostname

		const port = +(options.port ?? 0)
		this.port = port > 0 && port <= MAX_PORT ? port : this.port

		this.now = now()
		this.since = this.now

		const timeout = +(options.timeout ?? 0)
		this.timeout =
			timeout >= MIN_TIMEOUT_MS ? timeout : DEFAULT_TIMEOUT_MS

		this.trustProxy = !!options.trustProxy

		// updates ping and checks for disconnections. `unref` so a
		// stopped server doesn't hold the process alive on its own.
		this.timeoutCheck = this.timeout / 2
		this.pingTimer = setInterval(this.ping, this.timeoutCheck)
		this.pingTimer.unref()
		this.timeoutCheck -= 5000

		this.nowTimer = setInterval(this.#updateNow, 500)
		this.nowTimer.unref()

		if (!options.cert || !options.privKey) {
			throw new Error(
				'listen() requires `cert` and `privKey` options for WebTransport.',
			)
		}

		// Lazy-loaded so that `import Server from 'angelia.io/server'`
		// without calling listen() doesn't require the native dep.
		const { Http3Server } =
			await import('@fails-components/webtransport')
		const server = new Http3Server({
			port: this.port,
			host: this.hostname || '0.0.0.0',
			// QUIC retry-token / anti-amplification secret. Random per
			// process when not provided; pin it via options for clean
			// rolling restarts (lets in-flight 0-RTT keys survive).
			secret: options.secret || randomSecret(),
			cert: options.cert,
			privKey: options.privKey,
			// QUIC negotiates per-direction stream limits. Without an
			// explicit cap, the server-side limit for outgoing unidi
			// streams defaults to ~0, so `socket.http()` / `Server.http()`
			// would silently fail. Lift it well above realistic burst
			// sizes for fan-out broadcasts.
			initialBidirectionalStreams: 1000,
			initialUnidirectionalStreams: 1000,
		})
		this.io = server

		// Two reasons to set a request callback even though we accept
		// every session:
		//   1. The native dispatcher matches the registered path EXACTLY
		//      (including query string), so `/angelia?foo=bar` would be
		//      rejected. Returning `path: '/angelia'` remaps every request
		//      to our single registered controller.
		//   2. Without a request callback the binding leaves `session.header`
		//      empty, so we'd lose the `:path` pseudo-header (and with it
		//      every URL param the client sent).
		server.setRequestCallback(async () => ({
			status: 200,
			path: '/angelia',
		}))

		// IMPORTANT: register path BEFORE startServer so the session
		// dispatcher knows where to route. Matches the package's
		// reference echoserver pattern.
		const sessions = server.sessionStream('/angelia')
		const reader = sessions.getReader()
		this.sessionReader = reader

		server.startServer()
		await server.ready

		console.log('Socket Server Started Listening On Port', this.port)

		this.#acceptSessions(reader)

		this.events.listen?.()
	}

	/**
	 * Long-lived loop that pulls newly-arrived QUIC sessions off the
	 * dispatcher and hands each to `#onsession`. Errors are logged
	 * and the loop continues — one bad session shouldn't take the
	 * server down.
	 */
	async #acceptSessions(reader) {
		while (true) {
			try {
				const { value, done } = await reader.read()
				if (done) break
				this.#onsession(value)
			} catch (err) {
				this.#onerror(err)
			}
		}
	}

	/**
	 * Per-session loop that pulls each incoming unidi payload stream
	 * and feeds it to `socket.pump`. Exits when the session ends or
	 * the reader rejects (typical at session close).
	 */
	async #acceptPayloads(reader, socket) {
		while (true) {
			try {
				const { value, done } = await reader.read()
				if (done) break
				socket.pump(value)
			} catch {
				break
			}
		}
	}

	/**
	 * Register a listener class. Each method becomes an event handler.
	 * If the class declares a `static listeners` array of method names,
	 * only those are registered — useful for keeping helpers off the
	 * event surface. See the "Restricting which methods become
	 * listeners" section in the readme.
	 */
	on(listener) {
		const instance = new listener()

		// Single-level prototype lookup is intentional: methods on a
		// base class stay hidden from registration. See the readme's
		// "Restricting which methods become listeners" section.
		const methods = listener.listeners || [
			...Object.getOwnPropertyNames(Object.getPrototypeOf(instance)),
			...Object.getOwnPropertyNames(instance),
		]

		for (const m of methods) {
			// '' listener is reserved
			if (m !== 'constructor' && m !== '') {
				if (typeof instance[m] === 'function') {
					const method = instance[m].bind(instance)

					this.events[m] = this.events[m] || ListenerTemplate()
					this.events[m].fns.push(method)
				}
			}
		}

		return instance
	}

	// private

	#onsession = async session => {
		try {
			await session.ready
		} catch (err) {
			this.serverErrors++
			console.error('Server.onsession ready failed', err)
			return
		}

		// First incoming bidi stream is the "control" stream — carries
		// the message queue. Everything else is a per-call payload.
		const incoming = session.incomingBidirectionalStreams.getReader()
		const first = await incoming.read()
		if (first.done) {
			try {
				session.close()
			} catch {}
			return
		}

		const socket = new Socket(session, first.value, this)

		socket.listen()

		// Per-call payloads (client.http) arrive on send-only streams —
		// the client never reads from them. Bidi is reserved for the
		// control stream we already consumed above. Each payload is a
		// JSON-array batch with no trailing newline; `socket.pump`
		// handles both control and payload shapes via its end-of-stream
		// flush.
		this.#acceptPayloads(
			session.incomingUnidirectionalStreams.getReader(),
			socket,
		)

		this.served++

		this.sockets.push(socket)

		// Strip the internal `m` (URL-packed messages) off params before
		// the connect event fires.
		const { m, ...rest } = socket.params
		if (m !== undefined) socket.params = rest

		// Pass the upgrade request shape to the connect handler so apps
		// can read headers (cookies, auth, custom proxy headers) at
		// connect time without us having to keep it on the socket.
		const headers = session.header || {}
		const request = {
			headers,
			url: headers[':path'] || '',
		}

		this.events.connect?.(socket, request)

		if (m !== undefined) {
			try {
				const packed = parse(m)
				if (isArray(packed)) socket.dispatch(packed)
			} catch {}
		}

		// ping on connect is usually high
		setTimeout(() => this.#pingSocket(socket), 200)
	}

	#onerror = err => {
		this.serverErrors++
		console.error('Server.onerror', err)
	}

	// queue

	/** @internal Called from Socket.enqueue. */
	nextQueue(socket) {
		if (!this.queue.length) {
			nextTick(this.#processQueue)
		}
		this.queue.push(socket)
	}

	#processQueue = () => {
		const queue = this.queue
		this.queue = []
		for (const socket of queue) {
			socket.processQueue()
		}
		this.cache = empty()
	}

	/**
	 * Cache the encoded form of `messages` keyed by message identity.
	 * Returns a Uint8Array ready to write to a control stream
	 * (newline-delimited JSON). Byte counters are bumped in
	 * `Socket.write` so cache hits are counted accurately too.
	 *
	 * @internal Called from Socket.processQueue.
	 */
	cacheMessages(messages) {
		let id = ''
		for (const m of messages) {
			if (!m[this.cacheSymbol]) {
				m[this.cacheSymbol] = this.cached++
			}
			id += m[this.cacheSymbol] + ','
		}
		if (!this.cache[id]) {
			this.cache[id] = encode(stringify(messages) + '\n')
		} else {
			this.messagesSentCacheHit++
		}
		return this.cache[id]
	}

	// ping. Only `ping` is public so tests can drive the heartbeat
	// sweep manually; the rest is internal.

	#updateNow = () => {
		this.now = now()
	}

	ping = () => {
		this.#updateNow()
		for (const socket of this.sockets) {
			// Skip sockets we already kicked: QUIC graceful close can
			// take seconds, during which `socket.seen` stays frozen and
			// we'd re-fire `events.timeout` on every tick.
			if (socket.timedout) continue
			const delay = this.now - socket.seen

			if (delay > this.timeout) {
				socket.timedout = true
				this.events.timeout?.(socket, delay)
				try {
					socket.session.close()
				} catch {}
			} else if (delay > this.timeoutCheck) {
				this.#pingSocket(socket)
			}
		}
	}

	#pingSocket(socket) {
		this.#updateNow()
		socket.contacted = this.now
		socket.write(PING)
	}

	/** @internal Called from Socket.onframe on heartbeat receipt. */
	pong(socket) {
		this.#updateNow()
		socket.seen = this.now
		socket.ping = this.now - socket.contacted

		this.events.ping?.(socket)
	}

	/** Stop listening. Closes existing sessions and frees the port. */
	async stop() {
		clearInterval(this.pingTimer)
		clearInterval(this.nowTimer)
		try {
			this.sessionReader?.cancel()
		} catch {}
		try {
			this.io?.stopServer()
		} catch {}
		this.io = null
	}

	toJSON() {
		return '[content of server object omitted for toJSON]'
	}
})()
