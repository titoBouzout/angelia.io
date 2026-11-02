// Queueing, callbacks and dispatch for the comparison clients, with the
// same wire protocol as client/index.js minus reconnect handling. Each
// subclass passes in how a batch leaves and calls `receive` on arrival.
export class BenchClient {
	#callbacks = [null]
	#listeners = { '': [d => this.#oncallback(d)] }
	#messages = []
	#transmit

	/** @param {(batch: any[]) => void} transmit */
	constructor(transmit) {
		this.#transmit = transmit
	}

	emit(key, value, callback) {
		let message
		let promise
		if (callback) {
			const { promise: p, resolve } = Promise.withResolvers()
			const i = this.#callbacks.length
			this.#callbacks[i] = args => resolve(callback(...args))
			message = [key, value, i]
			promise = p
		} else {
			message = value === undefined ? [key] : [key, value]
		}
		if (!this.#messages.length) queueMicrotask(() => queueMicrotask(this.#send))
		this.#messages.push(message)
		return promise
	}

	on(key, fn) {
		;(this.#listeners[key] ||= []).push(fn)
	}

	/** Dispatch a batch of messages that arrived. */
	receive(messages) {
		for (const m of messages) {
			for (const fn of this.#listeners[m[0]] || []) fn(m[1])
		}
	}

	#send = () => {
		const batch = this.#messages
		this.#messages = []
		this.#transmit(batch)
	}

	#oncallback(d) {
		const cb = this.#callbacks[d[0]]
		this.#callbacks[d[0]] = null
		cb?.(d[1])
	}
}
