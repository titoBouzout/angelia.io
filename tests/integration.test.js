/**
 * End-to-end integration tests. Boots a real Server and talks to it
 * over a raw `ws` WebSocket, asserting on the wire protocol.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { inspect } from 'node:util'
import { execFileSync } from 'node:child_process'
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WebSocket } from 'ws'

import { Server, bootServer, freePort, waitFor } from './helpers.js'
import { Room } from '../server/Room.js'
import { Rooms } from '../server/Rooms.js'

/**
 * Open a raw WebSocket to `url`. Returns helpers to send batches and
 * await incoming data frames. Heartbeat pings (empty frames) are
 * counted in `pings` rather than queued, so they never race the
 * frames a test is waiting for.
 *
 * @param {string} url
 * @param {import('ws').ClientOptions} [options]
 */
async function bootClient(url, options) {
	const ws = new WebSocket(url, options)

	/** @type {string[]} */
	const inbound = []
	/** @type {((line: string) => void) | null} */
	let waiting = null
	const counters = { pings: 0 }

	ws.on('message', raw => {
		const line = raw.toString()
		if (line === '') {
			counters.pings++
		} else if (waiting) {
			const w = waiting
			waiting = null
			w(line)
		} else {
			inbound.push(line)
		}
	})
	await once(ws, 'open')

	return {
		ws,
		counters,
		send: messages => ws.send(JSON.stringify(messages)),
		// An empty frame on the wire is the protocol-level pong.
		pong: () => ws.send(''),
		/** @returns {Promise<string>} */
		nextFrame: () =>
			new Promise(resolve => {
				const line = inbound.shift()
				if (line !== undefined) resolve(line)
				else waiting = resolve
			}),
		close: () => ws.close(),
	}
}

/** Resolve with the HTTP status a rejected upgrade to `url` gets. */
function rejectedStatus(url) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url)
		ws.on('open', () => {
			ws.close()
			reject(new Error(`expected ${url} to be rejected`))
		})
		ws.on('unexpected-response', (_req, res) => {
			resolve(res.statusCode)
			ws.terminate()
		})
		ws.on('error', () => {})
	})
}

// ------------------------------------------------------------------
// Handshake / wire basics
// ------------------------------------------------------------------

describe('integration: handshake + emit', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('client emit lands on the matching server handler', async () => {
		/** @type {any} */
		let received
		s.server.events.greet = (sock, data, reply) => {
			received = { sock, data, reply: !!reply }
		}

		client = await bootClient(s.url)
		await client.send([['greet', 'hello']])

		await waitFor(() => received != null)
		assert.ok(received, 'server.events.greet should have fired')
		assert.equal(received.data, 'hello')
		assert.equal(received.reply, false, 'no callback id sent')
	})
})

describe('integration: round-trip with callback', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('reply() sends a result back to the client', async () => {
		s.server.events.shout = (_sock, data, reply) => {
			reply(data.toUpperCase())
		}

		client = await bootClient(s.url)
		const cbId = 7
		await client.send([['shout', 'hi', cbId]])

		const line = await client.nextFrame()
		assert.deepEqual(JSON.parse(line), [['', [cbId, ['HI']]]])
	})

	it('reply() drops second call and logs', async () => {
		const origError = console.error
		/** @type {any[]} */
		const logged = []
		console.error = (...args) => logged.push(args)

		try {
			s.server.events.twice = (_sock, _data, reply) => {
				reply('first')
				reply('second')
			}

			await client.send([['twice', null, 8]])
			await waitFor(() => logged.length > 0)
			const msg = String(logged[0][0])
			assert.match(msg, /reply\(\) already called/)
			assert.match(msg, /"twice"/)

			// First reply still landed correctly; second was dropped.
			const line = await client.nextFrame()
			assert.deepEqual(JSON.parse(line), [['', [8, ['first']]]])
		} finally {
			console.error = origError
		}
	})
})

describe('integration: server-initiated emit', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('Server.emit reaches the client', async () => {
		s.server.hooks.connect = sock => {
			sock.emit('welcome', { hi: 'there' })
		}

		client = await bootClient(s.url)
		const line = await client.nextFrame()
		assert.deepEqual(JSON.parse(line), [['welcome', { hi: 'there' }]])
	})
})

describe('integration: disconnect lifecycle', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		await s.stop()
	})

	it('hooks.disconnect fires when the client closes', async () => {
		let disconnected = false
		s.server.hooks.disconnect = () => {
			disconnected = true
		}

		client = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 1)
		client.close()
		await waitFor(() => disconnected, 80)
		assert.equal(disconnected, true)
	})
})

// ------------------------------------------------------------------
// URL params + URL-pack
// ------------------------------------------------------------------

describe('integration: URL params', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('socket.params reflects the connect URL query string', async () => {
		/** @type {any} */
		let captured
		s.server.hooks.connect = sock => {
			captured = sock.params
		}

		client = await bootClient(
			`${s.baseUrl}/angelia?room=lobby&user=tito`,
		)
		await waitFor(() => captured != null)
		assert.deepEqual(captured, { room: 'lobby', user: 'tito' })
	})
})

// ------------------------------------------------------------------
// Path filtering
// ------------------------------------------------------------------

