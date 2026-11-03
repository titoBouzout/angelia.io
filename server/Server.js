import {
	empty,
	frame,
	inspect,
	isArray,
	createFanOut,
	now,
	params,
	stringify,
} from './utils.js'

import {
	DEFAULT_MAX_MESSAGE_SIZE_MB,
	DEFAULT_PORT,
	LIFECYCLE_EVENTS,
	MAX_PORT,
	encoded,
	framed,
} from './constants.js'
import {
	DEFAULT_PATH,
	PACKED_PARAM,
	TIMEOUT_MS,
} from '../shared/protocol.js'

import { Socket } from './Socket.js'
import { Emitter } from './Emitter.js'

import { nextTick } from 'node:process'
import { readFile } from 'node:fs/promises'
import { watch as fsWatch } from 'node:fs'
import { dirname, basename } from 'node:path'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'

import { WebSocketServer } from 'ws'

// Close code for a connection that ended without a close frame, which is
// what `terminate()` does.
const ABNORMAL_CLOSURE = 1006

// Let's Encrypt writes the cert and key in quick succession; coalescing
// avoids two reloads back-to-back.
const DEFAULT_WATCH_DEBOUNCE_MS = 1000

/** @import { EventValue, ServerEvents, ServerReplies } from './index.js' */

/**
 * @typedef {object} ServerListenOptions
 * @property {string} [hostname] Interface to bind to.
 * @property {number} [port] TCP port; `0` lets the OS pick one, readable
 *   from `port` after `listen()`.
 * @property {string} [path] WebSocket path clients connect to.
 * @property {number} [maxMessageSize] Max size of a single incoming
 *   message, in megabytes.
 * @property {boolean} [skipUTF8Validation] Skip `ws`'s UTF-8 validation
 *   of incoming text frames; `false` closes connections that send
 *   invalid UTF-8.
 * @property {string} [cert] Path to the PEM-encoded TLS certificate.
 *   With `privKey` the server speaks `wss://`, otherwise `ws://`.
 * @property {string} [privKey] Path to the PEM-encoded private key.
 * @property {boolean} [trustProxy] Read the client IP from
 *   `X-Forwarded-For`; only behind a trusted proxy, it's spoofable.
 * @property {boolean} [watch] Watch `cert` / `privKey` and call
 *   `reloadCerts()` when they change (Let's Encrypt renewals).
 * @property {number} [watchDebounceMs] Wait after a watcher event before
 *   reloading, so cert and key written together reload once.
 */

/**
 * Info about the upgrade request, passed to `connect`.
 *
 * @typedef {object} ConnectRequest
 * @property {import('node:http').IncomingHttpHeaders} headers
 * @property {string} url
 */

/**
 * Events the server fires itself.
 *
 * @typedef {object} PredefinedServerHandlers
 * @property {() => void} [listen]
 * @property {(socket: Socket, request: ConnectRequest) => void} [connect]
 * @property {(socket: Socket, code: number, reason: string) => void} [disconnect]
 * @property {(socket: Socket, delay: number) => void} [timeout]
 * @property {(socket: Socket, data: any) => void} [garbage]
 * @property {(socket: Socket, messages: any[]) => void} [incoming]
 * @property {(socket: Socket, messages: any[]) => void} [outgoing]
 */

/**
 * Handlers for the events clients send.
 *
 * @typedef {{
 * 	[K in keyof ServerEvents]?: (
 * 		socket: Socket,
 * 		data: ServerEvents[K],
 * 		reply?: (v: EventValue<ServerReplies, K>) => void,
 * 	) => void
 * }} UserHandlers
 */

/**
 * Shape a listener class instance must satisfy for `Server.on(Class)`.
 *
 * @typedef {UserHandlers & PredefinedServerHandlers} ServerListener
 */

/**
 * Add `handler` under `name`. A lone handler is stored as is, so a
 * dispatch calls it directly; a second one switches to a fan-out. Also
 * merges with a handler assigned straight to `events` / `hooks`.
 *
 * @param {Record<string, any>} registry
 * @param {string} name
 * @param {Function} handler
 */
function register(registry, name, handler) {
	const existing = registry[name]
	if (!existing) {
		registry[name] = handler
	} else if (existing.fns) {
		existing.fns.push(handler)
	} else {
		const fanOut = createFanOut()
		fanOut.fns.push(existing, handler)
		registry[name] = fanOut
	}
}

/** @param {{ cert: string; privKey: string }} paths */
const readCerts = ({ cert, privKey }) =>
	Promise.all([readFile(cert, 'utf8'), readFile(privKey, 'utf8')])

