'use strict'

const inspect = Symbol.for('nodejs.util.inspect.custom')

const Listeners = new (require('./Listeners.js'))()
const Manager = require('./rooms/Manager.js')

const toFastProperties = require('to-fast-properties')

class ServerSingleton {
	constructor() {
		Object.assign(this, {
			hostname: '',
			port: 3001,
			timeout: 60 * 1000,
			maxMessageSize: 5,

			cert: '',
			key: '',

			queue: [],

			since: 0,
			now: 0,

			served: 0,
			bytesSent: 0,
			bytesReceived: 0,
			messagesSent: 0,
			messagesReceived: 0,
			messagesCached: 0,

			ping: this.ping.bind(this),
			updateNow: this.updateNow.bind(this),

			onconnect: this.onconnect.bind(this),
			onerror: this.onerror.bind(this),

			processQueue: this.processQueue.bind(this),

			listeners: Listeners,
			events: Listeners.events,

			sockets: new Set(),

			track: Manager.track,
			rooms: Manager.rooms,
			Room: require('./rooms/Room.js'),
			observe: Manager.observe,

			cacheIds: Symbol('cache'),
			cacheId: 1,
			cache: Object.create(null),

			URL: require('url'),
			Socket: require('./Socket.js'),
			WebSocket: require('ws'),
			WebSocketFrame: {
				readOnly: false,
				mask: false,
				rsv1: false,
				opcode: 1,
				fin: true,
			},
			pingData: [],
		})

		Object.defineProperties(this.listeners, {
			server: {
				value: this,
				writable: false,
				configurable: false,
				enumerable: false,
			},
		})

		this.pingData = this.WebSocket.Sender.frame(
			Buffer.from(''),
			this.WebSocketFrame,
		)
	}

	listen(options) {
		Object.assign(this, {
			port:
				+options.port > 0 && +options.port <= 65535 ? +options.port : this.port,
			hostname: options.hostname || this.hostname,
			maxMessageSize:
				+options.maxMessageSize > 0
					? +options.maxMessageSize
					: this.maxMessageSize,
			cert: options.cert || this.cert,
			key: options.key || this.key,

			since: Date.now(),
			now: Date.now(),
		})

		this.ensureFastProperties()

		// ping
		setInterval(this.ping, this.timeout / 2)
		setInterval(this.updateNow, 500)

		// fires the server
		let server
		if (this.cert && this.key) {
			let fs = require('fs')
			server = require('https').createServer({
				cert: fs.readFileSync(this.cert), // fullchain.pem
				key: fs.readFileSync(this.key), // privkey.pem
			})
		} else {
			server = require('http').createServer()
		}

		let io = new this.WebSocket.Server({
			server: server,
			perMessageDeflate: false,
			maxPayload: this.maxMessageSize * 1024 * 1024,
			clientTracking: false,
			backlog: 1024,
		})

		io.on('connection', this.onconnect)
		io.on('error', this.onerror)

		server.listen(this.port, this.hostname || null)

		for (let m of ['RESTART', 'SIGINT', 'SIGTERM', 'SIGBREAK']) {
			process.on(m, () => {
				if (!io.closing) {
					io.closing = true
					console.log('Server Shutting Down\n', this)
					io.close()
				}
			})
		}

		console.log('Server Started Listening On Port ' + this.port)
		this.events.listen && this.events.listen()

		return this
	}
	// count of connections

	get connections() {
		return this.sockets.size
	}

	// listen for an event

	on(k, cb) {
		let instance = this.listeners.on(k, cb)
		Object.defineProperties(instance, {
			server: {
				value: this,
				writable: false,
				configurable: false,
				enumerable: false,
			},
		})

		this.ensureFastProperties()
	}

	// emits to everyone connected to the server

	emit(k, v) {
		let d = [k, v]
		for (let socket of this.sockets) {
			socket.emit(d)
		}
	}
	once(k, v) {
		let d = [k, v]
		for (let socket of this.sockets) {
			socket.once(d)
		}
	}
	broadcast(me, k, v) {
		let d = [k, v]
		for (let socket of this.sockets) {
			if (me != socket) socket.emit(d)
		}
	}
	broadcastOnce(me, k, v) {
		let d = [k, v]
		for (let socket of this.sockets) {
			if (me != socket) socket.once(d)
		}
	}

	// PRIVATE API

	onconnect(socket, request) {
		this.updateNow()

		socket = new this.Socket(socket, this)

		// set the ip, userAgent and params
		let params = this.URL.parse(request.url, true).query
		let angeliaParams = params['angelia.io']
		delete params['angelia.io']

		Object.assign(socket, {
			ip: (
				this.ip(request.connection.remoteAddress) ||
				this.ip(
					(request.headers['x-forwarded-for'] || '').split(/\s*,\s*/)[0],
				) ||
				request.connection.remoteAddress ||
				(request.headers['x-forwarded-for'] || '').split(/\s*,\s*/)[0]
			).replace(/'^::ffff:'/, ''),
			userAgent: request.headers['user-agent'] || '',
			params: params,
		})

		this.served++

		socket.listen()

		this.sockets.add(socket)

		this.events.connect && this.events.connect(socket.proxy, request)

		if (angeliaParams) {
			socket.onmessage(angeliaParams)
		}

		this.pingSocket.bind(this, socket)
	}
	onerror(err) {
		console.error('Server.onerror', err)
	}

	// queue