describe('integration: path filtering', () => {
	let s

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		await s.stop()
	})

	it('accepts /angelia (with and without query); rejects every other path', async () => {
		const accepted = []
		s.server.hooks.connect = sock => accepted.push({ ...sock.params })

		// Accepted: bare path and path with query string.
		const c1 = await bootClient(`${s.baseUrl}/angelia`)
		const c2 = await bootClient(`${s.baseUrl}/angelia?room=lobby&n=2`)
		await waitFor(() => accepted.length === 2)
		assert.deepEqual(accepted[0], {})
		assert.deepEqual(accepted[1], { room: 'lobby', n: '2' })
		c1.close()
		c2.close()

		// Rejected: extra segments, unrelated paths, root.
		const rejectedPaths = [
			'/angelia/extra',
			'/something-else',
			'/foo/bar?x=1',
			'/',
		]
		for (const p of rejectedPaths) {
			const status = await rejectedStatus(`${s.baseUrl}${p}`)
			assert.ok(
				status >= 400,
				`expected ${p} to be rejected at handshake, got ${status}`,
			)
		}

		// Server must not have served any of the rejected attempts —
		// the only sockets it ever saw were the two accepted clients.
		assert.equal(s.server.served, 2)
	})
})

describe('integration: URL-pack on connect', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('messages encoded in ?m= dispatch immediately on connect', async () => {
		/** @type {any[]} */
		const seen = []
		s.server.events.early = (_sock, data) => seen.push(data)

		const packed = encodeURIComponent(
			JSON.stringify([
				['early', 1],
				['early', 2],
			]),
		)
		client = await bootClient(`${s.baseUrl}/angelia?m=${packed}`)

		await waitFor(() => seen.length === 2)
		assert.deepEqual(seen, [1, 2])
	})

	it('strips m from socket.params before connect fires', async () => {
		/** @type {any} */
		let paramsAt
		s.server.hooks.connect = sock => {
			paramsAt = { ...sock.params }
		}
		s.server.events.early = () => {}

		const packed = encodeURIComponent(
			JSON.stringify([['early', 'x']]),
		)
		const c2 = await bootClient(
			`${s.baseUrl}/angelia?room=r1&m=${packed}`,
		)
		try {
			await waitFor(() => paramsAt != null)
			assert.deepEqual(paramsAt, { room: 'r1' })
			assert.equal('m' in paramsAt, false)
		} finally {
			c2.close()
		}
	})
})

describe('integration: URL-packed messages edge cases', () => {
	let s

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		await s.stop()
	})

	const packedUrl = messages =>
		`${s.baseUrl}/angelia?m=${encodeURIComponent(JSON.stringify(messages))}`

	it('counts the packed bytes in bytesReceived', async () => {
		s.server.hooks.connect = undefined
		s.server.events.early = () => {}
		const before = s.server.bytesReceived
		const json = JSON.stringify([['early', 'héllo']])
		const client = await bootClient(packedUrl([['early', 'héllo']]))
		try {
			await waitFor(() => s.server.sockets.size === 1)
			assert.equal(s.server.bytesReceived - before, Buffer.byteLength(json))
			const [sock] = s.server.sockets
			assert.equal(sock.bytesReceived, Buffer.byteLength(json))
		} finally {
			client.close()
			await waitFor(() => s.server.sockets.size === 0)
		}
	})

	it('does not dispatch packed messages when connect disconnects the socket', async () => {
		const seen = []
		s.server.events.early = (_sock, data) => seen.push(data)
		s.server.hooks.connect = sock => sock.disconnect(true)
		const client = await bootClient(packedUrl([['early', 1]]))
		try {
			await waitFor(() => s.server.sockets.size === 0)
			await new Promise(r => setTimeout(r, 50))
			assert.deepEqual(seen, [])
		} finally {
			client.close()
			s.server.hooks.connect = undefined
		}
	})

	it('routes a non-array or unparsable `m` to garbage', async () => {
		const garbage = []
		s.server.hooks.garbage = (_sock, m) => garbage.push(m)
		const origLog = console.log
		console.log = () => {}
		try {
			const a = await bootClient(`${s.baseUrl}/angelia?m=${encodeURIComponent('{"x":1}')}`)
			const b = await bootClient(`${s.baseUrl}/angelia?m=not-json`)
			await waitFor(() => garbage.length === 2)
			assert.deepEqual(garbage.sort(), ['not-json', '{"x":1}'])
			a.close()
			b.close()
		} finally {
			console.log = origLog
			s.server.hooks.garbage = undefined
		}
	})
})

// ------------------------------------------------------------------
// Server.on(Class)
// ------------------------------------------------------------------

describe('integration: Server.on(Class)', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('class methods become event handlers receiving real sockets', async () => {
		const calls = []
		class Chat {
			typing(sock, value) {
				calls.push(['typing', sock.constructor.name, value])
			}
			theMessage(_sock, value, reply) {
				reply(value.toUpperCase())
			}
		}
		s.server.on(Chat)

		client = await bootClient(s.url)
		await client.send([['typing', true]])
		await client.send([['theMessage', 'yo', 11]])

		await waitFor(() => calls.length === 1)
		assert.deepEqual(calls[0], ['typing', 'Socket', true])

		const reply = await client.nextFrame()
		assert.deepEqual(JSON.parse(reply), [['', [11, ['YO']]]])
	})
})