/**
 * A WebSocket server. Most apps use the shared instance (the default
 * export); create more with `new Server()` to listen on several ports.
 */
export class Server extends Emitter {
	/** @type {ServerListenOptions | null} */
	#listenOptions = null
	/** @type {import('node:fs').FSWatcher[]} */
	#certWatchers = []
	/** @type {NodeJS.Timeout | null} */
	#certReloadTimer = null
	/** @type {NodeJS.Timeout | undefined} */
	#pingTimer
	/** @type {NodeJS.Timeout | undefined} */
	#nowTimer

	/** @type {Socket[]} Sockets with messages to send. */
	#queue = []
	/** @type {Socket[]} `#queue`'s other buffer. */
	#drained = []
	#cacheSymbol = Symbol('cache')
	#cached = 1
	/** @type {Map<unknown, Buffer[]>} This tick's frames, see `cacheMessages`. */
	#cache = new Map()
	/** @type {Set<Socket>} */
	#sockets = new Set()
	#hostname = '127.0.0.1'
	#port = DEFAULT_PORT
	#path = DEFAULT_PATH
	#maxMessageSize = DEFAULT_MAX_MESSAGE_SIZE_MB
	#trustProxy = false
	#since = 0
	#now = 0
	#served = 0
	#bytesReceived = 0
	#bytesSent = 0
	#messagesGarbage = 0
	#messagesReceived = 0
	#messagesSent = 0
	#messagesSentCacheHit = 0
	#serverErrors = 0
	#socketErrors = 0
	/** @type {Record<string, any>} */
	#events = empty()
	/** @type {PredefinedServerHandlers} */
	#hooks = empty()
	/** @type {WebSocketServer | null} */
	#io = null
	/** @type {import('node:http').Server | null} */
	#httpServer = null

	/** Every connected socket. */
	get sockets() {
		return this.#sockets
	}
	get hostname() {
		return this.#hostname
	}
	get port() {
		return this.#port
	}
	get path() {
		return this.#path
	}
	get maxMessageSize() {
		return this.#maxMessageSize
	}
	/** Whether the client IP is read from `x-forwarded-for`, only for a trusted proxy in front. */
	get trustProxy() {
		return this.#trustProxy
	}
	get since() {
		return this.#since
	}
	get now() {
		return this.#now
	}
	get served() {
		return this.#served
	}
	get bytesReceived() {
		return this.#bytesReceived
	}
	get bytesSent() {
		return this.#bytesSent
	}
	get messagesGarbage() {
		return this.#messagesGarbage
	}
	get messagesReceived() {
		return this.#messagesReceived
	}
	get messagesSent() {
		return this.#messagesSent
	}
	get messagesSentCacheHit() {
		return this.#messagesSentCacheHit
	}
	get serverErrors() {
		return this.#serverErrors
	}
	get socketErrors() {
		return this.#socketErrors
	}
	/**
	 * Handlers for messages clients send, by event name. Call one to
	 * dispatch it yourself: `Server.events.typing(socket, true)`.
	 */
	get events() {
		return this.#events
	}
	/** Handlers for the events the server fires itself (`connect`, …). */
	get hooks() {
		return this.#hooks
	}
	get io() {
		return this.#io
	}
	get httpServer() {
		return this.#httpServer
	}

	/** @internal Each socket's share of the totals. */
	countReceived(bytes) {
		this.#bytesReceived += bytes
	}
	/** @internal */
	countSent(bytes) {
		this.#bytesSent += bytes
	}
	/** @internal */
	countMessagesReceived(count) {
		this.#messagesReceived += count
	}
	/** @internal */
	countMessagesSent(count) {
		this.#messagesSent += count
	}
	/** @internal */
	countGarbage() {
		this.#messagesGarbage++
	}
	/** @internal */
	countSocketError() {
		this.#socketErrors++
	}

