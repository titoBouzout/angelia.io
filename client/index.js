import { workerTransport } from './transport.js'
import {
	DEFAULT_PATH,
	NO_RECONNECT,
	PACKED_PARAM,
	PROTOCOL_KEY,
	assertCloseReason,
} from '../shared/protocol.js'

const error = console.error
const stringify = JSON.stringify
const parse = JSON.parse
const isArray = Array.isArray

/** @returns {v is Function} */
const isFunction = (/** @type {any} */ v) => typeof v === 'function'

// Pack queued messages into the connect URL while the handshake's
// request line stays within nginx's default `large_client_header_buffers`
// (8k): a longer line gets a 414.
const REQUEST_LINE_LIMIT = 8192

/** Length of `text` once form-encoded into a query param value. */
const encodedLength = text =>
	new URLSearchParams({ [PACKED_PARAM]: text }).toString().length -
	PACKED_PARAM.length -
	1

// Close code browsers send when the page navigates away. Firefox fires
// it on reload too; reconnecting then would open a second connection.
const GOING_AWAY = 1001

// Retries wait RETRY_MIN_MS plus up to RETRY_JITTER_MS, so a server
// bounce doesn't get every client back at the same instant.
const RETRY_MIN_MS = 2000
const RETRY_JITTER_MS = 2000

/** `request()`'s callback: resolve with the reply as it is. */
const settle = reply => reply

const noop = () => {}

const newConnid = () =>
	crypto.getRandomValues(new BigUint64Array(1))[0].toString(36)

/** @import { ClientEvents, ClientReplies, EventKey, EventValue, ServerEvents, ServerReplies } from '../server/index.js' */

/**
 * @typedef {object} ClientOptions
 * @property {string} url Server URL, `ws://` or `wss://`. Without a path
 *   the client connects to the default one; give it to match the
 *   server's `path` option.
 * @property {Record<string, any> | (() => Record<string, any>)} [params]
 *   Query params sent on connect; a function is called on every connect.
 * @property {boolean} [noConnect] Don't connect until `connect()`.
 */

/**
 * Events the client fires itself, with no payload.
 *
 * @typedef {'connect' | 'reconnect' | 'disconnect'} ClientPredefinedEvent
 */

/** @typedef {{ signal?: AbortSignal }} ListenOptions */

/**
 * A connection to an angelia.io server, run from a Web Worker. Connects
 * on construction and reconnects on its own.
 */
export default class Client {
	#connected = false

	/**
	 * Replies the server still owes, by callback id. `fire(args)` runs
	 * the user's callback and resolves their promise; `cancel(err)`
	 * rejects it (on reconnect, when the reply can no longer arrive).
	 *
	 * @type {Map<
	 * 	number,
	 * 	{ fire: (args: any[]) => void; cancel: (err: Error) => void }
	 * >}
	 */
	#callbacks = new Map()
	/** Last callback id handed out; ids start at 1, as 0 means "none". */
	#lastCallbackId = 0
	// No prototype, so only registered keys are found ('constructor',
	// '__proto__', … are ordinary event names).
	/** @type {Record<string, Function[]>} */
	#listeners = Object.create(null)
	/** @type {any[]} */
	#messages = []
	/** @type {import('./transport.js').Connection | null} */
	#io = null
	/** @type {import('./transport.js').Transport} */
	#transport
	#connid = newConnid()
	#isReconnect = false
	#reconnect = true
	#packFailed = false

	/** @param {ClientOptions} options */
	constructor(options) {
		const { protocol } = new URL(options.url)
		if (protocol !== 'ws:' && protocol !== 'wss:') {
			throw new TypeError(
				`Client url must be ws:// or wss://, got ${protocol}//`,
			)
		}

		if (typeof Worker === 'undefined') {
			throw new TypeError(
				'angelia.io/client runs its socket in a Web Worker; this environment has none',
			)
		}

		this.options = options
		this.#transport = workerTransport()

		// Protocol messages (replies, commands) go through the same
		// dispatch loop as events, under the reserved key.
		this.#listeners[PROTOCOL_KEY] = [this.#onprotocol]

		// Deferred so emits made right after construction are packed
		// into the connect URL.
		if (!options.noConnect) queueMicrotask(() => this.connect())
	}