// ------------------------------------------------------------------
// Multi-client broadcast
// ------------------------------------------------------------------

describe('integration: multi-client emit + broadcast', () => {
	let s, a, b

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		a?.close()
		b?.close()
		await s.stop()
	})

	it('Server.emit reaches every connected client', async () => {
		a = await bootClient(s.url)
		b = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 2)

		s.server.emit('ping', 1)

		const [la, lb] = await Promise.all([
			a.nextFrame(),
			b.nextFrame(),
		])
		assert.deepEqual(JSON.parse(la), [['ping', 1]])
		assert.deepEqual(JSON.parse(lb), [['ping', 1]])
	})

	it('Server.broadcast(me, ...) skips the sender', async () => {
		await waitFor(() => s.server.sockets.size === 2)
		const [first, second] = s.server.sockets
		s.server.broadcast(first, 'tick', 2)

		const lb = await b.nextFrame()
		assert.deepEqual(JSON.parse(lb), [['tick', 2]])

		// `first` (a) should NOT have received it. Race a brief deadline.
		const got = await Promise.race([
			a.nextFrame(),
			new Promise(r => setTimeout(() => r(null), 100)),
		])
		assert.equal(got, null, 'sender must not receive its own broadcast')
		void second
	})

	it('multiple emits in the same tick batch into one frame', async () => {
		await waitFor(() => s.server.sockets.size === 2)

		// Three emits, same tick. processQueue runs on next-tick and
		// flushes them all into a single frame.
		s.server.emit('m', 1)
		s.server.emit('m', 2)
		s.server.emit('m', 3)

		const [la, lb] = await Promise.all([
			a.nextFrame(),
			b.nextFrame(),
		])
		assert.deepEqual(JSON.parse(la), [
			['m', 1],
			['m', 2],
			['m', 3],
		])
		assert.deepEqual(JSON.parse(lb), [
			['m', 1],
			['m', 2],
			['m', 3],
		])
	})

	it('same-payload emit to N sockets reuses the cached encoded frame', async () => {
		await waitFor(() => s.server.sockets.size === 2)
		const before = s.server.messagesSentCacheHit
		s.server.emit('cached', 'value')
		await Promise.all([a.nextFrame(), b.nextFrame()])
		// Two sockets, same array → second call is a cache hit.
		assert.equal(s.server.messagesSentCacheHit, before + 1)
	})
})

describe('integration: multi-message client → server', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('three batched messages arrive in order via one server dispatch', async () => {
		const seen = []
		let batches = 0
		s.server.hooks.incoming = (_sock, msgs) => batches++
		s.server.events.x = (_sock, v) => seen.push(v)

		client = await bootClient(s.url)
		await client.send([
			['x', 1],
			['x', 2],
			['x', 3],
		])

		await waitFor(() => seen.length === 3)
		assert.deepEqual(seen, [1, 2, 3])
		assert.equal(batches, 1, 'single inbound frame')
	})
})

// ------------------------------------------------------------------
// Garbage frames
// ------------------------------------------------------------------

describe('integration: skipUTF8Validation', () => {
	// "é" is 0xC3 0xA9; a lone 0xC3 is invalid UTF-8.
	const invalid = Buffer.from([0x5b, 0x5b, 0x22, 0x78, 0x22, 0x2c, 0x22, 0xc3, 0x22, 0x5d, 0x5d])

	it('accepts invalid UTF-8 by default, decoding it to U+FFFD', async () => {
		const s = await bootServer()
		try {
			const seen = []
			s.server.events.x = (_sock, data) => seen.push(data)
			const client = await bootClient(s.url)
			client.ws.send(invalid, { binary: false })
			await waitFor(() => seen.length === 1)
			assert.deepEqual(seen, ['�'])
			client.close()
		} finally {
			await s.stop()
		}
	})

	it('closes the connection with 1007 when validation is on', async () => {
		const s = new Server()
		const port = await freePort()
		await s.listen({ port, skipUTF8Validation: false })
		try {
			const client = await bootClient(`ws://127.0.0.1:${port}/angelia`)
			const closed = once(client.ws, 'close')
			client.ws.send(invalid, { binary: false })
			const [code] = await closed
			assert.equal(code, 1007)
		} finally {
			await s.stop()
		}
	})
})

