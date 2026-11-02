/**
 * Socket transports for the Client. Both move only strings and answer
 * the server's heartbeat themselves; everything else stays in Client.
 *
 * @typedef {{
 * 	onopen: () => void
 * 	onmessage: (text: string) => void
 * 	onclose: (code: number) => void
 * 	onerror: (err: unknown) => void
 * }} SocketHandlers
 *
 * @typedef {{
 * 	send: (text: string) => void
 * 	close: (code: number, reason: string) => void
 * }} Connection
 *
 * @typedef {{
 * 	open: (url: URL, handlers: SocketHandlers) => Connection
 * 	terminate: () => void
 * }} Transport
 */

/**
 * WebSocket owned by a Web Worker when the environment has one, so
 * the browser's own send/receive work (expensive in Chromium) and the
 * heartbeat stay off the main thread. See `bench/browser`.
 *
 * @param {boolean} useWorker
 * @returns {Transport}
 */
export function createTransport(useWorker) {
	return useWorker && typeof Worker !== 'undefined'
		? workerTransport()
		: directTransport()
}

/** @returns {Transport} */
function directTransport() {
	return {
		open(url, handlers) {
			const ws = new WebSocket(url)
			ws.onopen = handlers.onopen
			ws.onclose = e => handlers.onclose(e.code)
			ws.onmessage = e =>
				e.data === '' ? ws.send('') : handlers.onmessage(e.data)
			return {
				send: text => {
					if (ws.readyState === WebSocket.OPEN) ws.send(text)
				},
				close: (code, reason) => {
					try {
						ws.close(code, reason)
					} catch (err) {
						handlers.onerror(err)
					}
				},
			}
		},
		terminate() {},
	}
}

/**
 * Data frames cross `postMessage` as bare strings, with no wrapper array
 * to allocate and clone; they always belong to the latest connection,
 * because the Client only opens one after the previous one closed.
 * Control messages are `[type, id, value]`.
 *
 * @returns {Transport}
 */
function workerTransport() {
	/** @type {Worker | null} */
	let worker = null
	let nextId = 0
	/** @type {Map<number, SocketHandlers>} */
	const connections = new Map()
	/** @type {SocketHandlers | undefined} */
	let latest

	const spawn = () => {
		// Built from source so the package ships one file and works with
		// any bundler. A CSP without `worker-src blob:` needs `worker: false`.
		const url = URL.createObjectURL(
			new Blob(['(' + workerMain + ')(self)'], {
				type: 'text/javascript',
			}),
		)
		const spawned = new Worker(url)
		URL.revokeObjectURL(url)
		spawned.onmessage = ({ data }) => {
			if (typeof data === 'string') {
				latest?.onmessage(data)
				return
			}
			const [type, id, value] = data
			const handlers = connections.get(id)
			if (!handlers) return
			if (type === 'open') handlers.onopen()
			else if (type === 'error') handlers.onerror(value)
			else if (type === 'close') {
				connections.delete(id)
				handlers.onclose(value)
			}
		}
		return spawned
	}

	return {
		open(url, handlers) {
			const live = (worker ??= spawn())
			const id = ++nextId
			connections.set(id, handlers)
			latest = handlers
			live.postMessage(['connect', id, url.toString()])
			return {
				send: text => live.postMessage(text),
				close: (code, reason) =>
					live.postMessage(['close', id, code, reason]),
			}
		},
		terminate() {
			worker?.terminate()
			worker = null
			connections.clear()
			latest = undefined
		},
	}
}

/**
 * Worker entry point, stringified into the worker's source: it must
 * not reference anything outside its own body.
 *
 * @param {{
 * 	postMessage: (message: any[] | string) => void
 * 	onmessage: ((e: MessageEvent) => void) | null
 * }} scope
 */
function workerMain(scope) {
	/** @type {Map<number, WebSocket>} */
	const sockets = new Map()
	/** @type {WebSocket | undefined} The latest connection; strings go to it. */
	let latest

	scope.onmessage = ({ data }) => {
		if (typeof data === 'string') {
			if (latest?.readyState === WebSocket.OPEN) latest.send(data)
			return
		}
		const [type, id, value, reason] = data
		if (type === 'connect') {
			const ws = new WebSocket(value)
			sockets.set(id, ws)
			latest = ws
			ws.onopen = () => scope.postMessage(['open', id])
			ws.onclose = e => {
				sockets.delete(id)
				scope.postMessage(['close', id, e.code])
			}
			ws.onmessage = e =>
				e.data === '' ? ws.send('') : scope.postMessage(e.data)
		} else if (type === 'close') {
			try {
				sockets.get(id)?.close(value, reason)
			} catch (err) {
				scope.postMessage(['error', id, String(err)])
			}
		}
	}
}
