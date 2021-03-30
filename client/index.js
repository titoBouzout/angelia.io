'use strict'

const ClientWebWorker = `class ClientWebWorker {
	constructor() {
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

		Object.assign(this, {
			connid: this.generateId(),

			connected: true,
			reconnect: true,
			isReconnect: false,

			messages: [],
			buffered: [],

			onopen: this.onopen.bind(this),
			onclose: this.onclose.bind(this),
			onerror: this.onerror.bind(this),
			onmessage: this.onmessage.bind(this),

			postMessage: self.postMessage.bind(self),
		})

		self.onmessage = function (e) {
			switch (e.data[0]) {
				case 'emit': {
					this.emit(e.data[1])
					break
				}
				case 'connect': {
					this.connect(e.data[1])
					break
				}
				case 'disconnect': {
					this.disconnect(e.data[1])
					break
				}
			}
		}.bind(this)
	}

	connect(options) {
		if (
			this.reconnect &&
			(!this.io || this.io.readyState === WebSocket.CLOSED)
		) {
			let url = new URL(options.url)

			// parms creation
			let params = options.params
			if (!params.connid) {
				params.connid = this.connid
			}
			for (let [k, v] of url.searchParams.entries()) {
				if (!params.hasOwnProperty(k)) {
					params[k] = v
				}
			}
			url.search = Object.entries(params)
				.filter(([k, v]) => {
					return !(
						k === undefined ||
						k === null ||
						v === undefined ||
						v === null
					)
				})
				.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
				.join('&')

			url = url.toString()

			// append buffered messages
			let oURL = url
			if (this.messages.length && !this.isReconnect) {
				url =
					(url.indexOf('?') === -1 ? url + '?' : url + '&') +
					'angelia.io=' +
					encodeURIComponent(JSON.stringify(this.messages))
				if (url.length < 2048) {
					this.messages = []
				} else {
					url = oURL
				}
			} else if (this.messages.length && this.isReconnect) {
				for (let m of this.messages) {
					// dont buffer callbacks, they are gone for new connections
					if (m[0] !== '') this.buffered.push(m)
				}
				this.messages = []
			}
			this.io = new WebSocket(url)
			Object.assign(this.io, {
				onopen: this.onopen,
				onclose: this.onclose,
				onerror: this.onerror,
				onmessage: this.onmessage,
			})
		}
	}

	disconnect(noReconnect) {
		if (noReconnect) this.reconnect = false

		if (
			this.io &&
			this.io.readyState !== WebSocket.CLOSING &&
			this.io.readyState !== WebSocket.CLOSED
		) {
			this.io.close()
		}
	}

	onopen() {
		this.connected = true
		this.postMessage(['connected', true])

		if (this.isReconnect) {
			this.postMessage(['dispatch', 'reconnect'])
		} else {
			this.isReconnect = true
			this.postMessage(['dispatch', 'connect'])
		}

		this.send()
	}
	onclose(event) {
		switch (event.code) {
			// normal close
			case 1000:
				/*console.log('ws - normal close', event.code, event.reason)*/
				break
			// closed by client
			case 1005:
				/*console.log(
					'ws - we called socket.disconnect()',
					event.code,
					event.reason,
				)*/
				break
			// closed by server or
			// connection never opened and failed to connect
			case 1006: {
				/*console.log(
					'ws - server killed the connection, or we failed to connect to server',
					event.code,
					event.reason,
				)*/
				break
			}
			default: {
				console.log('ws - unknown close', event.code, event.reason)
				break
			}
		}

		if (this.connected) {
			this.connected = false
			this.postMessage(['connected', false])
			this.postMessage(['dispatch', 'disconnect'])
		}

		if (this.reconnect) this.postMessage(['connect'])
	}
	// this happens when trying to connect while the server or
	// the internet connection is down
	onerror() {
		if (this.connected) {
			this.connected = false
			this.postMessage(['connected', false])
			this.postMessage(['dispatch', 'disconnect'])
		}

		if (this.reconnect) this.postMessage(['connect'])
	}
	onmessage(e) {
		if (e.data === '') {
			this.pong()
		} else {
			this.postMessage(['messages', JSON.parse(e.data)])
		}
	}
	emit(messages) {
		for (let m of messages) {
			this.messages.push(m)
		}
		this.send()
	}
	send() {
		if (this.io && this.io.readyState === WebSocket.OPEN) {
			if (this.messages.length) {
				let messages = this.messages
				this.messages = []
				this.io.send(JSON.stringify(messages))
			}
			if (this.buffered.length) {
				let buffered = this.buffered
				this.buffered = []
				this.io.send(JSON.stringify(buffered))
			}
		}
	}
	pong() {
		if (this.io && this.io.readyState === WebSocket.OPEN) {
			this.io.send('')
		}
	}
	generateId() {
		var id = ''
		while (!id) {
			id = Math.random().toString(36).substr(2, 10)
		}
		return id
	}
}`