describe('integration: malformed and reserved messages', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('routes malformed messages to garbage instead of crashing', async () => {
		const garbage = []
		const errors = []
		s.server.hooks.garbage = (_sock, m) => garbage.push(m)
		s.server.events.ok = (_sock, v) => garbage.push(['ok', v])
		const origError = console.error
		console.error = (...a) => errors.push(a)
		try {
			client = await bootClient(s.url)
			await waitFor(() => s.server.sockets.size === 1)
			const [sock] = s.server.sockets
			// A live callback, so a reply with non-array args reaches it.
			sock.emit('ask', 1, () => {})
			const ask = JSON.parse(await client.nextFrame())
			const cbId = ask[0][2]

			client.send([
				null,
				5,
				'str',
				[],
				[123, 'x'],
				['', null],
				['', 'x'],
				['', [cbId, 5]],
				['', ['1', []]],
				['ok', 'still dispatched'],
			])
			await waitFor(() => garbage.length === 10)
			assert.deepEqual(garbage, [
				null,
				5,
				'str',
				[],
				[123, 'x'],
				['', null],
				['', 'x'],
				['', [cbId, 5]],
				['', ['1', []]],
				['ok', 'still dispatched'],
			])
			assert.equal(s.server.sockets.size, 1, 'socket still connected')
		} finally {
			console.error = origError
			s.server.hooks.garbage = undefined
		}
	})

	it('clients cannot fire lifecycle events', async () => {
		const fired = []
		const garbage = []
		for (const name of ['listen', 'connect', 'disconnect', 'ping', 'timeout', 'incoming', 'outgoing']) {
			s.server.hooks[name] = () => fired.push(name)
		}
		s.server.hooks.garbage = (_sock, m) => garbage.push(m[0])
		try {
			const c = await bootClient(s.url)
			await waitFor(() => fired.includes('connect'))
			fired.length = 0
			c.send([
				['listen'],
				['connect', {}],
				['disconnect'],
				['ping'],
				['timeout', 1],
				['garbage', 1],
				['incoming', []],
				['outgoing', []],
			])
			await waitFor(() => garbage.length === 8)
			assert.deepEqual(garbage, [
				'listen',
				'connect',
				'disconnect',
				'ping',
				'timeout',
				'garbage',
				'incoming',
				'outgoing',
			])
			// `incoming` is the server's own hook for the batch, not the client's.
			assert.deepEqual(fired, ['incoming'])
			c.close()
			await waitFor(() => s.server.sockets.size <= 1)
		} finally {
			for (const name of ['listen', 'connect', 'disconnect', 'ping', 'timeout', 'incoming', 'outgoing', 'garbage']) {
				s.server.hooks[name] = undefined
			}
		}
	})
})

describe('integration: garbage messages', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('non-array payloads are routed to hooks.garbage', async () => {
		const garbage = []
		s.server.hooks.garbage = (_sock, m) => garbage.push(m)

		client = await bootClient(s.url)
		// Object instead of array — server treats it as garbage.
		await client.send({ not: 'an-array' })

		await waitFor(() => garbage.length > 0)
		assert.deepEqual(garbage[0], { not: 'an-array' })
		assert.ok(s.server.messagesGarbage >= 1)
	})
})

// ------------------------------------------------------------------
// Rooms / Room
// ------------------------------------------------------------------

describe('integration: Rooms.join / Room.emit', () => {
	let s, a, b

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		a?.close()
		b?.close()
		await s.stop()
	})

	it('two clients joining the same room receive Room.emit; outsider does not', async () => {
		const created = []
		const joined = []
		class R extends Room {
			onCreate(sock) {
				created.push([this.id, sock.ip])
			}
			onJoin(sock) {
				joined.push([this.id, sock.ip])
			}
		}
		const rooms = new Rooms(R)

		s.server.hooks.connect = (sock, request) => {
			const room = new URL(
				request.url,
				'https://x',
			).searchParams.get('room')
			if (room) rooms.join(sock, room)
		}

		a = await bootClient(`${s.baseUrl}/angelia?room=lobby`)
		b = await bootClient(`${s.baseUrl}/angelia?room=lobby`)
		const c = await bootClient(`${s.baseUrl}/angelia?room=other`)

		try {
			await waitFor(() => s.server.sockets.size === 3)
			await waitFor(() => joined.length === 3)

			const lobby = rooms.get('lobby')
			const other = rooms.get('other')
			assert.ok(lobby && other)
			assert.equal(rooms.rooms.size, 2)
			assert.equal(lobby.sockets.size, 2)
			assert.equal(other.sockets.size, 1)
			assert.equal(created.length, 2)

			lobby.emit('news', 'hello-lobby')

			const [la, lb] = await Promise.all([
				a.nextFrame(),
				b.nextFrame(),
			])
			assert.deepEqual(JSON.parse(la), [['news', 'hello-lobby']])
			assert.deepEqual(JSON.parse(lb), [['news', 'hello-lobby']])

			// `c` joined a different room; nothing should arrive.
			const cGot = await Promise.race([
				c.nextFrame(),
				new Promise(r => setTimeout(() => r(null), 100)),
			])
			assert.equal(
				cGot,
				null,
				'non-member must not receive room emit',
			)
		} finally {
			c.close()
		}
	})
})

describe('integration: Room.broadcast', () => {
	let s, a, b

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		a?.close()
		b?.close()
		await s.stop()
	})

	it('Room.broadcast(me, ...) reaches members but skips me', async () => {
		const rooms = new Rooms(Room)
		s.server.hooks.connect = sock => rooms.join(sock, 'r1')

		a = await bootClient(s.url)
		b = await bootClient(s.url)
		await waitFor(() => rooms.get('r1')?.sockets.size === 2)

		const r1 = rooms.get('r1')
		assert.ok(r1)
		const [first] = r1.sockets
		r1.broadcast(first, 'pong', 9)

		const lb = await b.nextFrame()
		assert.deepEqual(JSON.parse(lb), [['pong', 9]])

		const aGot = await Promise.race([
			a.nextFrame(),
			new Promise(r => setTimeout(() => r(null), 100)),
		])
		assert.equal(aGot, null, 'sender must not receive')
	})
})

