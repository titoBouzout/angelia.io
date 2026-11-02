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
 * The Client only opens a connection after the previous one closed, so
 * the worker holds at most one socket and no ids are needed. Data frames
 * cross `postMessage` as bare strings; control messages are small
 * `[type, value, reason]` arrays.
 *
 * @returns {Transport}
 */
export function workerTransport() {
	/** @type {Worker | null} */
	let worker = null
	/** @type {SocketHandlers | null} The open connection's handlers. */
	let current = null

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
			const handlers = current
			if (!handlers) return
			if (typeof data === 'string') {
				handlers.onmessage(data)
				return
			}
			const [type, value] = data
			if (type === 'open') handlers.onopen()
			else if (type === 'error') handlers.onerror(value)
			else if (type === 'close') {
				current = null
				handlers.onclose(value)
			}
		}
		return spawned
	}

	return {
		open(url, handlers) {
			const live = (worker ??= spawn())
			current = handlers
			live.postMessage(['connect', url.toString()])
			return {
				send: text => live.postMessage(text),
				close: (code, reason) => live.postMessage(['close', code, reason]),
			}
		},
		terminate() {
			worker?.terminate()
			worker = null
			current = null
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
	/** @type {WebSocket | null} */
	let ws = null

	scope.onmessage = ({ data }) => {
		if (typeof data === 'string') {
			if (ws?.readyState === WebSocket.OPEN) ws.send(data)
			return
		}
		const [type, value, reason] = data
		if (type === 'connect') {
			const socket = new WebSocket(value)
			ws = socket
			socket.onopen = () => scope.postMessage(['open'])
			socket.onclose = e => {
				if (ws === socket) ws = null
				scope.postMessage(['close', e.code])
			}
			socket.onmessage = e =>
				e.data === '' ? socket.send('') : scope.postMessage(e.data)
		} else if (type === 'close') {
			try {
				ws?.close(value, reason)
			} catch (err) {
				scope.postMessage(['error', String(err)])
			}
		}
	}
}
