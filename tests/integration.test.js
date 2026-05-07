/**
 * End-to-end integration tests. Boots a real Server (over QUIC) and
 * connects a real WebTransport client from `@fails-components/webtransport`.
 *
 * Requires `certs/cert.pem` + `certs/key.pem` — run `npm run gen-cert`
 * first if they don't exist.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	WebTransport,
	quicheLoaded,
} from '@fails-components/webtransport'

import serverSingleton from '../server/Server.js'
import { Room } from '../server/Room.js'
import { Rooms } from '../server/Rooms.js'

const Server = /** @type {new () => typeof serverSingleton} */ (
	/** @type {unknown} */ (serverSingleton.constructor)
)

const CERT_PATH = 'certs/cert.pem'
const KEY_PATH = 'certs/key.pem'

if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
	console.error(
		`[integration] skipping: missing ${CERT_PATH} / ${KEY_PATH}. ` +
			`Run \`npm run gen-cert\` first.`,
	)
	process.exit(0)
}

// The QUIC transport is a native binding. Probe it directly — if the
// package's `.node` file isn't built/prebuilt for this platform, the
// import itself throws.
try {
	await import(
		'@fails-components/webtransport-transport-http3-quiche'
	)
	await quicheLoaded
} catch (err) {
	console.error(
		'[integration] skipping: @fails-components/webtransport native ' +
			'transport could not load. Install build tools (g++ / build-essential) ' +
			'or run on a platform with prebuilt binaries.',
	)
	process.exit(0)
}

// PEM still loaded into memory — we need it to compute the cert hash
// for client-side pinning. The server itself now takes paths.
const cert = readFileSync(CERT_PATH, 'utf8')

/** Compute the SHA-256 of the DER form of a PEM cert (for cert-pinning). */
function certDigest(pem) {
	const b64 = pem.replace(/-----[^-]+-----|\s+/g, '')
	const der = Buffer.from(b64, 'base64')
	return new Uint8Array(createHash('sha256').update(der).digest())
}

const certHash = certDigest(cert)
const encoder = new TextEncoder()
// Per-bootClient decoders are created inside the function — `TextDecoder`
// keeps state across `{stream: true}` chunks and bootClient runs two
// pumps (control + incoming) per call, so a shared decoder would race.

let nextPort = 14000
const pickPort = () => nextPort++

/** Poll a predicate until it's truthy or `tries * 25ms` elapses. */
async function waitFor(predicate, tries = 40) {
	for (let i = 0; i < tries; i++) {
		if (predicate()) return true
		await new Promise(r => setTimeout(r, 25))
	}
	return predicate()
}

/**
 * Spin up a real Server on a fresh port. Returns the server and its
 * listening URL.
 */
async function bootServer() {
	const s = new Server()
	const port = pickPort()
	await s.listen({ port, cert: CERT_PATH, privKey: KEY_PATH })
	return {
		server: s,
		port,
		baseUrl: `https://127.0.0.1:${port}`,
		url: `https://127.0.0.1:${port}/angelia`,
		stop: () => s.stop(),
	}
}

/**
 * Open a WebTransport client to `url`, open the control stream, set
 * up newline-JSON framing on it. Returns helpers to send messages and
 * await incoming frames.
 */
