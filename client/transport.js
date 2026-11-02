/**
 * The Client's socket lives in a Web Worker, so the browser's own
 * send/receive work (expensive in Chromium) and the heartbeat reply stay
 * off the main thread (see `bench/browser`). Only strings cross
 * `postMessage`; everything else stays in Client.
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
 * Data frames cross `postMessage` as bare strings, with no wrapper array
 * to allocate and clone; they always belong to the latest connection,
 * because the Client only opens one after the previous one closed.
 * Control messages are `[type, id, value]`.
 *
 * @returns {Transport}
 */
export function workerTransport() {
	/** @type {Worker | null} */
	let worker = null
	let nextId = 0
	/** @type {Map<number, SocketHandlers>} */
	const connections = new Map()
	/** @type {SocketHandlers | undefined} */
	let latest

	const spawn = () => {
		// Built from source so the package ships one file and works with
		// any bundler; a Content Security Policy must allow `worker-src blob:`.
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
