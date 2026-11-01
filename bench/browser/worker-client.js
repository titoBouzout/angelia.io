// The pre-WebTransport worker design, for comparison: objects cross
// postMessage and the worker does JSON. Same queueing and callback
// protocol as client/index.js, minus reconnect handling.
export class WorkerClient {
	#callbacks = [null]
	#listeners = { '': [d => this.#oncallback(d)] }
	#messages = []
	#worker

	constructor(url) {
		const { promise, resolve } = Promise.withResolvers()
		this.ready = promise
		this.#worker = new Worker(new URL('./worker.js', import.meta.url))
		this.#worker.onmessage = e => {
			const [type, payload] = e.data
			if (type === 'open') resolve()
			else this.#dispatch(payload)
		}
		this.#worker.postMessage(['connect', url])
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

	close() {
		this.#worker.terminate()
	}

	#send = () => {
		const batch = this.#messages
		this.#messages = []
		this.#worker.postMessage(['send', batch])
	}

	#oncallback(d) {
		const cb = this.#callbacks[d[0]]
		this.#callbacks[d[0]] = null
		cb?.(d[1])
	}

	#dispatch(messages) {
		for (const m of messages) {
			for (const fn of this.#listeners[m[0]] || []) fn(m[1])
		}
	}
}