	/**
	 * Start listening for WebSocket connections. Serves `wss://` when
	 * `cert` and `privKey` are given, plain `ws://` otherwise.
	 *
	 * @param {ServerListenOptions} [options]
	 */
	async listen(options = {}) {
		// Double-listen would leak the old server and intervals.
		if (this.#io) {
			throw new Error(
				'Server.listen() already called: this server is already listening. Call stop() first, or create another Server for a second port.',
			)
		}

		if (!options.cert !== !options.privKey) {
			throw new Error(
				'listen() requires both `cert` and `privKey`, or neither: only one was given. Pass both to serve wss://, neither for ws://.',
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

		this.#hostname = options.hostname || this.#hostname

		// 0 lets the OS pick; the bound port is read back below.
		const port = +(options.port ?? this.#port)
		this.#port =
			Number.isInteger(port) && port >= 0 && port <= MAX_PORT
				? port
				: this.#port

		this.#path = options.path || this.#path

		const maxMessageSize = +(options.maxMessageSize ?? 0)
		this.#maxMessageSize =
			maxMessageSize > 0 ? maxMessageSize : DEFAULT_MAX_MESSAGE_SIZE_MB

		this.#trustProxy = !!options.trustProxy

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
			path: this.#path,
			perMessageDeflate: false,
			clientTracking: false,
			maxPayload: this.#maxMessageSize * 1024 * 1024,
			// Invalid UTF-8 only decodes to U+FFFD, and browsers never send
			// it, so validating every frame is wasted work by default.
			skipUTF8Validation: options.skipUTF8Validation ?? true,
		})
		io.on('connection', this.#onconnection)
		io.on('error', this.#onerror)

		try {
			await new Promise((resolve, reject) => {
				httpServer.once('error', reject)
				// A deeper accept queue than Node's default absorbs reconnect storms.
				const listening = { port: this.#port, host: this.#hostname, backlog: 1024 }
				httpServer.listen(listening, () => {
					httpServer.off('error', reject)
					resolve(undefined)
				})
			})
		} catch (err) {
			io.close()
			throw err
		}
		httpServer.on('error', this.#onerror)

		const address = httpServer.address()
		if (address && typeof address === 'object') this.#port = address.port

		this.#io = io
		this.#httpServer = httpServer
		this.#listenOptions = options

		this.#now = now()
		this.#since = this.#now

		// `unref` so a stopped server doesn't hold the process alive.
		this.#pingTimer = setInterval(this.sweep, TIMEOUT_MS / 2)
		this.#pingTimer.unref()

		this.#nowTimer = setInterval(this.#updateNow, 500)
		this.#nowTimer.unref()

		console.log(
			`[angelia.io] server listening on ${pems ? 'wss' : 'ws'}://${this.#hostname}:${this.#port}`,
		)

		if (pems && options.watch) {
			this.#startCertWatcher(
				/** @type {string} */ (options.cert),
				/** @type {string} */ (options.privKey),
				options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS,
			)
		}

		this.#hooks.listen?.()
	}

	/**
	 * Re-read cert/privKey from disk and swap them into the running
	 * server. Open connections are untouched; new handshakes use the
	 * new cert. If the files can't be read or don't parse, the current
	 * cert stays in place.
	 */
	async reloadCerts() {
		const options = this.#listenOptions
		const httpServer = this.#httpServer
		if (!options?.cert || !options.privKey || !httpServer) return

		let pems
		try {
			pems = await readCerts({
				cert: options.cert,
				privKey: options.privKey,
			})
		} catch (err) {
			console.error(
				'[angelia.io] cert reload skipped: the new cert/key files could not be read. The current cert stays in use.',
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
				'[angelia.io] cert reload skipped: invalid cert/key in the new files. The current cert stays in use.',
				/** @type {Error} */ (err).message,
			)
		}
	}

	/**
	 * @param {string} certPath
	 * @param {string} privKeyPath
	 * @param {number} debounceMs
	 */
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
			// e.g. the directory went away; without a listener this would crash.
			watcher.on('error', this.#onerror)
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
	 *
	 * @template {ServerListener} I
	 * @param {(new () => I) & { listeners?: string[] }} listener
	 * @returns {I}
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
					// Lifecycle names live apart, out of reach of client messages.
					const registry = LIFECYCLE_EVENTS.has(m)
						? this.#hooks
						: this.#events

					register(registry, m, method)
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
		// URL-packed messages come off the params before `connect` sees them.
		const [query, m] = params(request.url, PACKED_PARAM)
		const socket = new Socket(io, request, this, query)

		socket.listen()

		this.#served++

		this.#sockets.add(socket)

		this.#hooks.connect?.(socket, {
			headers: request.headers,
			url: request.url || '',
		})

		// A `connect` listener may have already disconnected the socket.
		if (m !== null && !socket.closed) {
			const bytes = Buffer.byteLength(m)
			this.#bytesReceived += bytes
			socket.countReceived(bytes)
			const packed = socket.parse(m)
			if (isArray(packed)) socket.dispatch(packed)
			else socket.garbage(m)
		}

	}

	#onerror = err => {
		this.#serverErrors++
		console.error(
			'[angelia.io] server error, counted in serverErrors. The server keeps running.',
			err,
		)
	}

	// queue

	/**
	 * @internal Called from Socket.emit.
	 * @param {Socket} socket
	 */
	nextQueue(socket) {
		if (!this.#queue.length) {
			nextTick(this.#processQueue)
		}
		this.#queue.push(socket)
	}

	#processQueue = () => {
		// Swap buffers instead of allocating: sockets emitting mid-drain
		// queue into the other one.
		const queue = this.#queue
		this.#queue = this.#drained
		for (const socket of queue) {
			socket.processQueue()
		}
		queue.length = 0
		this.#drained = queue
		this.#cache.clear()
	}

	/**
	 * The frame of `messages`. Each message stringifies once however many
	 * batches it lands in, and a batch frames once per tick. Byte counters
	 * are bumped in `Socket.write`.
	 *
	 * @internal Called from Socket.processQueue.
	 * @param {any[]} messages
	 * @returns {Buffer[]}
	 */
	cacheMessages(messages) {
		// A fan-out is usually one message: its frame lives on it, for as long as it does.
		if (messages.length === 1) {
			const m = messages[0]
			if (m[framed]) {
				this.#messagesSentCacheHit++
			} else {
				m[framed] = frame(`[${m[encoded] ??= stringify(m)}]`)
			}
			return m[framed]
		}
		let key = ''
		for (const m of messages) {
			if (!m[this.#cacheSymbol]) {
				m[this.#cacheSymbol] = this.#cached++
			}
			key += m[this.#cacheSymbol] + ','
		}
		let batch = this.#cache.get(key)
		if (batch) {
			this.#messagesSentCacheHit++
		} else {
			batch = frame(`[${messages.map(m => (m[encoded] ??= stringify(m))).join()}]`)
			this.#cache.set(key, batch)
		}
		return batch
	}

	#updateNow = () => {
		this.#now = now()
	}

	/** @internal Drops sockets gone silent; public so tests can run it. */
	sweep = () => {
		this.#updateNow()
		for (const socket of this.#sockets) {
			const delay = this.#now - socket.seen

			if (delay > TIMEOUT_MS) {
				socket.timedOut()
				this.#hooks.timeout?.(socket, delay)
				socket.io.terminate()
				// Clean up now, as `disconnect()` does, not on the close event.
				socket.onclose(ABNORMAL_CLOSURE, '')
			}
		}
	}

	/** `await using server = …` stops the server when the scope ends. */
	[Symbol.asyncDispose]() {
		return this.stop()
	}

	/** Stop listening. Drops existing connections and frees the port. */
	async stop() {
		const httpServer = this.#httpServer
		const io = this.#io

		this.#stopCertWatcher()
		clearInterval(this.#pingTimer)
		clearInterval(this.#nowTimer)
		this.#io = null
		this.#httpServer = null
		this.#listenOptions = null

		if (!httpServer || !io) return

		for (const socket of this.#sockets) {
			socket.io.terminate()
			socket.onclose(ABNORMAL_CLOSURE, '')
		}
		io.close()
		await new Promise((resolve, reject) => {
			httpServer.close(err => (err ? reject(err) : resolve(undefined)))
			httpServer.closeAllConnections()
		})

		console.log(
			`[angelia.io] server stopped (was on port ${this.#port})`,
		)
	}

	toJSON() {
		return '[content of server object omitted for toJSON]'
	}

	/**
	 * `console.log(Server)` shows its state and counters, not every socket.
	 *
	 * @param {number} _depth
	 * @param {import('node:util').InspectOptionsStylized} options
	 * @param {typeof import('node:util').inspect} inspectValue
	 */
	[inspect](_depth, options, inspectValue) {
		const scheme = this.#listenOptions?.cert ? 'wss' : 'ws'
		const summary = {
			listening: this.#io !== null,
			url: `${scheme}://${this.#hostname}:${this.#port}${this.#path}`,
			sockets: this.#sockets.size,
			served: this.#served,
			since: this.#since,
			bytesSent: this.#bytesSent,
			bytesReceived: this.#bytesReceived,
			messagesSent: this.#messagesSent,
			messagesReceived: this.#messagesReceived,
			messagesSentCacheHit: this.#messagesSentCacheHit,
			messagesGarbage: this.#messagesGarbage,
			serverErrors: this.#serverErrors,
			socketErrors: this.#socketErrors,
			events: Object.keys(this.#events),
			hooks: Object.keys(this.#hooks),
		}
		return `Server ${inspectValue(summary, options)}`
	}
}

/** The shared server instance. */
export default new Server()
