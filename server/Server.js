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
import { readFile } from 'node:fs/promises'
import { watch as fsWatch } from 'node:fs'
import { dirname, basename } from 'node:path'

const randomSecret = () => randomBytes(32).toString('hex')

// Ping/pong frame is a constant byte — encode once, reuse forever.
const PING = encode('\n')

// Default debounce for cert-reload after a watcher event. Let's
// Encrypt writes the cert and key in quick succession; coalescing
// avoids two restarts back-to-back.
const DEFAULT_WATCH_DEBOUNCE_MS = 1000

/** Creates a new Socket Server (singleton). */
export default new (class Server extends Emitter {
	/**
	 * QUIC retry-token secret. Resolved once on first `listen()`,
	 * pinned across cert reloads so in-flight session tickets stay
	 * valid. Cleared by `stop()` so a fresh listen picks a new one.
	 *
	 * @type {string | null}
	 */
	#secret = null
	/**
	 * Snapshot of the options passed to `listen()`, used by
	 * `reloadCerts()` to relisten with the same config.
	 *
	 * @type {import('./Server.js').ServerListenOptions | null}
	 */
	#listenOptions = null
	/** @type {import('node:fs').FSWatcher[]} */
	#certWatchers = []
	/** @type {NodeJS.Timeout | null} */
	#certReloadTimer = null
	#isReloading = false

	constructor() {
		super()

		this.sockets = []

		this.hostname = '127.0.0.1'
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

		if (!options.cert || !options.privKey) {
			throw new Error(
				'listen() requires `cert` and `privKey` file paths for WebTransport.',
			)
		}

		// Read PEMs from disk before mutating any state. If reading
		// fails the caller's existing setup is untouched.
		const [certPem, privKeyPem] = await Promise.all([
			readFile(options.cert, 'utf8'),
			readFile(options.privKey, 'utf8'),
		])

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

		// Pin the QUIC retry-token secret across cert reloads so
		// in-flight session tickets stay valid. Initial listen picks
		// the user-provided secret (or a random one); cleared on stop.
		if (!this.#secret) {
			this.#secret = options.secret || randomSecret()
		}

		// Lazy-loaded so that `import Server from 'angelia.io/server'`
		// without calling listen() doesn't require the native dep.
		const { Http3Server } =
			await import('@fails-components/webtransport')
		const server = new Http3Server({
			port: this.port,
			host: this.hostname,
			secret: this.#secret,
			cert: certPem,
			privKey: privKeyPem,
			// QUIC negotiates per-direction stream limits. Without an
			// explicit cap, the server-side limit for outgoing unidi
			// streams defaults to ~0, so `socket.http()` / `Server.http()`
			// would silently fail. Lift it well above realistic burst
			// sizes for fan-out broadcasts.
			initialBidirectionalStreams: 1000,
			initialUnidirectionalStreams: 1000,
		})
		this.io = server

		// The native dispatcher matches the registered path EXACTLY
		// (including query string), so `/angelia?foo=bar` would be
		// rejected. We strip the query, accept only `/angelia`, and
		// remap to the registered controller via `path`. Anything else
		// gets a 404 so a stranger pointing a WebTransport client at
		// some other URL on the same port doesn't land in our event
		// loop. Setting a request callback at all is also what makes
		// the binding populate `session.header` (otherwise the `:path`
		// pseudo-header — and every URL param — would be lost).
		server.setRequestCallback(async ({ header }) => {
			const path = (header[':path'] || '').split('?')[0]
			if (path !== '/angelia') {
				return { status: 404, path: '/angelia' }
			}
			return { status: 200, path: '/angelia' }
		})

		// IMPORTANT: register path BEFORE startServer so the session
		// dispatcher knows where to route. Matches the package's
		// reference echoserver pattern.
		const sessions = server.sessionStream('/angelia')
		const reader = sessions.getReader()
		this.sessionReader = reader

		server.startServer()
		await server.ready

		console.log(
			`[angelia.io] server listening on ${this.hostname}:${this.port}`,
		)

		this.#acceptSessions(reader)

		// Remember the original options so reloadCerts() can relisten
		// with the same config. Stored AFTER `await server.ready` so a
		// failed listen leaves prior state intact.
		this.#listenOptions = options

		// Opt-in cert auto-reload (Let's Encrypt renewal etc.). Watches
		// the parent directories of cert/privKey and debounces a
		// `reloadCerts()` call when either file changes.
		if (options.watch) {
			this.#startCertWatcher(
				options.cert,
				options.privKey,
				options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS,
			)
		}

		this.events.listen?.()
	}

	/**
	 * Re-read cert/privKey from disk and restart the underlying server.
	 * Existing sessions are torn down; clients reconnect via their
	 * auto-reconnect loop. Safe to call manually (e.g. on SIGHUP) or
	 * via the file watcher when `watch: true`.
	 *
	 * If the new files can't be read, the running server is left
	 * untouched.
	 */
	async reloadCerts() {
		if (this.#isReloading) return
		if (!this.io || !this.#listenOptions) return

		this.#isReloading = true
		try {
			const opts = this.#listenOptions

			// Pre-validate: skip the reload if the new files aren't
			// readable yet (atomic-rename windows etc.).
			try {
				await Promise.all([
					readFile(opts.cert, 'utf8'),
					readFile(opts.privKey, 'utf8'),
				])
			} catch (err) {
				console.error(
					'[angelia.io] cert reload skipped — failed to read new files:',
					/** @type {Error} */ (err).message,
				)
				return
			}

			console.log(
				'[angelia.io] reloading certs and restarting server...',
			)

			// Partial stop: tear down the live server but preserve
			// `#secret` and `#listenOptions` so listen() reuses them.
			this.#stopCertWatcher()
			clearInterval(this.pingTimer)
			clearInterval(this.nowTimer)
			try {
				this.sessionReader?.cancel()
			} catch {}
			try {
				this.io?.stopServer()
			} catch {}
			this.io = null

			try {
				await this.listen(opts)
				console.log('[angelia.io] cert reload complete')
			} catch (err) {
				console.error('[angelia.io] cert reload failed:', err)
			}
		} finally {
			this.#isReloading = false
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
			this.#certReloadTimer.unref?.()
		}

		const certDir = dirname(certPath)
		const certName = basename(certPath)
		const keyDir = dirname(privKeyPath)
		const keyName = basename(privKeyPath)

		// `fs.watch` on the parent directory (rather than the file
		// itself) is what catches Let's Encrypt's atomic-rename
		// renewal — the symlink target swaps in the parent dir, which
		// shows up as a `rename` event for the basename. `persistent:
		// false` keeps a watching process from being held alive solely
		// by the watcher.
		const watchOne = (dir, name) => {
			const w = fsWatch(dir, { persistent: false }, (_, filename) => {
				if (filename === name) trigger(filename)
			})
			this.#certWatchers.push(w)
		}

		if (certDir === keyDir) {
			// Same directory (typical Let's Encrypt layout) — one
			// watcher, two basenames.
			const w = fsWatch(
				certDir,
				{ persistent: false },
				(_, filename) => {
					if (filename === certName || filename === keyName) {
						trigger(filename)
					}
				},
			)
			this.#certWatchers.push(w)
		} else {
			watchOne(certDir, certName)
			watchOne(keyDir, keyName)
		}

		console.log(
			`[angelia.io] watching cert files: ${certPath}, ${privKeyPath}`,
		)
	}

	#stopCertWatcher() {
		for (const w of this.#certWatchers) {
			try {
				w.close()
			} catch {}
		}
		this.#certWatchers = []
		if (this.#certReloadTimer) {
			clearTimeout(this.#certReloadTimer)
			this.#certReloadTimer = null
		}
	}

	/**
	 * Long-lived loop that pulls newly-arrived QUIC sessions off the
	 * dispatcher and hands each to `#onsession`. Errors are logged and
	 * the loop continues — one bad session shouldn't take the server
	 * down.
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
	 * and feeds it to `socket.pump`. Exits when the session ends or the
	 * reader rejects (typical at session close).
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
		// Snapshot before the partial cleanup nulls things out — we
		// only want to log "stopped" once, and only if there was
		// actually something to stop (calling stop() on a never-started
		// server should stay quiet).
		const wasRunning = !!this.io
		const port = this.port

		this.#stopCertWatcher()
		clearInterval(this.pingTimer)
		clearInterval(this.nowTimer)
		try {
			this.sessionReader?.cancel()
		} catch {}
		try {
			this.io?.stopServer()
		} catch {}
		this.io = null
		// Forget the listen config and pinned secret; the next listen()
		// is a fresh start (different cert, different secret possible).
		this.#listenOptions = null
		this.#secret = null

		if (wasRunning) {
			console.log(`[angelia.io] server stopped (was on port ${port})`)
		}
	}

	toJSON() {
		return '[content of server object omitted for toJSON]'
	}
})()