describe('integration: room cleanup on disconnect', () => {
	let s, a, b

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		await s.stop()
	})

	it('last leave deletes the room and fires onDelete; onLeave fires per-socket', async () => {
		const left = []
		const deleted = []
		class R extends Room {
			onLeave(sock) {
				left.push(sock.ip)
			}
			onDelete() {
				deleted.push(this.id)
			}
		}
		const rooms = new Rooms(R)
		s.server.hooks.connect = sock => rooms.join(sock, 'tmp')

		a = await bootClient(s.url)
		b = await bootClient(s.url)
		await waitFor(() => rooms.get('tmp')?.sockets.size === 2)

		a.close()
		await waitFor(() => left.length === 1)
		assert.ok(rooms.get('tmp'), 'room still exists with one member')

		b.close()
		await waitFor(() => deleted.length === 1)
		assert.equal(rooms.get('tmp'), undefined)
		assert.deepEqual(deleted, ['tmp'])
		assert.equal(left.length, 2)
	})
})

describe('integration: joining after disconnect', () => {
	let s

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		await s.stop()
	})

	it('a socket that closed before an async join is not added to rooms', async () => {
		const rooms = new Rooms(Room)
		const lobby = new Room()
		/** @type {(v?: unknown) => void} */
		let authDone = () => {}
		const auth = new Promise(r => (authDone = r))
		s.server.hooks.connect = async sock => {
			await auth
			rooms.join(sock, 'r')
			lobby.join(sock)
		}
		const c = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 1)
		c.close()
		await waitFor(() => s.server.sockets.size === 0)

		authDone()
		await new Promise(r => setTimeout(r, 20))
		assert.equal(rooms.get('r'), undefined, 'no room created')
		assert.equal(lobby.sockets.size, 0)
		s.server.hooks.connect = undefined
	})
})

describe('integration: Rooms fan-out with a socket in several rooms', () => {
	let s, a

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		a?.close()
		await s.stop()
	})

	it('delivers once and lists the socket once', async () => {
		const rooms = new Rooms(Room)
		s.server.hooks.connect = sock => {
			rooms.join(sock, 'one')
			rooms.join(sock, 'two')
		}
		a = await bootClient(s.url)
		await waitFor(() => rooms.rooms.size === 2)
		assert.equal(rooms.sockets.size, 1)

		rooms.emit('news', 1)
		assert.deepEqual(JSON.parse(await a.nextFrame()), [['news', 1]])
		s.server.hooks.connect = undefined
	})
})

describe('integration: persistent rooms', () => {
	let s, a

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		await s.stop()
	})

	it('persistent rooms survive when the last member leaves', async () => {
		class P extends Room {
			persistent = true
		}
		const rooms = new Rooms(P)
		s.server.hooks.connect = sock => rooms.join(sock, 'lobby')

		a = await bootClient(s.url)
		await waitFor(() => rooms.get('lobby')?.sockets.size === 1)

		a.close()
		await waitFor(() => rooms.get('lobby')?.sockets.size === 0)
		const lobby = rooms.get('lobby')
		assert.ok(lobby, 'persistent room must survive empty')
		assert.equal(lobby.sockets.size, 0)
	})
})

// ------------------------------------------------------------------
// Server-side reply callback
// ------------------------------------------------------------------

describe('integration: server-side emit with callback', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('socket.emit(k, v, cb) round-trips a reply from the client', async () => {
		client = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 1)
		const [sock] = s.server.sockets

		const replyP = new Promise(resolve => {
			sock.emit('ask', 'who?', resolve)
		})

		// Client receives ['ask', 'who?', cbId]; reply with empty key
		// + [cbId, [args]].
		const line = await client.nextFrame()
		const parsed = JSON.parse(line)
		assert.equal(parsed[0][0], 'ask')
		assert.equal(parsed[0][1], 'who?')
		const cbId = parsed[0][2]
		assert.equal(typeof cbId, 'number')

		await client.send([['', [cbId, ['me']]]])
		const got = await replyP
		assert.equal(got, 'me')
	})
})

// ------------------------------------------------------------------
// Predefined server hooks
// ------------------------------------------------------------------

describe('integration: hooks.listen', () => {
	it('fires once when listen() succeeds', async () => {
		const s = new Server()
		let fired = 0
		s.hooks.listen = () => fired++
		const port = await freePort()
		await s.listen({ port })
		assert.equal(fired, 1)
		await s.stop()
	})
})

describe('integration: hooks.ping', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('fires when the client replies with an empty-frame pong', async () => {
		const pinged = []
		s.server.hooks.ping = sock => pinged.push(sock)

		client = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 1)
		const [sock] = s.server.sockets

		// Drive the heartbeat sweep manually: backdate `seen` past
		// `timeoutCheck` so `ping()` picks this socket (but not past
		// `timeout`, which would kick it instead).
		sock.seen = s.server.now - s.server.timeoutCheck - 100
		s.server.ping()
		await client.pong()
		await waitFor(() => pinged.length === 1)
		assert.deepEqual(pinged, [sock])
		assert.ok(sock.ping >= 0, 'ping rtt populated')
	})
})