	nextQueue(socket) {
		if (!this.queue.length) {
			process.nextTick(this.processQueue)
		}
		this.queue.push(socket)
	}

	processQueue() {
		let queue = this.queue
		this.queue = []
		for (let socket of queue) {
			socket.processQueue()
		}
		// clear cache
		this.cache = Object.create(null)
	}

	cacheMessages(messages) {
		let id = ''
		for (let m of messages) {
			if (!m[this.cacheIds]) {
				m[this.cacheIds] = this.cacheId++
			}
			id += m[this.cacheIds] + ','
		}
		if (!this.cache[id]) {
			this.cache[id] = this.WebSocket.Sender.frame(
				Buffer.from(JSON.stringify(messages)),
				this.WebSocketFrame,
			)
		} else {
			this.messagesCached++
		}
		return this.cache[id]
	}

	// ping
	updateNow() {
		this.now = Date.now()
	}
	ping() {
		this.updateNow()
		for (let socket of this.sockets) {
			let delay = this.now - socket.seen
			if (delay > this.timeout) {
				// timedout
				socket.timedout = true
				this.events.timeout && this.events.timeout(socket.proxy, delay)
				socket.io.terminate()
			} else {
				// ping
				this.pingSocket(socket)
			}
		}
	}
	pingSocket(socket) {
		this.updateNow()
		socket.contacted = this.now
		if (socket.io.readyState === 1) {
			// socket.io.send('')
			for (let m of this.pingData) socket.io._socket.write(m)
		}
	}
	pong(socket) {
		this.updateNow()
		socket.seen = this.now
		socket.ping = this.now - socket.contacted
		this.events.ping && this.events.ping(socket.proxy)
	}
	// returns false if the ip is a private ip like 127.0.0.1
	ip(i) {
		switch (i) {
			case undefined:
			case null:
			case false:
			case 0:
			case '127.0.0.1':
			case '':
			case '::':
			case '::1':
			case '::ffff:':
			case '::ffff:127.0.0.1':
			case 'fe80::1': {
				return false
			}
			default: {
				if (
					/^(::f{4}:)?10\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(i) ||
					/^(::f{4}:)?192\.168\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(i) ||
					/^(::f{4}:)?172\.(1[6-9]|2\d|30|31)\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(
						i,
					) ||
					/^(::f{4}:)?127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(
						i,
					) ||
					/^(::f{4}:)?169\.254\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(i) ||
					/^f[cd][0-9a-f]{2}:/i.test(i) ||
					/^fe80:/i.test(i)
				)
					return false
				return i
			}
		}
	}
	// console.log and toJSON
	[inspect]() {
		return this.inspect()
	}
	toJSON() {
		return this.inspect()
	}
	inspect() {
		return {
			// started
			since: this.since,
			now: this.now,

			// options
			hostname: this.hostname,
			port: this.port,
			timeout: this.timeout,
			maxMessageSize: this.maxMessageSize,

			// stats
			connections: this.connections,

			served: this.served,
			bytesSent: this.bytesSent,
			bytesReceived: this.bytesReceived,
			messagesSent: this.messagesSent,
			messagesReceived: this.messagesReceived,
			messagesCached: this.messagesCached,

			// listeners
			listeners: this.listeners,
			events: this.events,

			// functions
			on: this.on,
			emit: this.emit,
			once: this.once,
			broadcast: this.broadcast,
			broadcastOnce: this.broadcastOnce,
			// data
			sockets: this.sockets,
			// rooms
			track: this.track,
			rooms: this.rooms,
			Room: this.Room,
		}
	}
	// fast properties

	ensureFastProperties() {
		// server
		toFastProperties(this)

		// the events class
		toFastProperties(this.events)

		// listeners
		for (let l in this.events) {
			// listener
			toFastProperties(this.events[l])
			// methods
			if (this.events[l].fns) {
				for (let m in this.events[l].fns) {
					toFastProperties(this.events[l].fns[m])
				}
			}
		}

		// classes
		toFastProperties(this.events.classes)
		for (let l in this.events.classes) {
			// class
			toFastProperties(this.events.classes[l])
			// methods
			for (let m in this.events.classes[l]) {
				toFastProperties(this.events.classes[l][m])
			}
		}

		// this.fastPropertiesPrint();
	}
	fastPropertiesPrint() {
		// server
		console.log('this.server', this.HasFastProperties(this))
		console.log('this.events', this.HasFastProperties(this.events))

		// listeners
		for (let l in this.events) {
			// listener
			console.log('this.events.' + l, this.HasFastProperties(this.events[l]))
			// methods
			if (this.events[l].fns) {
				for (let m in this.events[l].fns) {
					console.log(
						'this.events.' + l + '.' + this.events[l].fns[m].name,
						this.HasFastProperties(this.events[l].fns[m]),
					)
				}
			}
		}

		// classes
		console.log('this.events', this.HasFastProperties(this.events.classes))
		for (let m in this.events.classes) {
			console.log(
				'this.events.' + m,
				this.HasFastProperties(this.events.classes[m]),
			)
			// class
			for (let f in this.events.classes[m]) {
				// methods
				console.log(
					'this.events.' + m + '.' + this.events.classes[m][f].name,
					this.HasFastProperties(this.events.classes[m][f]),
				)
			}
		}
	}
	HasFastProperties(o) {
		// to uncomment this run node as "node --allow-natives-syntax"
		// return %HasFastProperties(o);
	}
}

const Server = new ServerSingleton()

module.exports = Server
