import {
	empty,
	frame,
	isArray,
	ListenerTemplate,
	now,
	stringify,
} from './utils.js'

import {
	DEFAULT_MAX_MESSAGE_SIZE_MB,
	DEFAULT_PORT,
	DEFAULT_TIMEOUT_MS,
	MAX_PORT,
	MIN_TIMEOUT_MS,
} from './constants.js'

import { Socket } from './Socket.js'
import { Emitter } from './Emitter.js'

import { nextTick } from 'node:process'
import { readFile } from 'node:fs/promises'
import { watch as fsWatch } from 'node:fs'
import { dirname, basename } from 'node:path'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'

import { WebSocketServer } from 'ws'

// The heartbeat is a constant empty message — frame once, reuse forever.
const PING = frame('')

// Let's Encrypt writes the cert and key in quick succession; coalescing
// avoids two reloads back-to-back.
const DEFAULT_WATCH_DEBOUNCE_MS = 1000

/** @param {{ cert: string; privKey: string }} paths */
const readCerts = ({ cert, privKey }) =>
	Promise.all([readFile(cert, 'utf8'), readFile(privKey, 'utf8')])

/** Creates a new Socket Server (singleton). */
export default new (class Server extends Emitter {
	/** @type {import('./Server.js').ServerListenOptions | null} */
	#listenOptions = null
	/** @type {import('node:fs').FSWatcher[]} */
	#certWatchers = []
	/** @type {NodeJS.Timeout | null} */
	#certReloadTimer = null

	constructor() {
		super()

		this.sockets = []

		this.hostname = '127.0.0.1'
		this.port = DEFAULT_PORT

		this.timeout = DEFAULT_TIMEOUT_MS
		this.timeoutCheck = DEFAULT_TIMEOUT_MS / 2

		this.maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE_MB

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
		this.socketErrors = 0

		this.queue = []

		this.cacheSymbol = Symbol('cache')
		this.cached = 1
		this.cache = empty()

		this.events = empty()

		/** @type {WebSocketServer | null} */
		this.io = null
		/** @type {import('node:http').Server | null} */
		this.httpServer = null
	}

	/**
	 * Start listening for WebSocket connections. Serves `wss://` when
	 * `cert` and `privKey` are given, plain `ws://` otherwise.
	 *
	 * @param {import('./Server.js').ServerListenOptions} [options]
	 */
	async listen(options = {}) {
		// Double-listen would leak the old server and intervals.
		if (this.io) {
			throw new Error(
				'Server.listen() already called; call stop() first.',
			)
		}

		if (!options.cert !== !options.privKey) {
			throw new Error(
				'listen() requires both `cert` and `privKey`, or neither.',
			)
		}

		// Read PEMs before mutating any state, so a failed read leaves
		// the server untouched.
		const pems =
			options.cert && options.privKey
				? await readCerts({
						cert: options.cert,
						privKey: options.privKey,
					})
				: null

		this.hostname = options.hostname || this.hostname

		const port = +(options.port ?? 0)
		this.port = port > 0 && port <= MAX_PORT ? port : this.port

		const timeout = +(options.timeout ?? 0)
		this.timeout =
			timeout >= MIN_TIMEOUT_MS ? timeout : DEFAULT_TIMEOUT_MS

		const maxMessageSize = +(options.maxMessageSize ?? 0)
		this.maxMessageSize =
			maxMessageSize > 0 ? maxMessageSize : DEFAULT_MAX_MESSAGE_SIZE_MB

		this.trustProxy = !!options.trustProxy

		// No plain-HTTP endpoints: everything but the upgrade is a 404.
		/** @type {import('node:http').RequestListener} */
		const notFound = (_request, response) => {
			response.writeHead(404).end()
		}
		const httpServer = pems
			? createHttpsServer({ cert: pems[0], key: pems[1] }, notFound)
			: createHttpServer(notFound)

		const io = new WebSocketServer({
			server: httpServer,
			path: '/angelia',
			perMessageDeflate: false,
			clientTracking: false,
			maxPayload: this.maxMessageSize * 1024 * 1024,
			backlog: 1024,
			// Invalid UTF-8 only decodes to U+FFFD, and browsers never send
			// it, so validating every frame is wasted work by default.
			skipUTF8Validation: options.skipUTF8Validation ?? true,
		})
		io.on('connection', this.#onconnection)
		io.on('error', this.#onerror)

		try {
			await new Promise((resolve, reject) => {
				httpServer.once('error', reject)
				httpServer.listen(this.port, this.hostname, () => {
					httpServer.off('error', reject)
					resolve(undefined)
				})
			})
		} catch (err) {
			io.close()
			throw err
		}
		httpServer.on('error', this.#onerror)

		this.io = io
		this.httpServer = httpServer
		this.#listenOptions = options

		this.now = now()
		this.since = this.now

		// `unref` so a stopped server doesn't hold the process alive.
		// `timeoutCheck` is shortened so a socket seen just after a sweep
		// still gets pinged before the following sweep times it out.
		this.timeoutCheck = this.timeout / 2
		this.pingTimer = setInterval(this.ping, this.timeoutCheck)
		this.pingTimer.unref()
		this.timeoutCheck -= 5000

		this.nowTimer = setInterval(this.#updateNow, 500)
		this.nowTimer.unref()

		console.log(
			`[angelia.io] server listening on ${pems ? 'wss' : 'ws'}://${this.hostname}:${this.port}`,
		)

		if (pems && options.watch) {
			this.#startCertWatcher(
				/** @type {string} */ (options.cert),
				/** @type {string} */ (options.privKey),
				options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS,
			)
		}

		this.events.listen?.()
	}

	/**
	 * Re-read cert/privKey from disk and swap them into the running
	 * server. Open connections are untouched; new handshakes use the
	 * new cert. If the files can't be read or don't parse, the current
	 * cert stays in place.
	 */
	async reloadCerts() {
		const options = this.#listenOptions
		const httpServer = this.httpServer
		if (!options?.cert || !options.privKey || !httpServer) return

		let pems
		try {
			pems = await readCerts({
				cert: options.cert,
				privKey: options.privKey,
			})
		} catch (err) {
			console.error(
				'[angelia.io] cert reload skipped — failed to read new files:',
				/** @type {Error} */ (err).message,
			)
			return
		}

		try {
			/** @type {import('node:https').Server} */ (
				httpServer
			).setSecureContext({ cert: pems[0], key: pems[1] })
			console.log('[angelia.io] cert reload complete')
		} catch (err) {
			console.error(
				'[angelia.io] cert reload skipped — invalid cert/key:',
				/** @type {Error} */ (err).message,
			)
		}
	}

	#startCertWatcher(certPath, privKeyPath, debounceMs) {
		this.#stopCertWatcher()

		const trigger = filename => {
			console.log(
				`[angelia.io] cert file changed: ${filename} (reload in ${debounceMs}ms)`,
			)
			if (this.#certReloadTimer) clearTimeout(this.#certReloadTimer)
			this.#certReloadTimer = setTimeout(
				() => this.reloadCerts(),
				debounceMs,
			)
			this.#certReloadTimer.unref()
		}

		// Watching the parent directory (not the file) catches Let's
		// Encrypt's atomic-rename renewal, which swaps the symlink target.
		/** @type {Map<string, Set<string>>} */
		const names = new Map()
		for (const path of [certPath, privKeyPath]) {
			const dir = dirname(path)
			if (!names.has(dir)) names.set(dir, new Set())
			names.get(dir)?.add(basename(path))
		}
		for (const [dir, files] of names) {
			const watcher = fsWatch(
				dir,
				{ persistent: false },
				(_, filename) => {
					if (filename && files.has(filename)) trigger(filename)
				},
			)
			this.#certWatchers.push(watcher)
		}

		console.log(
			`[angelia.io] watching cert files: ${certPath}, ${privKeyPath}`,
		)
	}

	#stopCertWatcher() {
		for (const watcher of this.#certWatchers) {
			watcher.close()
		}
		this.#certWatchers = []
		if (this.#certReloadTimer) {
			clearTimeout(this.#certReloadTimer)
			this.#certReloadTimer = null
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
		// base class stay hidden from registration.
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

	/**
	 * @param {import('ws').WebSocket} io
	 * @param {import('node:http').IncomingMessage} request
	 */
	#onconnection = (io, request) => {
		const socket = new Socket(io, request, this)

		socket.listen()

		this.served++

		this.sockets.push(socket)

		// Strip the internal `m` (URL-packed messages) off params before
		// the connect event fires.
		const { m, ...rest } = socket.params
		if (m !== undefined) socket.params = rest

		this.events.connect?.(socket, {
			headers: request.headers,
			url: request.url || '',
		})

		// A `connect` listener may have already disconnected the socket.
		if (m !== undefined && !socket.closed) {
			const bytes = Buffer.byteLength(m)
			this.bytesReceived += bytes
			socket.bytesReceived += bytes
			const packed = socket.parse(m)
			if (packed && isArray(packed)) {
				socket.dispatch(packed)
			} else {
				this.messagesGarbage++
				this.events.garbage?.(socket, m)
			}
		}

		// ping on connect is usually high
		setTimeout(() => this.#pingSocket(socket), 200).unref()
	}

	#onerror = err => {
		this.serverErrors++
		console.error('[angelia.io] server error', err)
	}

	// queue

	/** @internal Called from Socket.emit. */
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
	 * Cache the framed form of `messages` keyed by message identity, so a
	 * fan-out stringifies and frames once per tick. Byte counters are
	 * bumped in `Socket.write`.
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
			this.cache[id] = frame(stringify(messages))
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
		// Snapshot: `terminate()` can remove sockets mid-loop.
		for (const socket of this.sockets.slice()) {
			const delay = this.now - socket.seen

			if (delay > this.timeout) {
				socket.timedout = true
				this.events.timeout?.(socket, delay)
				socket.io.terminate()
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

	/** @internal Called from Socket.onmessage on heartbeat receipt. */
	pong(socket) {
		this.#updateNow()
		socket.seen = this.now
		socket.ping = this.now - socket.contacted

		this.events.ping?.(socket)
	}

	/** Stop listening. Drops existing connections and frees the port. */
	async stop() {
		const httpServer = this.httpServer
		const io = this.io

		this.#stopCertWatcher()
		clearInterval(this.pingTimer)
		clearInterval(this.nowTimer)
		this.io = null
		this.httpServer = null
		this.#listenOptions = null

		if (!httpServer || !io) return

		for (const socket of this.sockets.slice()) {
			socket.io.terminate()
		}
		io.close()
		await new Promise((resolve, reject) => {
			httpServer.close(err => (err ? reject(err) : resolve(undefined)))
			httpServer.closeAllConnections()
		})

		console.log(
			`[angelia.io] server stopped (was on port ${this.port})`,
		)
	}

	toJSON() {
		return '[content of server object omitted for toJSON]'
	}
})()
