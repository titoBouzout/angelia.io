const error = console.error
const stringify = JSON.stringify
const parse = JSON.parse

/** @returns {v is Function} */
const isFunction = (/** @type {any} */ v) => typeof v === 'function'

// `encode` has no per-call state, safe to share. `decode` is created
// per-pump (in `#pump`) because `TextDecoder` keeps state across
// `{stream: true}` chunks — sharing across instances would corrupt
// multi-byte UTF-8 boundaries.
const encode = TextEncoder.prototype.encode.bind(new TextEncoder())

// Pong is the same byte every time — encode once, reuse forever.
const PONG = encode('\n')

// Shared no-op handler for fire-and-forget `writer.write()` — avoids
// allocating a new closure per write.
const noop = () => {}

// Pack queued messages into the `m=` query param when the resulting
// full URL fits this budget (URL-encoding included).
const URL_PACK_LIMIT = 4096

const newConnid = () =>
	crypto.getRandomValues(new BigUint64Array(1))[0].toString(36)

export default class Client {
	connected = false

	/**
	 * Pending RPC callbacks. Slot 0 is reserved for "no callback". Each
	 * non-null slot is `{ fire, cancel }` — `fire(args)` runs the
	 * user's callback and resolves their promise; `cancel(err)` rejects
	 * the promise (used on reconnect when outstanding replies become
	 * unanswerable).
	 *
	 * @type {({
	 * 	fire: (args: any[]) => void
	 * 	cancel: (err: Error) => void
	 * } | null)[]}
	 */
	#callbacks = [null]
	/** @type {Record<string, Function[]>} */
	#listeners = {}
	/**
	 * Pending outbound messages, split by transport:
	 *
	 * - `emit` — batched and flushed on the control stream
	 * - `http` — batched and flushed on one-fresh-stream
	 *
	 * @type {{ emit: any[]; http: any[] }}
	 */
	#messages = { emit: [], http: [] }
	/** @type {WebTransport | null} */
	#io = null
	/** @type {WritableStreamDefaultWriter<Uint8Array> | null} */
	#writer = null
	#connid = newConnid()
	#isReconnect = false
	#reconnect = true

	/** @param {import('./index.js').ClientOptions} options */
	constructor(options) {
		this.options = options

		// Empty-key '' frames are reply messages — route them to the
		// callback slot bookkeeping. Registered as a regular listener
		// so `#dispatch` stays a single uniform loop.
		this.#listeners[''] = [this.#oncallback]

		// Force-disconnect support: app can `socket.emit('disconnect')`.
		this.on('disconnect', this.disconnect)

		!options.noConnect && this.connect()
	}

	connect() {
		if (this.#io || !this.#reconnect) return

		const url = new URL(this.options.url)
		url.pathname = 'angelia'

		const { searchParams } = url
		const p = this.options.params
		const params = (isFunction(p) ? p() : p) || {}

		for (const [k, v] of Object.entries(params)) {
			searchParams.append(k, v)
		}
		searchParams.append('connid', this.#connid)

		if (this.#isReconnect) {
			this.#messages = { emit: [], http: [] }
			const error = new Error('reconnecting')
			for (let i = 1; i < this.#callbacks.length; i++) {
				this.#callbacks[i]?.cancel(error)
			}
			this.#callbacks = [null]
		} else if (this.#messages.emit.length) {
			searchParams.append('m', stringify(this.#messages.emit))
			if (url.toString().length <= URL_PACK_LIMIT) {
				this.#messages.emit = []
			} else {
				searchParams.delete('m')
			}
		}

		const io = new WebTransport(
			url,
			this.options.serverCertificateHashes
				? {
						serverCertificateHashes:
							this.options.serverCertificateHashes,
					}
				: undefined,
		)
		this.#io = io

		// Both `io.closed` and the setup chain can fire cleanup for the
		// same failure. Tag every handler with the `io` it belongs to
		// and skip stale ones — otherwise a stale firing could null a
		// `#io` that a fresh `connect()` already replaced.
		const onClose = () => this.#io === io && this.#handleClosed()
		io.closed.then(onClose, onClose)

		io.ready
			.then(() => io.createBidirectionalStream())
			.then(control => {
				this.#writer = control.writable.getWriter()
				this.#pump(control.readable)
				this.#pumpIncoming(io)

				this.connected = true
				if (this.#isReconnect) {
					this.#dispatch([['reconnect', undefined]])
				} else {
					this.#isReconnect = true
					this.#dispatch([['connect', undefined]])
				}

				this.#send()
			})
			.catch(onClose)
	}

	#handleClosed = () => {
		this.#io = null
		this.#writer = null
		if (this.connected) {
			this.connected = false
			this.#dispatch([['disconnect', undefined]])
		}
		if (this.#reconnect) {
			// 2–4s jittered backoff so a server bounce doesn't trigger
			// a thundering-herd reconnect from every client at once.
			// `unref?.()` keeps a leaked Client from pinning a Node
			// process alive via the timer; in browsers `setTimeout`
			// returns a number and the optional chain short-circuits.
			setTimeout(
				() => this.connect(),
				2000 + Math.random() * 2000,
			)?.unref?.()
		}
	}

	disconnect = (noReconnect, reason = 'client disconnect') => {
		if (noReconnect) this.#reconnect = false
		try {
			this.#io?.close({
				closeCode: 0,
				reason: noReconnect ? 'server disconnect' : reason,
			})
		} catch (r) {
			error('client.disconnect', r)
		}
	}

	emit(key, valueOrCallback, callback) {
		return this.#enqueue(
			this.#messages.emit,
			key,
			valueOrCallback,
			callback,
		)
	}