async function bootClient(url) {
	// One decoder per pump — see header comment. The control pump has one
	// stream so one decoder; the incoming pump opens many streams, each
	// gets a fresh decoder inside the loop.
	const controlDecoder = new TextDecoder()

	const transport = new WebTransport(url, {
		serverCertificateHashes: [
			{ algorithm: 'sha-256', value: certHash },
		],
	})
	// Swallow the post-close rejection — node:test treats an unhandled
	// rejection (even after the test finished) as a file-level failure.
	transport.closed?.catch?.(() => {})
	await transport.ready

	const control = await transport.createBidirectionalStream()
	const writer = control.writable.getWriter()
	const reader = control.readable.getReader()

	/** @type {string[]} */
	const inbound = []
	/** @type {((line: string) => void) | null} */
	let waiting = /** @type {any} */ (null)

	;(async () => {
		let buf = ''
		try {
			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				buf += controlDecoder.decode(value, { stream: true })
				let nl
				while ((nl = buf.indexOf('\n')) !== -1) {
					const line = buf.slice(0, nl)
					buf = buf.slice(nl + 1)
					if (waiting) {
						const w = waiting
						waiting = null
						w(line)
					} else {
						inbound.push(line)
					}
				}
			}
		} catch {}
	})()

	// One persistent reader for server-initiated bidi streams (used by
	// Server.http / broadcastHttp). Each arriving stream is fully drained
	// and parsed, then queued.
	const incoming = transport.incomingUnidirectionalStreams.getReader()
	/** @type {any[]} */
	const incomingQueue = []
	let waitingIncoming = /** @type {any} */ (null)
	;(async () => {
		try {
			while (true) {
				const { value: stream, done } = await incoming.read()
				if (done) break
				const streamDecoder = new TextDecoder()
				const r = stream.getReader()
				let buf = ''
				while (true) {
					const { value, done } = await r.read()
					if (done) break
					buf += streamDecoder.decode(value, { stream: true })
				}
				// Server-side http streams now carry an array of message
				// tuples, matching the control-stream batch shape.
				const messages = JSON.parse(buf)
				for (const m of messages) {
					if (waitingIncoming) {
						const w = waitingIncoming
						waitingIncoming = null
						w(m)
					} else {
						incomingQueue.push(m)
					}
				}
			}
		} catch {}
	})()

	return {
		transport,
		send: messages =>
			writer.write(
				encoder.encode(JSON.stringify(messages) + '\n'),
			),
		// A literal '\n' frame on the wire is the protocol-level pong.
		pong: () => writer.write(encoder.encode('\n')),
		nextFrame: () =>
			new Promise(resolve => {
				if (inbound.length) resolve(inbound.shift())
				else waiting = resolve
			}),
		nextIncoming: () =>
			new Promise(resolve => {
				if (incomingQueue.length) resolve(incomingQueue.shift())
				else waitingIncoming = resolve
			}),
		http: async message => {
			// Server expects an array of message tuples on a send-only
			// stream; wrap the single test tuple so existing call sites
			// stay simple.
			const stream = await transport.createUnidirectionalStream()
			const w = stream.getWriter()
			await w.write(encoder.encode(JSON.stringify([message])))
			await w.close()
		},
		close: () => transport.close(),
	}
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

	it('reply() sends a result back over the control stream', async () => {
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
		s.server.events.connect = sock => {
			sock.emit('welcome', { hi: 'there' })
		}

		client = await bootClient(s.url)
		const line = await client.nextFrame()
		assert.deepEqual(JSON.parse(line), [['welcome', { hi: 'there' }]])
	})
})

