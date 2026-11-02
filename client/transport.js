/**
 * The Client's socket lives in a Web Worker, so the browser's own
 * send/receive work (expensive in Chromium) and the heartbeat stay
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

import { TIMEOUT_MS } from '../shared/protocol.js'

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
		// E.g. blocked by a Content Security Policy: say so instead of
		// waiting silently for a connection that can't happen.
		spawned.onerror = event => current?.onerror(event.message || event)
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
			live.postMessage(['connect', url.toString(), TIMEOUT_MS])
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
	/** @type {ReturnType<typeof setInterval> | undefined} */
	let heartbeat
	let received = 0
	let sent = 0

	/**
	 * @param {WebSocket} socket
	 * @param {number} code
	 */
	const closed = (socket, code) => {
		if (ws !== socket) return
		ws = null
		clearInterval(heartbeat)
		scope.postMessage(['close', code])
	}

	/** @param {number} timeout */
	const watch = timeout => {
		heartbeat = setInterval(() => {
			const socket = /** @type {WebSocket} */ (ws)
			const now = Date.now()
			if (now - received > timeout) {
				// A dead connection never finishes the closing handshake: don't wait for it.
				socket.onmessage = null
				closed(socket, 1006)
				socket.close()
			} else if (now - Math.min(received, sent) > timeout / 2 - 5000) {
				// Either way: the server times out a client that only listens.
				sent = now
				socket.send('')
			}
		}, timeout / 2)
	}

	scope.onmessage = ({ data }) => {
		if (typeof data === 'string') {
			if (ws?.readyState === WebSocket.OPEN) {
				sent = Date.now()
				ws.send(data)
			}
			return
		}
		const [type] = data
		if (type === 'connect') {
			const [, url, timeout] = data
			const socket = new WebSocket(url)
			ws = socket
			socket.onopen = () => {
				received = sent = Date.now()
				watch(timeout)
				scope.postMessage(['open'])
			}
			socket.onclose = e => closed(socket, e.code)
			socket.onmessage = e => {
				received = Date.now()
				if (e.data !== '') scope.postMessage(e.data)
			}
		} else if (type === 'close') {
			const [, code, reason] = data
			try {
				ws?.close(code, reason)
			} catch (err) {
				scope.postMessage(['error', String(err)])
			}
		}
	}
}