describe('integration: hooks.timeout', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('fires for a socket whose `seen` exceeds `timeout`', async () => {
		client = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 1)
		const [sock] = s.server.sockets

		const fired = []
		s.server.hooks.timeout = (sk, delay) => fired.push([sk, delay])

		// Simulate a stale client: backdate `seen` past the timeout
		// window, then trigger the ping check synchronously.
		sock.seen = s.server.now - (s.server.timeout + 1)
		s.server.ping()

		assert.equal(fired.length, 1)
		assert.equal(fired[0][0], sock)
		assert.ok(fired[0][1] > s.server.timeout)
		assert.equal(sock.timedout, true)
	})
})

describe('integration: hooks.incoming + hooks.outgoing', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('incoming sees client batches; outgoing sees server batches', async () => {
		const incoming = []
		const outgoing = []
		s.server.hooks.incoming = (_sock, msgs) => incoming.push(msgs)
		s.server.hooks.outgoing = (_sock, msgs) => outgoing.push(msgs)
		s.server.events.x = () => {}

		client = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 1)

		await client.send([
			['x', 1],
			['x', 2],
		])
		await waitFor(() => incoming.length === 1)
		assert.deepEqual(incoming[0], [
			['x', 1],
			['x', 2],
		])

		s.server.emit('y', 'hi')
		await client.nextFrame()
		assert.equal(outgoing.length, 1)
		// outgoing batches are arrays of [k, v] tuples; the cache symbol
		// gets attached but doesn't affect deepEqual on JSON-shaped data.
		assert.equal(outgoing[0][0][0], 'y')
		assert.equal(outgoing[0][0][1], 'hi')
	})
})

describe('integration: Server.on(Class) chaining', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('two listener classes with the same method both fire', async () => {
		const calls = []
		class A {
			ding() {
				calls.push('a')
			}
		}
		class B {
			ding() {
				calls.push('b')
			}
		}
		s.server.on(A)
		s.server.on(B)

		client = await bootClient(s.url)
		await client.send([['ding', 1]])
		await waitFor(() => calls.length === 2)
		assert.deepEqual(calls.sort(), ['a', 'b'])
	})
})

// ------------------------------------------------------------------
// Rooms.emit / Rooms.broadcast (live)
// ------------------------------------------------------------------

describe('integration: Rooms.emit / Rooms.broadcast', () => {
	let s, a, b, rooms

	before(async () => {
		s = await bootServer()
		rooms = new Rooms(Room)
		s.server.hooks.connect = (sock, request) => {
			const id = new URL(request.url, 'https://x').searchParams.get(
				'r',
			)
			rooms.join(sock, id || 'default')
		}
	})
	after(async () => {
		a?.close()
		b?.close()
		await s.stop()
	})

	it('Rooms.emit fans out to every member across every room', async () => {
		a = await bootClient(`${s.baseUrl}/angelia?r=r1`)
		b = await bootClient(`${s.baseUrl}/angelia?r=r2`)
		await waitFor(() => rooms.rooms.size === 2)

		rooms.emit('all', 1)
		const [la, lb] = await Promise.all([
			a.nextFrame(),
			b.nextFrame(),
		])
		assert.deepEqual(JSON.parse(la), [['all', 1]])
		assert.deepEqual(JSON.parse(lb), [['all', 1]])
	})

	it('Rooms.broadcast(me, ...) skips the sender across all rooms', async () => {
		const [first] = s.server.sockets
		rooms.broadcast(first, 'tick', 9)

		const lb = await b.nextFrame()
		assert.deepEqual(JSON.parse(lb), [['tick', 9]])
		const aGot = await Promise.race([
			a.nextFrame(),
			new Promise(r => setTimeout(() => r(null), 100)),
		])
		assert.equal(aGot, null, 'sender must not receive')
	})
})

// ------------------------------------------------------------------
// Server-initiated disconnect
// ------------------------------------------------------------------

describe('integration: server-initiated disconnect', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		await s.stop()
	})

	it('socket.disconnect(true) sends a `disconnect` frame then closes', async () => {
		s.server.hooks.connect = sock => {
			// Defer slightly so the client has a chance to install its
			// reader before the server hangs up.
			setTimeout(() => sock.disconnect(true), 30)
		}

		client = await bootClient(s.url)

		const line = await client.nextFrame()
		assert.deepEqual(JSON.parse(line), [['', 'disconnect']])

		// Session should close shortly after.
		await waitFor(() => s.server.sockets.size === 0)
		assert.equal(s.server.sockets.size, 0)
	})
})

// ------------------------------------------------------------------
// Drain-loop robustness
// ------------------------------------------------------------------

describe('integration: emit on a closed socket', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('does not crash the server when the connection is already gone', async () => {
		const c1 = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 1)
		const [stale] = s.server.sockets

		// Client disconnects; app keeps a stale socket reference.
		c1.close()
		await waitFor(() => s.server.sockets.size === 0)

		const sentBefore = s.server.messagesSent
		stale.emit('bye', 1)
		await new Promise(r => setTimeout(r, 50))
		assert.equal(s.server.messagesSent, sentBefore)

		// Server still fully functional for new clients.
		let got
		s.server.events.stillAlive = (_sock, data) => {
			got = data
		}
		client = await bootClient(s.url)
		client.send([['stillAlive', 'yes']])
		await waitFor(() => got != null)
		assert.equal(got, 'yes')
	})
})

