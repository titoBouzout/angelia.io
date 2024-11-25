import {
	empty,
	frame,
	inspect,
	ListenerTemplate,
	now,
	stringify,
} from './utils.js'

import { Socket } from './Socket.js'
import { Emitter } from './Emitter.js'

import { nextTick } from 'node:process'
import * as http from 'http'
import formidable from 'formidable'

import { WebSocketServer } from 'ws'

/** Creates a new Socket Server */
export default new (class Server extends Emitter {
	constructor() {
		super()

		this.hostname = ''
		this.port = 3001

		this.timeout = 60 * 1000
		this.timeoutCheck = 25 * 1000

		this.maxMessageSize = 5
		this.maxPostSize = 50

		this.since = 0
		this.now = 0

		this.served = 0
		this.bytesReceived = 0
		this.bytesSent = 0
		this.messagesGarbage = 0
		this.messagesReceived = 0
		this.messagesSent = 0
		this.messagesSentCacheHit = 0
		this.serverErrors = 0
		this.socketErrors = 0

		this.queue = []

		this.cacheSymbol = Symbol('cache')
		this.cached = 1
		this.cache = empty()

		this.events = empty()

		this.pingData = frame('')
		this.disconnectData = frame(stringify([['disconnect', true]]))
	}
	/**
	 * Start server listening
	 *
	 * @param {{
	 * 	hostname?: string
	 * 	port?: number
	 * 	maxMessageSize?: number
	 * 	maxPostSize?: number
	 * 	skipUTF8Validation?: boolean
	 * 	timeout?: number
	 * }} [options]
	 */
	listen(options = {}) {
		this.hostname = options.hostname || this.hostname
		this.port =
			+options.port > 0 && +options.port <= 65535
				? +options.port
				: this.port

		this.maxMessageSize =
			+options.maxMessageSize > 0 ? +options.maxMessageSize : 5
		this.maxPostSize =
			+options.maxPostSize > 0 ? +options.maxPostSize : 50

		this.now = now()
		this.since = this.now

		this.timeout =
			+options.timeout >= 10000 ? +options.timeout : 60 * 1000

		// updates ping and checks for disconnections
		this.timeoutCheck = this.timeout / 2
		setInterval(this.ping, this.timeoutCheck)
		this.timeoutCheck -= 5000

		setInterval(this.updateNow, 500)

		// fires the server

		const server = http.createServer(async (request, response) => {
			/*
			need to take care of rooms before handling this

			if (
				request.url === '/angelia/upload' &&
				request.method === 'POST'
			) {
				// parse a file upload
				const form = formidable({})

				try {
					const [fields, files] = await form.parse(request)
				} catch (err) {
					console.error(err)
					response.writeHead(err.httpCode || 400, {
						'Content-Type': 'text/plain',
					})
					response.end(String(err))
					return
				}
				response.writeHead(200, {
					'Content-Type': 'application/json',
				})
				response.end(JSON.stringify({ fields, files }, null, 2))
				return
			} else {
				response.writeHead(200, { 'Content-Type': 'text/plain' })
				response.end()
			}
			*/
		})

		const io = new WebSocketServer({
			perMessageDeflate: false,
			clientTracking: false,
			server: server,
			path: '/angelia',
			maxPayload: this.maxMessageSize * 1024 * 1024,
			backlog: 1024,
			skipUTF8Validation:
				options.skipUTF8Validation !== undefined
					? options.skipUTF8Validation
					: false,
		})

		io.on('connection', this.onconnect)
		io.on('error', this.onerror)

		server.listen(this.port, this.hostname || undefined)

		this.events.listen && this.events.listen()

		console.log('Socket Server Started Listening On Port', this.port)
	}

	/**
	 * Listen for events
	 *
	 * @template T
	 * @param {T} listener
	 */
	on(listener) {
		const instance = new listener()

		const methods = listener.listeners || [
			// todo maybe use getPrototypeOf ?
			...Object.getOwnPropertyNames(instance.__proto__),
			...Object.getOwnPropertyNames(instance),
		]

		for (const m of methods) {
			// '' listener is reserved
			if (m !== 'constructor' && m !== '') {
				if (typeof instance[m] === 'function') {
					const method = instance[m].bind(instance)

					this.events[m] = this.events[m] || ListenerTemplate()
					this.events[m].fns.push(method)
				}
			}
		}

		return instance
	}

	// private

	onconnect = (socket, request) => {
		socket = new Socket(socket, this, request)

		this.served++

		socket.listen()

		this.sockets.add(socket)

		this.events.connect && this.events.connect(socket, request)

		if (socket.params.angelia) {
			socket.onmessage(socket.params.angelia)
		}

		// ping on connect is usually high
		setTimeout(() => this.pingSocket(socket), 200)
	}
	onerror = err => {
		this.serverErrors++
		console.error('Server.onerror', err)
	}

	// queue
	nextQueue(socket) {
		if (!this.queue.length) {
			nextTick(this.processQueue)
		}
		this.queue.push(socket)
	}
	processQueue = () => {
		const queue = this.queue
		this.queue = []
		for (const socket of queue) {
			socket.processQueue()
		}
		this.cache = empty()
	}
	cacheMessages(messages, socket) {
		let id = ''
		for (const m of messages) {
			if (!m[this.cacheSymbol]) {
				m[this.cacheSymbol] = this.cached++
			}
			id += m[this.cacheSymbol] + ','
		}
		if (!this.cache[id]) {
			const json = stringify(messages)
			this.bytesSent += json.length
			socket.bytesSent += json.length
			this.cache[id] = frame(json)
		} else {
			this.messagesSentCacheHit++
		}
		return this.cache[id]
	}

	// ping
	updateNow = () => {
		this.now = now()
	}
	ping = () => {
		this.updateNow()
		for (const socket of this.sockets) {
			const delay = this.now - socket.seen

			if (delay > this.timeout) {
				socket.timedout = true
				this.events.timeout && this.events.timeout(socket, delay)
				socket.io.terminate()
			} else if (delay > this.timeoutCheck) {
				/**
				 * In an example: if timeout is set to 60 seconds, then we
				 * check for timed out sockets every 30 seconds. If the socket
				 * was last seen 29 seconds ago, then the next check will be
				 * in another 30 seconds. That means that if the socket doesnt
				 * sends any message since then, then the last seen will be 59
				 * seconds the next time. This gives very little amount of
				 * time to check. For this reason we remove 5 seconds on the
				 * condition by using `this.timeoutCheck`
				 */
				this.pingSocket(socket)
			}
		}
	}
	pingSocket(socket) {
		this.updateNow()
		socket.contacted = this.now
		if (socket.io.readyState === 1) {
			socket.write(this.pingData)
		}
	}
	pong(socket) {
		this.updateNow()
		socket.seen = this.now
		socket.ping = this.now - socket.contacted

		this.events.ping && this.events.ping(socket)
	}

	toJSON() {
		return '[content of server object omitted for toJSON]'
	}
	[inspect]() {
		return {
			...this,
			sockets: 'omitted',
		}
	}
})()
