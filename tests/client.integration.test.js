/**
 * Runtime tests for the actual `client/index.js` class — boots a real
 * Server, polyfills `globalThis.WebTransport` with the Node binding,
 * then exercises the Client API end-to-end.
 *
 * Skips gracefully if the QUIC native binding can't load.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import {
	WebTransport,
	quicheLoaded,
} from '@fails-components/webtransport'

const CERT_PATH = 'certs/cert.pem'
const KEY_PATH = 'certs/key.pem'

if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
	console.error(
		`[client.integration] skipping: missing ${CERT_PATH} / ${KEY_PATH}.`,
	)
	process.exit(0)
}

try {
	await import(
		'@fails-components/webtransport-transport-http3-quiche'
	)
	await quicheLoaded
} catch {
	console.error(
		'[client.integration] skipping: native QUIC binding unavailable.',
	)
	process.exit(0)
}

// Polyfill the browser global the Client expects.
;/** @type {any} */ (globalThis).WebTransport = WebTransport

const cert = readFileSync(CERT_PATH, 'utf8')
const privKey = readFileSync(KEY_PATH, 'utf8')

const certHash = new Uint8Array(
	createHash('sha256')
		.update(
			Buffer.from(
				cert.replace(/-----[^-]+-----|\s+/g, ''),
				'base64',
			),
		)
		.digest(),
)

// Imported AFTER the polyfill so the module captures our WebTransport.
const { default: serverSingleton } = await import(
	'../server/Server.js'
)
const { default: Client } = await import('../client/index.js')

const Server = /** @type {new () => typeof serverSingleton} */ (
	/** @type {unknown} */ (serverSingleton.constructor)
)

let nextPort = 15000
const pickPort = () => nextPort++

async function bootServer() {
	const s = new Server()
	const port = pickPort()
	await s.listen({ port, cert, privKey })
	return {
		server: s,
		port,
		baseUrl: `https://127.0.0.1:${port}`,
		stop: () => s.stop(),
	}
}

/**
 * Construct a Client pointed at our server with cert pinning. Caller is
 * responsible for `client.disconnect(true)`.
 */
function makeClient(baseUrl, options = {}) {
	return new Client({
		url: baseUrl,
		serverCertificateHashes: [
			{ algorithm: 'sha-256', value: certHash },
		],
		...options,
	})
}

async function waitFor(predicate, tries = 80) {
	for (let i = 0; i < tries; i++) {
		if (predicate()) return true
		await new Promise(r => setTimeout(r, 25))
	}
	return predicate()
}

// ------------------------------------------------------------------

describe('client: connect + emit', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('Client.emit lands on the server handler; connect event fires', async () => {
		let connectCount = 0
		let received
		s.server.events.connect = () => connectCount++
		s.server.events.hi = (_sock, data) => {
			received = data
		}

		client = makeClient(s.baseUrl)

		// Pre-connect emit: must reach the server (URL-pack or post-open queue).
		client.emit('hi', 'pre-connect')

		await waitFor(() => received != null)
		assert.equal(received, 'pre-connect')
		assert.equal(connectCount, 1)

		// Post-connect emit: same flow.
		received = undefined
		client.emit('hi', 'post-connect')
		await waitFor(() => received != null)
		assert.equal(received, 'post-connect')
	})
})

describe('client: emit reply (callback)', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('emit(k, v, fn) returns a promise resolving with fn(reply)', async () => {
		s.server.events.shout = (_sock, data, reply) =>
			reply(data.toUpperCase())
		s.server.events.echo = (_sock, data, reply) => reply(data)

		client = makeClient(s.baseUrl)
		const length = await client.emit('shout', 'hello', r => r.length)
		assert.equal(length, 5)

		// emit(k, fn) shorthand — v defaults to 0
		const got = await client.emit('echo', r => r)
		assert.equal(got, 0)
	})
})