	http(key, valueOrCallback, callback) {
		return this.#enqueue(
			this.#messages.http,
			key,
			valueOrCallback,
			callback,
		)
	}

	on(key, value) {
		if (key == '') {
			error('`key` cannot be empty')
			return
		}
		this.#listeners[key] = this.#listeners[key] || []
		this.#listeners[key].push(value)
		return () => this.#off(key, value)
	}

	// PRIVATE API

	/**
	 * @param {any[]} queue
	 * @returns {Promise<any> | undefined}
	 */
	#enqueue(queue, key, valueOrCallback, callback) {
		if (key == '') {
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

		this.#microtask()
		queue.push(message)

		return promise
	}

	#microtask() {
		if (!this.#messages.emit.length && !this.#messages.http.length) {
			queueMicrotask(() => queueMicrotask(this.#send))
		}
	}

	#off(k, v) {
		const i = this.#listeners[k].indexOf(v)
		if (i !== -1) this.#listeners[k].splice(i, 1)
	}

	/** @returns {[number, Promise<any>]} */
	#callback(c) {
		const { promise, resolve, reject } = Promise.withResolvers()
		const i = this.#callbacks.length
		this.#callbacks[i] = {
			fire: args => resolve(c(...args)),
			cancel: reject,
		}
		return [i, promise]
	}
	#oncallback = d => {
		const slot = this.#callbacks[d[0]]
		if (slot) {
			slot.fire(d[1])
			this.#callbacks[d[0]] = null
		}
	}
	#dispatch(d) {
		for (const e of d) {
			if (this.#listeners[e[0]]) {
				let replied = false
				const reply = e[2]
					? (...args) => {
							if (replied) {
								return error(`reply() already called for "${e[0]}"`)
							}
							replied = true

							this.#microtask()
							this.#messages.emit.push(['', [e[2], args]])
						}
					: undefined
				for (const fn of this.#listeners[e[0]]) {
					fn(e[1], reply)
				}
			}
		}
	}

	#send = () => {
		if (this.#writer && this.#messages.emit.length) {
			const batch = this.#messages.emit
			this.#messages.emit = []

			this.#writer.write(encode(stringify(batch) + '\n')).catch(noop)
		}

		if (this.#writer && this.#messages.http.length) {
			const batch = this.#messages.http
			this.#messages.http = []

			// try/catch: browsers reject the returned promise when the
			// session is gone, but the Node polyfill
			// (@fails-components/webtransport) throws synchronously —
			// and `#send` runs in a microtask with no handler above it.
			try {
				this.#io
					?.createUnidirectionalStream()
					.then(async stream => {
						const w = stream.getWriter()
						await w.write(encode(stringify(batch)))
						return w.close()
					})
					.catch(e => error('client.#send http', e))
			} catch (e) {
				error('client.#send http', e)
			}
		}
	}

	#pong() {
		this.#writer?.write(PONG).catch(noop)
	}

	/**
	 * Pump a readable: dispatch each `\n`-terminated batch as it
	 * arrives, plus any unterminated leftover when the stream ends.
	 *
	 * - Control stream: long-lived, frames separated by `\n` mid-stream.
	 *   The "leftover at end" branch only runs at session close and is
	 *   typically empty.
	 * - Server-pushed unidi payload streams: short-lived, exactly one
	 *   un-terminated batch per stream — the close acts as the frame
	 *   boundary, so the leftover branch is the one that fires.
	 */
	async #pump(readable) {
		const decoder = new TextDecoder()
		const reader = readable.getReader()
		let buf = ''
		try {
			while (true) {
				const { value, done } = await reader.read()
				if (done) {
					if (buf) this.#onframe(buf)
					break
				}
				buf += decoder.decode(value, { stream: true })
				let nl
				while ((nl = buf.indexOf('\n')) !== -1) {
					const line = buf.slice(0, nl)
					buf = buf.slice(nl + 1)

					this.#onframe(line)
				}
			}
		} catch (e) {
			error('client.#pump', e)
		}
	}

	/** Forward server-pushed unidi streams through `#pump`. */
	async #pumpIncoming(io) {
		const reader = io.incomingUnidirectionalStreams.getReader()
		try {
			while (true) {
				const { value: stream, done } = await reader.read()
				if (done) break
				this.#pump(stream)
			}
		} catch (e) {
			error('client.#pumpIncoming', e)
		}
	}

	#onframe(line) {
		if (line === '') {
			this.#pong()
		} else {
			this.#dispatch(parse(line))
		}
	}
}