describe('integration: hooks.outgoing enqueues mid-drain', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('socket keeps draining when outgoing() emits during a drain', async () => {
		client = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 1)
		const [sock] = s.server.sockets

		let hooked = false
		s.server.hooks.outgoing = socket => {
			if (!hooked) {
				hooked = true
				socket.emit('from-hook', 1)
			}
		}

		sock.emit('a', 1)

		assert.deepEqual(JSON.parse(await client.nextFrame()), [['a', 1]])
		assert.deepEqual(JSON.parse(await client.nextFrame()), [
			['from-hook', 1],
		])

		// And the socket must still drain future emits.
		sock.emit('later', 3)
		assert.deepEqual(JSON.parse(await client.nextFrame()), [
			['later', 3],
		])
	})
})

// ------------------------------------------------------------------
// Cert reload (path-based listen + watcher)
// ------------------------------------------------------------------

describe('integration: TLS + cert reload', () => {
	/** @type {string} */
	let tempDir
	/** @type {string} */
	let certPath
	/** @type {string} */
	let keyPath

	/** Write a fresh self-signed cert/key pair over `certPath`/`keyPath`. */
	const generateCert = () =>
		execFileSync(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'ec',
				'-pkeyopt',
				'ec_paramgen_curve:prime256v1',
				'-nodes',
				'-days',
				'1',
				'-subj',
				'/CN=localhost',
				'-addext',
				'subjectAltName=IP:127.0.0.1',
				'-keyout',
				keyPath,
				'-out',
				certPath,
			],
			{ stdio: 'ignore' },
		)

	/** Connect over wss trusting the cert currently on disk. */
	const bootTlsClient = async port => {
		const ca = readFileSync(certPath)
		const client = await bootClient(`wss://127.0.0.1:${port}/angelia`, {
			ca,
		})
		return client
	}

	/** Silence and capture console.error while `fn` runs. */
	const captureErrors = async fn => {
		const origError = console.error
		/** @type {any[][]} */
		const errs = []
		console.error = (...a) => errs.push(a)
		try {
			await fn()
		} finally {
			console.error = origError
		}
		return errs
	}

	before(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'angelia-cert-'))
		certPath = join(tempDir, 'cert.pem')
		keyPath = join(tempDir, 'key.pem')
		generateCert()
	})
	after(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it('serves wss when cert and privKey are given', async () => {
		const s = new Server()
		const port = await freePort()
		await s.listen({ port, cert: certPath, privKey: keyPath })
		try {
			const client = await bootTlsClient(port)
			await waitFor(() => s.sockets.size === 1)
			assert.equal(s.sockets.size, 1)
			client.close()
		} finally {
			await s.stop()
		}
	})

	it('rejects listen() with only one of cert / privKey', async () => {
		const s = new Server()
		await assert.rejects(
			s.listen({ port: 0, cert: certPath }),
			/both `cert` and `privKey`/,
		)
	})

	it('reloadCerts() swaps the cert in place without dropping connections', async () => {
		const s = new Server()
		const port = await freePort()
		await s.listen({ port, cert: certPath, privKey: keyPath })
		try {
			const before = await bootTlsClient(port)
			await waitFor(() => s.sockets.size === 1)

			generateCert()
			await s.reloadCerts()

			// Trusting only the new cert proves new handshakes use it.
			const afterReload = await bootTlsClient(port)
			await waitFor(() => s.sockets.size === 2)
			assert.equal(s.sockets.size, 2)
			assert.equal(before.ws.readyState, WebSocket.OPEN)

			before.close()
			afterReload.close()
		} finally {
			await s.stop()
		}
	})

	it('reloadCerts() keeps the current cert when files cannot be read or parsed', async () => {
		const s = new Server()
		const port = await freePort()
		await s.listen({ port, cert: certPath, privKey: keyPath })
		const goodCert = readFileSync(certPath)
		try {
			rmSync(certPath)
			const missing = await captureErrors(() => s.reloadCerts())
			assert.ok(
				missing.some(e => /cert reload skipped/i.test(String(e[0]))),
				'expected a "skipped" log line for a missing file',
			)

			writeFileSync(certPath, 'not a cert')
			const invalid = await captureErrors(() => s.reloadCerts())
			assert.ok(
				invalid.some(e => /invalid cert/i.test(String(e[0]))),
				'expected an "invalid" log line for a garbage file',
			)

			// The original cert is still the one being served.
			writeFileSync(certPath, goodCert)
			const client = await bootTlsClient(port)
			await waitFor(() => s.sockets.size === 1)
			client.close()
		} finally {
			await s.stop()
		}
	})

	it('watch: true triggers reloadCerts() when the cert file changes', async () => {
		const s = new Server()
		const port = await freePort()
		await s.listen({
			port,
			cert: certPath,
			privKey: keyPath,
			watch: true,
			watchDebounceMs: 100,
		})

		let reloadCalls = 0
		s.reloadCerts = async () => {
			reloadCalls++
		}

		writeFileSync(certPath, readFileSync(certPath))

		await waitFor(() => reloadCalls > 0, 40)
		assert.ok(reloadCalls >= 1, 'expected at least one reload trigger')

		await s.stop()
	})
})