describe('client: reply() one-shot', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('throws if a client handler calls reply() more than once', async () => {
		client = makeClient(s.baseUrl)
		await waitFor(() => client.connected)

		/** @type {any} */
		let thrown
		client.on('ask', (_data, reply) => {
			if (!reply) return
			reply('first')
			try {
				reply('second')
			} catch (err) {
				thrown = err
			}
		})

		// Server-side: emit with a callback so the client receives a
		// reply-capable message. We only care about the client's
		// double-call behavior; the server's cb getting `'first'` is
		// proof the first reply landed.
		const [sock] = s.server.sockets
		const got = await new Promise(resolve =>
			sock.emit('ask', 'q', resolve),
		)
		assert.equal(got, 'first')

		await waitFor(() => thrown != null)
		assert.match(thrown.message, /reply\(\) already called/)
		assert.match(thrown.message, /"ask"/)
	})
})

describe('client: on / off + server-initiated emit', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('Client.on receives Server.emit; off() unsubscribes', async () => {
		s.server.events.connect = sock => sock.emit('news', 'hello')

		client = makeClient(s.baseUrl)

		const seen = []
		const off = client.on('news', v => seen.push(v))

		await waitFor(() => seen.length === 1)
		assert.deepEqual(seen, ['hello'])

		off?.()

		// After off(), another emit should NOT add to seen.
		s.server.emit('news', 'second')
		await new Promise(r => setTimeout(r, 100))
		assert.deepEqual(seen, ['hello'])
	})
})

describe('client: http() out-of-band', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('client.http(k, v) lands on the server', async () => {
		/** @type {any} */
		let got
		s.server.events.bigState = (_sock, data) => {
			got = data
		}

		client = makeClient(s.baseUrl)
		// Wait until the connection is up so http() has an open session.
		await waitFor(() => client.connected)
		client.http('bigState', { rows: ['a', 'b'] })
		await waitFor(() => got != null)
		assert.deepEqual(got, { rows: ['a', 'b'] })
	})

	it('multiple http() calls in the same tick batch into one stream', async () => {
		const seen = []
		let dispatches = 0
		s.server.events.batch = (_sock, data) => seen.push(data)
		// Each pump → parse → dispatch fires `events.incoming` exactly
		// once with the whole batch, so a successful client-side batch
		// shows up as a single dispatch carrying all three messages.
		const origIncoming = s.server.events.incoming
		s.server.events.incoming = (sock, msgs) => {
			dispatches++
			if (origIncoming) origIncoming(sock, msgs)
		}

		const c2 = makeClient(s.baseUrl)
		try {
			await waitFor(() => c2.connected)
			const baseline = dispatches
			c2.http('batch', 1)
			c2.http('batch', 2)
			c2.http('batch', 3)
			await waitFor(() => seen.length === 3)
			assert.deepEqual(seen, [1, 2, 3])
			assert.equal(
				dispatches - baseline,
				1,
				'three http() calls = one server dispatch',
			)
		} finally {
			c2.disconnect(true)
			s.server.events.incoming = origIncoming
		}
	})

	it('server-side socket.http(k, v) reaches the client via on()', async () => {
		// Earlier tests in this describe leave clients connected, so
		// snapshot the count and wait for ours to be added.
		const before = s.server.sockets.length
		client = makeClient(s.baseUrl)
		const got = []
		client.on('pushed', data => got.push(data))

		await waitFor(() => s.server.sockets.length > before)
		const sock = s.server.sockets[s.server.sockets.length - 1]
		sock.http('pushed', { from: 'server' })

		await waitFor(() => got.length === 1)
		assert.deepEqual(got, [{ from: 'server' }])
	})

	it('http() called pre-connect buffers and flushes after handshake', async () => {
		const seen = []
		s.server.events.early = (_sock, data) => seen.push(data)

		// Construct a fresh client and immediately call http() before the
		// session is up. With buffering, the messages should land after
		// connect rather than being dropped.
		const c2 = makeClient(s.baseUrl)
		try {
			assert.equal(c2.connected, false)
			c2.http('early', 1)
			c2.http('early', 2)
			await waitFor(() => seen.length === 2)
			assert.deepEqual(seen, [1, 2])
		} finally {
			c2.disconnect(true)
		}
	})
})