class Client {
	constructor(options) {
		if (!options || typeof options === 'string') {
			options = {
				url: options,
			}
		}

		let protocol = location.protocol === 'https:' ? 'wss' : 'ws'
		if (!options.url) {
			options.url = protocol + '://' + location.hostname + ':3001'
		} else if (options.url.indexOf('://') === -1) {
			options.url = protocol + '://' + options.url
		}

		const io = new Worker(
			URL.createObjectURL(
				new Blob(["'use strict';new (" + ClientWebWorker + ')']),
				{
					type: 'application/javascript; charset=utf-8',
				},
			),
		)

		Object.assign(this, {
			url: options.url,
			params: options.params,
			longLiveFlash: options.longLiveFlash,

			connected: true,
			messages: [],
			listeners: {
				'': [this.oncallback.bind(this)],
			},
			callbacks: [() => {}],

			onworkermessage: this.onworkermessage.bind(this),
			postMessage: io.postMessage.bind(io),
			disconnect: this.disconnect.bind(this),

			send: this.send.bind(this),
			null: Object.create(null),
		})

		io.onmessage = this.onworkermessage

		// to force disconnect
		this.on('disconnect', this.disconnect)

		// to try to close the connection nicely
		window.addEventListener('unload', () => this.disconnect(true), true)

		// to send messages fast without waiting for the connection
		Promise.resolve().then(() => this.connect())
	}

	// public API

	connect() {
		this.postMessage([
			'connect',
			{
				url: this.url,
				params: typeof this.params === 'function' ? this.params() || {} : {},
			},
		])
	}

	disconnect(noReconnect) {
		this.postMessage(['disconnect', noReconnect])
	}

	emit(k, v, c) {
		if (!this.messages.length) {
			Promise.resolve().then(this.send)
		}
		if (c) {
			this.messages.push([k, v, this.callback(c)])
		} else if (typeof v === 'function') {
			this.messages.push([k, this.null, this.callback(v)])
		} else if (v !== null && v !== undefined) {
			this.messages.push([k, v])
		} else {
			this.messages.push([k])
		}
	}

	on(k, v) {
		if (k != '' && typeof v === 'function') {
			this.listeners[k] = this.listeners[k] || []
			this.listeners[k].push(v)
			return () => this.off(k, v)
		} else {
			console.error(
				'ws - socket.on("' +
					k +
					'", callback) key and callback cannot be empty',
			)
		}
	}
	off(k, v) {
		if (!this.listeners[k]) {
			console.error(
				'ws - socket.off("' + k + '", callback)',
				k,
				'key not found',
			)
		} else {
			let i = this.listeners[k].indexOf(v)
			if (i === -1) {
				console.error(
					'ws - socket.off("' + k + '", callback)',
					v,
					'callback not found',
				)
			} else {
				this.listeners[k].splice(i, 1)
			}
		}
	}

	// PRIVATE API

	callback(c) {
		let i = this.callbacks.length
		this.callbacks[i] = c
		return i
	}
	oncallback(d) {
		this.callbacks[d[0]](...d[1])
		this.callbacks[d[0]] = null
	}
	dispatch(d) {
		if (this.longLiveFlash) {
			setTimeout(() => {
				for (let e of d) {
					if (this.listeners[e[0]]) {
						for (let fn of this.listeners[e[0]]) {
							fn(
								e[1],
								e[2]
									? (...d) => {
											this.emit('', [e[2], d])
									  }
									: null,
							)
						}
					}
				}
			})
		} else {
			for (let e of d) {
				if (this.listeners[e[0]]) {
					for (let fn of this.listeners[e[0]]) {
						fn(
							e[1],
							e[2]
								? (...d) => {
										this.emit('', [e[2], d])
								  }
								: null,
						)
					}
				}
			}
		}
	}
	send() {
		if (this.messages.length) {
			let messages = this.messages
			this.messages = []
			this.postMessage(['emit', messages])
		}
	}

	onworkermessage(e) {
		switch (e.data[0]) {
			case 'messages': {
				this.dispatch(e.data[1])
				break
			}
			case 'dispatch': {
				this.dispatch([[e.data[1], e.data[2]]])
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

;(function (root) {
	if (typeof exports !== 'undefined') {
		if (typeof module !== 'undefined' && module.exports) {
			exports = module.exports = Client
		}
		exports.Client = Client
	} else if (typeof define === 'function' && define.amd) {
		define([], function () {
			return Client
		})
	} else {
		root.Client = Client
	}
})(this)