describe('integration: http stream (out-of-band)', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('client http() opens a fresh stream and lands the message', async () => {
		/** @type {any} */
		let received
		s.server.events.bigState = (_sock, data) => {
			received = data
		}

		client = await bootClient(s.url)
		await client.http(['bigState', { rows: ['a', 'b', 'c'] }])

		await waitFor(() => received != null)
		assert.deepEqual(received, { rows: ['a', 'b', 'c'] })
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

	it('events.disconnect fires when the client closes', async () => {
		let disconnected = false
		s.server.events.disconnect = () => {
			disconnected = true
		}

		client = await bootClient(s.url)
		await waitFor(() => s.server.sockets.length === 1)
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
		s.server.events.connect = sock => {
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
		s.server.events.connect = sock => accepted.push({ ...sock.params })

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
			const t = new WebTransport(`${s.baseUrl}${p}`, {
				serverCertificateHashes: [
					{ algorithm: 'sha-256', value: certHash },
				],
			})
			// Swallow the post-close rejection so node:test doesn't flag it.
			t.closed?.catch?.(() => {})
			await assert.rejects(
				t.ready,
				/handshake|404/i,
				`expected ${p} to be rejected at handshake`,
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
		s.server.events.connect = sock => {
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
// Multi-client broadcast / http
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
		await waitFor(() => s.server.sockets.length === 2)

		s.server.emit('ping', 1)

		const [la, lb] = await Promise.all([
			a.nextFrame(),
			b.nextFrame(),
		])
		assert.deepEqual(JSON.parse(la), [['ping', 1]])
		assert.deepEqual(JSON.parse(lb), [['ping', 1]])
	})

	it('Server.broadcast(me, ...) skips the sender', async () => {
		await waitFor(() => s.server.sockets.length === 2)
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
		await waitFor(() => s.server.sockets.length === 2)

		// Three emits, same tick. processQueue runs on next-tick and
		// flushes them all into a single newline-delimited JSON frame.
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
		await waitFor(() => s.server.sockets.length === 2)
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
		s.server.events.incoming = (_sock, msgs) => batches++
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

describe('integration: multi-client http + broadcastHttp', () => {
	let s, a, b

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		a?.close()
		b?.close()
		await s.stop()
	})

	it('Server.http reaches every client over a fresh stream', async () => {
		a = await bootClient(s.url)
		b = await bootClient(s.url)
		await waitFor(() => s.server.sockets.length === 2)

		const aP = a.nextIncoming()
		const bP = b.nextIncoming()
		await s.server.http('big', { hi: 1 })

		assert.deepEqual(await aP, ['big', { hi: 1 }])
		assert.deepEqual(await bP, ['big', { hi: 1 }])
	})

	it('Server.broadcastHttp(me, ...) skips the sender', async () => {
		const [first] = s.server.sockets

		const bP = b.nextIncoming()
		await s.server.broadcastHttp(first, 'big2', { only: 'b' })
		assert.deepEqual(await bP, ['big2', { only: 'b' }])

		// `a` (== first) must not receive it.
		const aGot = await Promise.race([
			a.nextIncoming(),
			new Promise(r => setTimeout(() => r(null), 100)),
		])
		assert.equal(aGot, null, 'sender must not receive broadcastHttp')
	})
})

// ------------------------------------------------------------------
// Garbage frames
// ------------------------------------------------------------------

describe('integration: garbage messages', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.close()
		await s.stop()
	})

	it('non-array payloads are routed to events.garbage', async () => {
		const garbage = []
		s.server.events.garbage = (_sock, m) => garbage.push(m)

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

		s.server.events.connect = (sock, request) => {
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
			await waitFor(() => s.server.sockets.length === 3)
			await waitFor(() => joined.length === 3)

			const lobby = rooms.get('lobby')
			const other = rooms.get('other')
			assert.ok(lobby && other)
			assert.equal(rooms.list.length, 2)
			assert.equal(lobby.sockets.length, 2)
			assert.equal(other.sockets.length, 1)
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
		s.server.events.connect = sock => rooms.join(sock, 'r1')

		a = await bootClient(s.url)
		b = await bootClient(s.url)
		await waitFor(() => rooms.get('r1')?.sockets.length === 2)

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
		s.server.events.connect = sock => rooms.join(sock, 'tmp')

		a = await bootClient(s.url)
		b = await bootClient(s.url)
		await waitFor(() => rooms.get('tmp')?.sockets.length === 2)

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
		s.server.events.connect = sock => rooms.join(sock, 'lobby')

		a = await bootClient(s.url)
		await waitFor(() => rooms.get('lobby')?.sockets.length === 1)

		a.close()
		await waitFor(() => rooms.get('lobby')?.sockets.length === 0)
		const lobby = rooms.get('lobby')
		assert.ok(lobby, 'persistent room must survive empty')
		assert.equal(lobby.sockets.length, 0)
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
		await waitFor(() => s.server.sockets.length === 1)
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

describe('integration: events.listen', () => {
	it('fires once when listen() succeeds', async () => {
		const s = new Server()
		let fired = 0
		s.events.listen = () => fired++
		const port = pickPort()
		await s.listen({ port, cert: CERT_PATH, privKey: KEY_PATH })
		assert.equal(fired, 1)
		await s.stop()
	})
})

describe('integration: events.ping', () => {
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
		s.server.events.ping = sock => pinged.push(sock)

		client = await bootClient(s.url)
		await waitFor(() => s.server.sockets.length === 1)
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

describe('integration: events.timeout', () => {
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
		await waitFor(() => s.server.sockets.length === 1)
		const [sock] = s.server.sockets

		const fired = []
		s.server.events.timeout = (sk, delay) => fired.push([sk, delay])

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

describe('integration: events.incoming + events.outgoing', () => {
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
		s.server.events.incoming = (_sock, msgs) => incoming.push(msgs)
		s.server.events.outgoing = (_sock, msgs) => outgoing.push(msgs)
		s.server.events.x = () => {}

		client = await bootClient(s.url)
		await waitFor(() => s.server.sockets.length === 1)

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
// Rooms.emit / Rooms.broadcast / Rooms.http / Room.http (live)
// ------------------------------------------------------------------

describe('integration: Rooms.emit / Rooms.broadcast', () => {
	let s, a, b, rooms

	before(async () => {
		s = await bootServer()
		rooms = new Rooms(Room)
		s.server.events.connect = (sock, request) => {
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
		await waitFor(() => rooms.list.length === 2)

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

describe('integration: Rooms.http / Rooms.broadcastHttp / Room.http', () => {
	let s, a, b

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		a?.close()
		b?.close()
		await s.stop()
	})

	it('Rooms.http reaches every member; Rooms.broadcastHttp skips me', async () => {
		const rooms = new Rooms(Room)
		s.server.events.connect = sock => rooms.join(sock, 'r')

		a = await bootClient(s.url)
		b = await bootClient(s.url)
		await waitFor(() => rooms.get('r')?.sockets.length === 2)

		const aP = a.nextIncoming()
		const bP = b.nextIncoming()
		await rooms.http('big', { v: 1 })
		assert.deepEqual(await aP, ['big', { v: 1 }])
		assert.deepEqual(await bP, ['big', { v: 1 }])

		const [first] = s.server.sockets
		const bP2 = b.nextIncoming()
		await rooms.broadcastHttp(first, 'big2', { only: 'b' })
		assert.deepEqual(await bP2, ['big2', { only: 'b' }])
		const aSecond = await Promise.race([
			a.nextIncoming(),
			new Promise(r => setTimeout(() => r(null), 100)),
		])
		assert.equal(aSecond, null)
	})

	it('Room.http and Room.broadcastHttp on a single room', async () => {
		const room = new Room()
		// Manually push the existing two server sockets into a room
		// without going through Rooms.
		for (const sock of s.server.sockets) room.join(sock)

		const aP = a.nextIncoming()
		const bP = b.nextIncoming()
		await room.http('rh', 'all')
		assert.deepEqual(await aP, ['rh', 'all'])
		assert.deepEqual(await bP, ['rh', 'all'])

		const [first] = s.server.sockets
		const bP2 = b.nextIncoming()
		await room.broadcastHttp(first, 'rh2', 'b-only')
		assert.deepEqual(await bP2, ['rh2', 'b-only'])
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
		s.server.events.connect = sock => {
			// Defer slightly so the client has a chance to install its
			// reader before the server hangs up.
			setTimeout(() => sock.disconnect(true), 30)
		}

		client = await bootClient(s.url)

		const line = await client.nextFrame()
		assert.deepEqual(JSON.parse(line), [['disconnect', true]])

		// Session should close shortly after.
		await waitFor(() => s.server.sockets.length === 0)
		assert.equal(s.server.sockets.length, 0)
	})
})

// ------------------------------------------------------------------
// Cert reload (path-based listen + watcher)
// ------------------------------------------------------------------

describe('integration: cert reload', () => {
	/** @type {string} */
	let tempDir
	/** @type {string} */
	let tempCert
	/** @type {string} */
	let tempKey

	before(() => {
		// Mirror the repo's certs into a tempdir so tests can mutate
		// (touch / rewrite) them without affecting other test runs.
		tempDir = mkdtempSync(join(tmpdir(), 'angelia-cert-'))
		tempCert = join(tempDir, 'cert.pem')
		tempKey = join(tempDir, 'key.pem')
		copyFileSync(CERT_PATH, tempCert)
		copyFileSync(KEY_PATH, tempKey)
	})
	after(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it('listen({ cert: path, privKey: path }) reads PEM from disk', async () => {
		const s = new Server()
		const port = pickPort()
		await s.listen({ port, cert: tempCert, privKey: tempKey })
		const client = await bootClient(`https://127.0.0.1:${port}/angelia`)
		await waitFor(() => s.sockets.length === 1)
		client.close()
		await s.stop()
	})

	it('reloadCerts() restarts the server with re-read cert files', async () => {
		const s = new Server()
		const port = pickPort()
		await s.listen({ port, cert: tempCert, privKey: tempKey })

		const oldIo = s.io
		assert.ok(oldIo, 'io should be set after listen')

		await s.reloadCerts()
		assert.notEqual(s.io, oldIo, 'reload must replace the underlying server')

		// New clients still connect after the reload (port and cert
		// hash are the same, so the existing pinning still validates).
		const c = await bootClient(`https://127.0.0.1:${port}/angelia`)
		await waitFor(() => s.sockets.length === 1)
		c.close()
		await s.stop()
	})

	it('reloadCerts() is a no-op when files cannot be read', async () => {
		const s = new Server()
		const port = pickPort()
		await s.listen({ port, cert: tempCert, privKey: tempKey })
		const liveIo = s.io

		// Simulate a renewal that hasn't fully landed — make the cert
		// file unreadable by removing it, ask for a reload, then
		// restore. The live server must survive untouched.
		rmSync(tempCert)

		const origError = console.error
		/** @type {any[]} */
		const errs = []
		console.error = (...a) => errs.push(a)
		try {
			await s.reloadCerts()
		} finally {
			console.error = origError
		}

		assert.equal(s.io, liveIo, 'live server must survive a failed reload')
		assert.ok(
			errs.some(e => /cert reload skipped/i.test(String(e[0]))),
			'expected a "skipped" log line',
		)

		// Restore the cert so subsequent tests still work.
		copyFileSync(CERT_PATH, tempCert)
		await s.stop()
	})

	it('watch: true triggers reloadCerts() when the cert file changes', async () => {
		const s = new Server()
		const port = pickPort()
		await s.listen({
			port,
			cert: tempCert,
			privKey: tempKey,
			watch: true,
			watchDebounceMs: 100,
		})

		// Spy on reloadCerts to count invocations without actually
		// re-running the listen flow during this test.
		let reloadCalls = 0
		const realReload = s.reloadCerts.bind(s)
		s.reloadCerts = async () => {
			reloadCalls++
		}

		// Touch the cert file. The watcher should fire within
		// debounce + filesystem latency.
		writeFileSync(tempCert, readFileSync(tempCert))

		await waitFor(() => reloadCalls > 0, 40)
		assert.ok(reloadCalls >= 1, 'expected at least one reload trigger')

		s.reloadCerts = realReload
		await s.stop()
	})
})