describe('integration: server emit with a callback', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	/** Answer every callback-bearing frame with `answer(value)`. */
	const autoReply = (c, answer) =>
		c.ws.on('message', raw => {
			const text = raw.toString()
			if (text === '') return
			for (const [, value, id] of JSON.parse(text)) {
				if (id) c.send([['', [id, [answer(value)]]]])
			}
		})

	it('returns a promise for the callback result and frees the slot', async () => {
		client = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 1)
		autoReply(client, v => v * 2)
		const [sock] = s.server.sockets

		const doubled = await sock.emit('double', 21, r => r + 1)
		assert.equal(doubled, 43)
		assert.equal(sock.callbacks.size, 0)
	})

	it('rejects at once when the socket is already closed', async () => {
		const c = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 2)
		const sock = [...s.server.sockets].at(-1)
		c.close()
		await waitFor(() => sock.closed)
		await assert.rejects(sock.request('late', 1), /disconnected/)
		assert.equal(sock.callbacks.size, 0)
	})

	it('rejects pending replies when the socket closes, without crashing callback-only callers', async () => {
		const c = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 2)
		const sock = [...s.server.sockets].at(-1)

		const awaited = sock.emit('never', 1, () => 'unused')
		// Callback style only: its rejection must not go unhandled.
		sock.emit('never', 2, () => {})
		sock.disconnect()
		await assert.rejects(awaited, /disconnected/)
		assert.equal(sock.callbacks.size, 0)
		c.close()
	})
})

describe('integration: disconnect code and reason', () => {
	let s

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		await s.stop()
	})

	it('passes the close code and reason to the disconnect hook', async () => {
		const closes = []
		s.server.hooks.disconnect = (_sock, code, reason) =>
			closes.push([code, reason])

		const a = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 1)
		a.ws.close(4000, 'client bye')
		await waitFor(() => closes.length === 1)

		const b = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 1)
		const [sock] = s.server.sockets
		sock.disconnect(false, 'kicked')
		await waitFor(() => closes.length === 2)

		const c = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 1)
		const [stale] = s.server.sockets
		stale.seen = s.server.now - (s.server.timeout + 1)
		s.server.ping()
		await waitFor(() => closes.length === 3)

		assert.deepEqual(closes, [
			[4000, 'client bye'],
			[1000, 'kicked'],
			[1006, ''],
		])
		b.close()
		c.close()
		s.server.hooks.disconnect = undefined
	})

	it('a reason over 123 bytes throws before anything is closed', async () => {
		const c = await bootClient(s.url)
		await waitFor(() => s.server.sockets.size === 1)
		const [sock] = s.server.sockets
		assert.throws(() => sock.disconnect(true, 'é'.repeat(62)), RangeError)
		assert.equal(sock.closed, false)
		assert.equal(c.ws.readyState, WebSocket.OPEN)
		c.close()
		await waitFor(() => s.server.sockets.size === 0)
	})
})

describe('integration: path and port options', () => {
	it('listens on a custom path and rejects the default one', async () => {
		const s = await bootServer({ path: '/chat/ws' })
		try {
			const c = await bootClient(`${s.baseUrl}/chat/ws`)
			await waitFor(() => s.server.sockets.size === 1)
			assert.equal(s.server.sockets.size, 1)
			c.close()
			assert.ok((await rejectedStatus(s.url)) >= 400)
		} finally {
			await s.stop()
		}
	})

	it('port 0 binds an OS-assigned port and reports it', async () => {
		const s = await bootServer()
		try {
			assert.ok(s.server.port > 0)
			const c = await bootClient(s.url)
			c.close()
		} finally {
			await s.stop()
		}
	})
})

describe('integration: console.log of Server and Socket', () => {
	it('shows a summary, not internals', async () => {
		const s = await bootServer()
		const rooms = new Rooms(Room)
		s.server.hooks.connect = sock => rooms.join(sock, 'lobby')
		const client = await bootClient(`${s.url}?user=tito`)
		try {
			await waitFor(() => s.server.sockets.size === 1)
			const [sock] = s.server.sockets

			const socketText = inspect(sock)
			assert.match(socketText, /^Socket \{/)
			assert.match(socketText, /ip: '127\.0\.0\.1'/)
			assert.match(socketText, /user: 'tito'/)
			assert.match(socketText, /rooms: \[ 'lobby' \]/)
			assert.doesNotMatch(socketText, /_sender|WebSocketServer|cacheSymbol/)

			const serverText = inspect(s.server)
			assert.match(serverText, /^Server \{/)
			assert.match(serverText, new RegExp(`url: 'ws://127\\.0\\.0\\.1:${s.port}/angelia'`))
			assert.match(serverText, /sockets: 1/)
			assert.match(serverText, /hooks: \[ 'connect' \]/)
			assert.doesNotMatch(serverText, /Socket \{|_sender|IncomingMessage/)
		} finally {
			client.close()
			await s.stop()
		}
	})
})
