export function ClientWebWorker() {
	const id = () =>
		crypto.getRandomValues(new BigUint64Array(1))[0].toString(36)

	const stringify = JSON.stringify
	const parse = JSON.parse

	Blob.prototype.toJSON = function () {
		return {
			b: new FileReaderSync().readAsDataURL(this),
		}
	}
	ArrayBuffer.prototype.toJSON = function () {
		return {
			a: new FileReaderSync().readAsDataURL(this),
		}
	}

	const OPEN = 1
	const CLOSING = 2
	const CLOSED = 3

	const connid = id()

	let connected = true
	let reconnect = true
	let isReconnect = false

	let messages = []
	let buffered = []

	let io

	self.onmessage = function (e) {
		switch (e.data[0]) {
			case 'emit': {
				emit(e.data[1])
				break
			}
			case 'connect': {
				connect(e.data[1])
				break
			}
			case 'disconnect': {
				disconnect(e.data[1])
				break
			}
		}
	}

	function onopen() {
		connected = true
		postMessage(['connected', true])

		if (isReconnect) {
			postMessage(['dispatch', 'reconnect'])
		} else {
			isReconnect = true
			postMessage(['dispatch', 'connect'])
		}

		send()
	}
	function onclose(event) {
		const { code, reason } = event
		switch (code) {
			case 1000:
				/**
				 * Normal close - console.log('ws - normal close', event.code,
				 * event.reason)
				 */
				break
			case 1001:
				/**
				 * Freaking firefox code when reloading the page, must be
				 * blacklisted else it will connect twice in reloads.
				 */
				break
			case 1005:
				/**
				 * Closed by client - console.log( 'ws - we called
				 * socket.disconnect()', event.code, event.reason, )
				 */
				break
			case 1006: {
				/**
				 * Closed by server or connection never opened and failed to
				 * connect - console.log( 'ws - server killed the connection,
				 * or we failed to connect to server', event.code,
				 * event.reason, )
				 */
				break
			}
			default: {
				console.warn('ws - unknown close', code, reason)
				break
			}
		}

		if (connected) {
			connected = false
			postMessage(['connected', false])
			postMessage(['dispatch', 'disconnect'])
		}

		console.log(code)

		// 1001: freaking firefox
		// 1005: do not reconnect when we call `socket.disconnect()`
		// 1006: DO NOT USE! THAT HAPPENS WHEN SERVER CONNECTION IS KILLED
		if (reconnect && code !== 1005 && code !== 1001) {
			postMessage(['connect'])
		}
	}

	/**
	 * This happens when trying to connect while the server or the
	 * internet connection is down
	 */
	function onerror() {
		if (connected) {
			connected = false
			postMessage(['connected', false])
			postMessage(['dispatch', 'disconnect'])
		}

		if (reconnect) {
			postMessage(['connect'])
		}
	}

	function disconnect(noReconnect) {
		if (noReconnect) {
			reconnect = false
		}

		if (io && io.readyState !== CLOSING && io.readyState !== CLOSED) {
			io.close()
		}
	}

	function connect(options) {
		if (
			reconnect &&
			(!io || io.readyState === CLOSED || io.readyState === CLOSING)
		) {
			const url = new URL(options.url)
			url.pathname = 'angelia'

			const { searchParams } = url
			// params
			const params = options.params
			params.connid = connid

			for (const [k, v] of Object.entries(params)) {
				searchParams.append(k, v)
			}

			// append buffered messages
			if (messages.length) {
				if (!isReconnect) {
					let length = url.href.length
					const queue = []
					while (messages.length && length < 2048) {
						const message = messages.shift()
						const string = stringify(message)
						if (length + string.length < 2048) {
							length += string.length
							queue.push(message)
						} else {
							messages.unshift(message)
							break
						}
					}
					if (queue.length) {
						searchParams.append('angelia', stringify(queue))
					}
				} else {
					for (const m of messages) {
						// dont buffer callbacks, they are gone for new connections
						if (m[0] !== '') {
							buffered.push(m)
						}
					}
					messages = []
				}
			}

			io = new WebSocket(url)
			io.onopen = onopen
			io.onclose = onclose
			io.onerror = onerror
			io.onmessage = onmessage
		}
	}

	function emit(msgs) {
		for (const m of msgs) {
			messages.push(m)
		}
		send()
	}
	function send() {
		if (io?.readyState === OPEN) {
			let m
			if (messages.length) {
				m = messages
				messages = []
				io.send(stringify(m))
			}
			if (buffered.length) {
				m = buffered
				buffered = []
				io.send(stringify(m))
			}
		}
	}
	function pong() {
		if (io?.readyState === OPEN) {
			io.send('')
		}
	}

	function onmessage(e) {
		e.data === '' ? pong() : postMessage(['messages', parse(e.data)])
	}
}