	/** Open the socket; no-op while open or after `disconnect(true)`. */
	connect() {
		if (this.#io || !this.#reconnect) return

		const url = new URL(this.options.url)
		if (url.pathname === '/') url.pathname = DEFAULT_PATH

		const { searchParams } = url
		const p = this.options.params
		const params = (isFunction(p) ? p() : p) || {}

		for (const [k, v] of Object.entries(params)) {
			searchParams.append(k, v)
		}
		searchParams.append('connid', this.#connid)

		/** @type {any[]} */
		let packed = []
		if (this.#isReconnect) {
			this.#messages = []
			const error = new Error('reconnecting')
			for (const pending of this.#callbacks.values()) {
				pending.cancel(error)
			}
			this.#callbacks.clear()
		} else {
			packed = this.#pack(url)
		}

		/** @type {number | null} When this connection opened. */
		let openedAt = null
		// Every handler checks it still belongs to the live connection,
		// so a late event can't clobber a newer one.
		const io = this.#transport.open(url, {
			onopen: () => {
				if (this.#io !== io) return
				openedAt = Date.now()
				this.#connected = true
				if (this.#isReconnect) {
					this.#dispatch([['reconnect', undefined]])
				} else {
					this.#isReconnect = true
					this.#dispatch([['connect', undefined]])
				}
				this.#send()
			},
			onmessage: text => {
				if (this.#io === io) this.#dispatch(parse(text))
			},
			onclose: code => {
				if (this.#io !== io) return
				// The URL never reached a server that accepted it: put the
				// packed messages back in front, and stop packing, since the
				// URL itself may be what got rejected.
				if (openedAt === null && packed.length) {
					this.#messages = [...packed, ...this.#messages]
					this.#packFailed = true
				}
				this.#handleClosed(
					code,
					openedAt === null ? 0 : Date.now() - openedAt,
				)
			},
			onerror: err => error('client', err),
		})
		this.#io = io
	}

	/**
	 * @param {number} code Close code
	 * @param {number} uptime How long the connection was open, in ms
	 */
	#handleClosed = (code, uptime) => {
		this.#io = null
		if (this.#connected) {
			this.#connected = false
			this.#dispatch([['disconnect', undefined]])
		}
		if (!this.#reconnect) {
			this.#transport.terminate()
		} else if (code === GOING_AWAY) {
			return
		} else if (uptime >= RETRY_MIN_MS) {
			// A working connection dropped: get back right away.
			this.connect()
		} else {
			// A failed attempt, or a connection dropped as soon as it
			// opened (which would otherwise loop as fast as it can).
			// `unref?.()` keeps a leaked Client from pinning a Node
			// process alive; browsers return a number and skip it.
			setTimeout(
				() => this.connect(),
				RETRY_MIN_MS + Math.random() * RETRY_JITTER_MS,
			)?.unref?.()
		}
	}

	/** Whether the socket is open. */
	get connected() {
		return this.#connected
	}

	/** `using client = new Client(…)` disconnects for good at scope end. */
	[Symbol.dispose]() {
		this.disconnect(true)
	}

	/**
	 * Close the socket.
	 *
	 * @param {boolean} [noReconnect] `true` stops the auto-reconnect.
	 * @param {string} [reason] Close reason sent to the server, up to 123
	 *   bytes; longer throws a `RangeError` before anything closes.
	 */
	disconnect = (noReconnect, reason = 'client disconnect') => {
		assertCloseReason(reason)
		if (noReconnect) this.#reconnect = false
		this.#io?.close(1000, reason)
	}

	/**
	 * Emit to the server. With a callback, returns a promise for the
	 * callback's result, rejected with `Error('reconnecting')` if the
	 * connection is replaced before the reply arrives.
	 *
	 * @template {EventKey<ServerEvents>} K
	 * @overload
	 * @param {K} key
	 * @returns {undefined}
	 */
	/**
	 * @template {EventKey<ServerEvents>} K
	 * @overload
	 * @param {K} key
	 * @param {EventValue<ServerEvents, K>} value
	 * @returns {undefined}
	 */
	/**
	 * @template {EventKey<ServerEvents>} K
	 * @template R
	 * @overload
	 * @param {K} key
	 * @param {(reply: EventValue<ServerReplies, K>) => R} callback
	 * @returns {Promise<R>}
	 */
	/**
	 * @template {EventKey<ServerEvents>} K
	 * @template R
	 * @overload
	 * @param {K} key
	 * @param {EventValue<ServerEvents, K>} value
	 * @param {(reply: EventValue<ServerReplies, K>) => R} callback
	 * @returns {Promise<R>}
	 */
	/**
	 * @param {any} key
	 * @param {any} [valueOrCallback]
	 * @param {Function} [callback]
	 * @returns {Promise<any> | undefined}
	 */
	emit(key, valueOrCallback, callback) {
		if (key === PROTOCOL_KEY) {
			error('`key` cannot be empty')
			return
		}

		let message
		let promise
		if (callback) {
			const [i, p] = this.#callback(callback)
			message = [key, valueOrCallback, i]
			promise = p
		} else if (isFunction(valueOrCallback)) {
			const [i, p] = this.#callback(valueOrCallback)
			message = [key, 0, i]
			promise = p
		} else if (valueOrCallback !== undefined) {
			message = [key, valueOrCallback]
		} else {
			message = [key]
		}

		this.#queue(message)

		return promise
	}

	/**
	 * Emit and resolve with the server's reply.
	 *
	 * @template {EventKey<ServerEvents>} K
	 * @overload
	 * @param {K} key
	 * @returns {Promise<EventValue<ServerReplies, K>>}
	 */
	/**
	 * @template {EventKey<ServerEvents>} K
	 * @overload
	 * @param {K} key
	 * @param {EventValue<ServerEvents, K>} value
	 * @returns {Promise<EventValue<ServerReplies, K>>}
	 */
	/**
	 * @param {any} key
	 * @param {any} [value]
	 * @returns {Promise<any>}
	 */
	request(key, value) {
		return this.emit(key, value, settle)
	}

	/**
	 * Listen for a predefined event. Returns a function that stops
	 * listening; aborting `options.signal` does the same.
	 *
	 * @overload
	 * @param {ClientPredefinedEvent} key
	 * @param {() => void} value
	 * @param {ListenOptions} [options]
	 * @returns {(() => void) | undefined}
	 */
	/**
	 * Listen for a server event. Returns a function that stops
	 * listening; aborting `options.signal` does the same.
	 *
	 * @template {EventKey<ClientEvents>} K
	 * @overload
	 * @param {K} key
	 * @param {(
	 * 	v: EventValue<ClientEvents, K>,
	 * 	reply?: (v: EventValue<ClientReplies, K>) => void,
	 * ) => void} value
	 * @param {ListenOptions} [options]
	 * @returns {(() => void) | undefined}
	 */
	/**
	 * @param {string} key
	 * @param {Function} value
	 * @param {ListenOptions} [options]
	 * @returns {(() => void) | undefined}
	 */
	on(key, value, options) {
		if (key === PROTOCOL_KEY) {
			error('`key` cannot be empty')
			return
		}
		const signal = options?.signal
		if (signal?.aborted) return noop
		;(this.#listeners[key] ||= []).push(value)
		const off = () => {
			this.#off(key, value)
			signal?.removeEventListener('abort', off)
		}
		signal?.addEventListener('abort', off, { once: true })
		return off
	}

	// PRIVATE API

	/**
	 * Move the longest prefix of the queue that fits the request-line
	 * budget into the connect URL, so it dispatches on connect; the rest
	 * is sent once the socket opens. Stops at the first message that
	 * doesn't fit, to keep order. Off after a failed attempt that carried
	 * packed messages. Returns the packed messages.
	 *
	 * @param {URL} url
	 */
	#pack(url) {
		if (this.#packFailed) return []
		const messages = this.#messages
		// Form-encoding works per character and yields ASCII, so encoded
		// lengths add up and equal bytes. `search` always holds `connid`.
		let length =
			'GET '.length +
			url.pathname.length +
			url.search.length +
			' HTTP/1.1\r\n'.length +
			`&${PACKED_PARAM}=`.length +
			encodedLength('[]')
		const separator = encodedLength(',')
		/** @type {string[]} */
		const parts = []
		for (const message of messages) {
			const part = stringify(message)
			const added =
				encodedLength(part) + (parts.length ? separator : 0)
			if (length + added > REQUEST_LINE_LIMIT) break
			length += added
			parts.push(part)
		}
		if (!parts.length) return []

		url.searchParams.append(PACKED_PARAM, '[' + parts.join(',') + ']')
		this.#messages = messages.slice(parts.length)
		return messages.slice(0, parts.length)
	}

	/** Push a message, scheduling a flush when the queue was empty. */
	#queue(message) {
		if (!this.#messages.length) queueMicrotask(this.#flushSoon)
		this.#messages.push(message)
	}

	// Two microtasks deep, so emits made by code reacting to this one
	// (e.g. in a `.then`) join the same batch. Built once, not per flush.
	#flushSoon = () => queueMicrotask(this.#send)

	#off(k, v) {
		const i = this.#listeners[k].indexOf(v)
		if (i !== -1) this.#listeners[k].splice(i, 1)
	}

	/** @returns {[number, Promise<any>]} */
	#callback(c) {
		const { promise, resolve, reject } = Promise.withResolvers()
		const id = ++this.#lastCallbackId
		this.#callbacks.set(id, {
			fire: args => resolve(c(...args)),
			cancel: reject,
		})
		return [id, promise]
	}

	/** A reply `[id, args]` or a command from the server. */
	#onprotocol = d => {
		if (d === NO_RECONNECT) {
			this.disconnect(true)
			return
		}
		const pending = isArray(d) && this.#callbacks.get(d[0])
		if (pending) {
			this.#callbacks.delete(d[0])
			pending.fire(d[1])
		}
	}

	#dispatch(d) {
		for (const e of d) {
			const listeners = this.#listeners[e[0]]
			if (!listeners) continue
			let replied = false
			const reply = e[2]
				? (...args) => {
						if (replied) {
							return error(`reply() already called for "${e[0]}"`)
						}
						replied = true

						this.#queue([PROTOCOL_KEY, [e[2], args]])
					}
				: undefined
			for (const fn of listeners) {
				try {
					fn(e[1], reply)
				} catch (err) {
					// Rethrown on its own so it still surfaces as uncaught,
					// without skipping the rest of the batch.
					queueMicrotask(() => {
						throw err
					})
				}
			}
		}
	}

	#send = () => {
		const io = this.#io
		if (io && this.#connected && this.#messages.length) {
			const text = stringify(this.#messages)
			// Reuse the queue array: it's serialized, nothing else holds it.
			this.#messages.length = 0
			io.send(text)
		}
	}
}
