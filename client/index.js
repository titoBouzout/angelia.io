import { ClientWebWorker } from './worker.js'

const isFunction = v => typeof v === 'function'

const error = console.error

export default class Client {
	#callbacks
	#listeners
	#messages
	#postMessage

	/**
	 * Creates a Socket Client Instance
	 *
	 * @param options {string | {url:string, params?:Function,
	 *   noConnect?:boolean }}
	 */
	constructor(options) {
		if (typeof options === 'string') {
			options = {
				url: options,
			}
		}

		this.options = options

		this.#callbacks = [null]
		this.#listeners = {
			'': [this.#oncallback],
		}
		this.#messages = []

		this.connected = false

		// to force disconnect
		this.on('disconnect', this.disconnect)

		const workerURL = URL.createObjectURL(
			new Blob(['(' + ClientWebWorker + ')()']),
		)
		const io = new Worker(workerURL)
		URL.revokeObjectURL(workerURL)

		io.onmessage = this.#onworkermessage
		this.#postMessage = io.postMessage.bind(io)

		options.noConnect === undefined && this.connect()
	}

	/** Connect to server */
	connect() {
		this.#postMessage([
			'connect',
			{
				url: this.options.url,
				params:
					(isFunction(this.options.params)
						? this.options.params()
						: this.options.params) || {},
			},
		])
	}

	/**
	 * Disconnect from server
	 *
	 * @param {boolean} noReconnect - To prevent reconnections
	 */
	disconnect = noReconnect => {
		this.#postMessage(['disconnect', noReconnect])
	}

	/**
	 * Listen for data sent by the server
	 *
	 * @param {string} key
	 * @param {any | Function} [valueOrCallback]
	 * @param {Function} [callback]
	 * @returns {Promise<any> | undefined} When callback is provided it
	 *   returns a promise
	 */
	emit(key, valueOrCallback, callback) {
		// empty `key` is reserved
		if (key == '') {
			error('`key` cannot be empty')
		} else {
			if (!this.#messages.length) {
				queueMicrotask(() => queueMicrotask(this.#send))
			}
			if (callback) {
				const [i, promise] = this.#callback(callback)
				this.#messages.push([key, valueOrCallback, i])
				return promise
			} else if (isFunction(valueOrCallback)) {
				const [i, promise] = this.#callback(valueOrCallback)
				this.#messages.push([key, 0, i])
				return promise
			} else if (valueOrCallback !== undefined) {
				this.#messages.push([key, valueOrCallback])
			} else {
				this.#messages.push([key])
			}
		}
	}

	/**
	 * Listen for data sent by the server
	 *
	 * @param {string} key
	 * @param {Function} value
	 * @returns () => void | undefined - `off` function to remove the
	 *   listener
	 */
	on(key, value) {
		// empty `key` is reserved
		if (key == '') {
			error('`key` cannot be empty')
		} else {
			this.#listeners[key] = this.#listeners[key] || []
			this.#listeners[key].push(value)
			return () => this.#off(key, value)
		}
	}

	// PRIVATE API

	#off(k, v) {
		const i = this.#listeners[k].indexOf(v)
		if (i !== -1) {
			this.#listeners[k].splice(i, 1)
		}
	}

	/** @returns {[number, Promise<any>]} */
	#callback(c) {
		let resolve
		const promise = new Promise(r => (resolve = r))
		const i = this.#callbacks.length
		this.#callbacks[i] = args => resolve(c(...args))
		return [i, promise]
	}
	#oncallback = d => {
		this.#callbacks[d[0]](d[1])
		this.#callbacks[d[0]] = null
	}

	#dispatch(d) {
		for (const e of d) {
			if (this.#listeners[e[0]]) {
				for (const fn of this.#listeners[e[0]]) {
					fn(
						e[1],
						e[2]
							? (...d) => {
									this.emit('', [e[2], d])
								}
							: undefined,
					)
				}
			}
		}
	}

	#send = () => {
		if (this.#messages.length) {
			const messages = this.#messages
			this.#messages = []
			this.#postMessage(['emit', messages])
		}
	}

	#onworkermessage = e => {
		switch (e.data[0]) {
			case 'messages': {
				this.#dispatch(e.data[1])
				break
			}
			case 'dispatch': {
				this.#dispatch([[e.data[1], e.data[2]]])
				break
			}
			case 'connect': {
				this.connect()
				break
			}
			case 'connected': {
				this.connected = e.data[1]
				break
			}
		}
	}

	decode(s) {
		if (s.b) {
			return fetch(s.b).then(r => r.blob())
		} else if (s.a) {
			return fetch(s.a).then(r => r.arrayBuffer())
		}
	}
}