describe('client: params', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('client options.params reach socket.params (sans connid)', async () => {
		/** @type {any} */
		let captured
		s.server.events.connect = sock => {
			captured = { ...sock.params }
		}

		client = makeClient(s.baseUrl, {
			params: { user: 'tito', room: 'lobby' },
		})

		await waitFor(() => captured != null)
		assert.ok(captured)
		assert.equal(captured.user, 'tito')
		assert.equal(captured.room, 'lobby')
		assert.equal(typeof captured.connid, 'string')
	})
})

describe('client: predefined event listeners', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('on("connect") fires once on first connect', async () => {
		client = makeClient(s.baseUrl)
		const events = []
		client.on('connect', () => events.push('connect'))
		client.on('disconnect', () => events.push('disconnect'))

		await waitFor(() => client.connected)
		// Give the dispatch microtask a beat to fire 'connect'.
		await new Promise(r => setTimeout(r, 50))
		assert.deepEqual(events, ['connect'])
	})
})

describe('client: params as a function', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('options.params can be a function — it is invoked per connect', async () => {
		/** @type {any} */
		let captured
		s.server.events.connect = sock => {
			captured = { ...sock.params }
		}

		let calls = 0
		client = makeClient(s.baseUrl, {
			params: () => {
				calls++
				return { token: 'abc', n: String(calls) }
			},
		})

		await waitFor(() => captured != null)
		assert.ok(captured)
		assert.equal(captured.token, 'abc')
		assert.equal(captured.n, '1')
		assert.equal(calls, 1)
	})
})

describe('client: noConnect', () => {
	it('does not auto-connect when noConnect is set', async () => {
		const s = await bootServer()
		try {
			const client = makeClient(s.baseUrl, { noConnect: true })
			// Wait briefly — no connection should be opened.
			await new Promise(r => setTimeout(r, 200))
			assert.equal(client.connected, false)
			assert.equal(s.server.sockets.length, 0)

			// Calling connect() manually still works.
			client.connect()
			await waitFor(() => client.connected)
			assert.equal(s.server.sockets.length, 1)
			client.disconnect(true)
		} finally {
			await s.stop()
		}
	})
})

describe('client: emit / http no-arg + http reply', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('emit(k) sends just [k]; http(k, v, fn) returns a reply promise', async () => {
		const seen = []
		s.server.events.bare = (_sock, data) => seen.push(data)
		s.server.events.echo = (_sock, data, reply) => reply(data)

		client = makeClient(s.baseUrl)
		await waitFor(() => client.connected)

		client.emit('bare')
		await waitFor(() => seen.length === 1)
		// emit(k) with no value: the server handler receives data === undefined
		assert.equal(seen[0], undefined)

		const got = await client.http('echo', 'hi', r => r + '!')
		assert.equal(got, 'hi!')
	})
})

describe('client: disconnect', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		await s.stop()
	})

	it('client.disconnect(true) closes the session and disables reconnect', async () => {
		let disconnects = 0
		s.server.events.disconnect = () => disconnects++

		client = makeClient(s.baseUrl)
		await waitFor(() => client.connected)
		assert.equal(s.server.sockets.length, 1)

		client.disconnect(true)
		await waitFor(() => s.server.sockets.length === 0)
		assert.equal(s.server.sockets.length, 0)
		assert.equal(disconnects, 1)

		// Give a grace window — should NOT auto-reconnect.
		await new Promise(r => setTimeout(r, 200))
		assert.equal(s.server.sockets.length, 0)
	})
})
