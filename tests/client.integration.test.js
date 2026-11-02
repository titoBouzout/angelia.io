/**
 * Runtime tests for the actual `client/index.js` class — boots a real
 * Server and exercises the Client API end-to-end over Node's global
 * `WebSocket`.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { connect, createServer as createNetServer } from 'node:net'

import { Server, bootServer, freePort, waitFor } from './helpers.js'
import Client from '../client/index.js'

/**
 * Construct a Client pointed at our server. Caller is responsible for
 * `client.disconnect(true)`.
 */
function makeClient(baseUrl, options = {}) {
	return new Client({ url: baseUrl, ...options })
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
		s.server.hooks.connect = () => connectCount++
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

	it('drops the second reply() call without throwing', async () => {
		client = makeClient(s.baseUrl)
		await waitFor(() => client.connected)

		client.on('ask', (_data, reply) => {
			if (!reply) return
			reply('first')
			// Must not throw — second call is silently dropped (and
			// logged via console.error inside the client). If it threw,
			// we'd never finish the handler and the cb below wouldn't
			// resolve.
			reply('second')
		})

		// Server-side: emit with a callback so the client receives a
		// reply-capable message. The cb resolving with `'first'` proves
		// (a) the first reply landed and (b) the handler completed
		// without the second call throwing.
		const [sock] = s.server.sockets
		const got = await new Promise(resolve =>
			sock.emit('ask', 'q', resolve),
		)
		assert.equal(got, 'first')
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
		s.server.hooks.connect = sock => sock.emit('news', 'hello')

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

describe('client: batching', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('multiple emit() calls in the same tick batch into one frame', async () => {
		const seen = []
		let dispatches = 0
		s.server.events.batch = (_sock, data) => seen.push(data)
		s.server.hooks.incoming = () => dispatches++

		client = makeClient(s.baseUrl)
		await waitFor(() => client.connected)
		client.emit('batch', 1)
		client.emit('batch', 2)
		client.emit('batch', 3)
		await waitFor(() => seen.length === 3)
		assert.deepEqual(seen, [1, 2, 3])
		assert.equal(dispatches, 1, 'three emit() calls = one server dispatch')
	})

	it('a pre-connect queue too big for the URL flushes after open', async () => {
		const seen = []
		s.server.events.big = (_sock, data) => seen.push(data)

		const c2 = makeClient(s.baseUrl)
		try {
			assert.equal(c2.connected, false)
			const payload = 'x'.repeat(8 * 1024)
			c2.emit('big', payload)
			c2.emit('big', 2)
			await waitFor(() => seen.length === 2)
			assert.deepEqual(seen, [payload, 2])
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
		s.server.hooks.connect = sock => {
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
		s.server.hooks.connect = sock => {
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

describe('client: event names that exist on Object.prototype', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('can be listened to, and unlistened names are ignored', async () => {
		client = makeClient(s.baseUrl)
		const seen = []
		for (const name of ['constructor', '__proto__', 'toString']) {
			client.on(name, v => seen.push([name, v]))
		}
		await waitFor(() => client.connected)
		s.server.emit('constructor', 1)
		s.server.emit('__proto__', 2)
		s.server.emit('toString', 3)
		// Nobody listens to these: they must be skipped, not crash dispatch.
		s.server.emit('hasOwnProperty', 4)
		s.server.emit('valueOf', 5)
		s.server.emit('done', 6)
		client.on('done', v => seen.push(['done', v]))
		await waitFor(() => seen.length === 4)
		assert.deepEqual(seen, [
			['constructor', 1],
			['__proto__', 2],
			['toString', 3],
			['done', 6],
		])
	})
})

describe('client: url', () => {
	it('throws for anything but ws:// or wss://', () => {
		for (const url of ['http://127.0.0.1:1', 'https://127.0.0.1:1', 'ftp://x']) {
			assert.throws(() => new Client({ url, noConnect: true }), /ws:\/\/ or wss:\/\//)
		}
		for (const url of ['ws://127.0.0.1:1', 'wss://127.0.0.1:1']) {
			new Client({ url, noConnect: true })
		}
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
			assert.equal(s.server.sockets.size, 0)

			// Calling connect() manually still works.
			client.connect()
			await waitFor(() => client.connected)
			assert.equal(s.server.sockets.size, 1)
			client.disconnect(true)
		} finally {
			await s.stop()
		}
	})
})

describe('client: emit no-arg', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('emit(k) sends just [k]', async () => {
		const seen = []
		s.server.events.bare = (_sock, data) => seen.push(data)

		client = makeClient(s.baseUrl)
		await waitFor(() => client.connected)

		client.emit('bare')
		await waitFor(() => seen.length === 1)
		// emit(k) with no value: the server handler receives data === undefined
		assert.equal(seen[0], undefined)
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

	it('client.disconnect(true) closes the connection and disables reconnect', async () => {
		let disconnects = 0
		s.server.hooks.disconnect = () => disconnects++

		client = makeClient(s.baseUrl)
		await waitFor(() => client.connected)
		assert.equal(s.server.sockets.size, 1)

		client.disconnect(true)
		await waitFor(() => s.server.sockets.size === 0)
		assert.equal(s.server.sockets.size, 0)
		assert.equal(disconnects, 1)

		// Give a grace window — should NOT auto-reconnect.
		await new Promise(r => setTimeout(r, 200))
		assert.equal(s.server.sockets.size, 0)
	})
})

describe('client: reconnect lifecycle', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('soft disconnect + connect() dispatches `reconnect` (not a second `connect`)', async () => {
		client = makeClient(s.baseUrl)

		/** @type {string[]} */
		const events = []
		client.on('connect', () => events.push('connect'))
		client.on('reconnect', () => events.push('reconnect'))
		client.on('disconnect', () => events.push('disconnect'))

		await waitFor(() => client.connected)
		// Give the post-handshake dispatch a beat to fire 'connect'.
		await new Promise(r => setTimeout(r, 50))
		assert.deepEqual(events, ['connect'])
		assert.equal(s.server.served, 1)

		// Soft disconnect leaves #reconnect = true. We then call
		// connect() manually instead of waiting for the 2–4s jittered
		// timer; once #io is non-null again, the timer's connect()
		// becomes a no-op.
		client.disconnect()
		await waitFor(() => !client.connected)
		assert.deepEqual(events, ['connect', 'disconnect'])

		client.connect()
		await waitFor(() => client.connected)
		await new Promise(r => setTimeout(r, 50))
		assert.deepEqual(events, ['connect', 'disconnect', 'reconnect'])

		// Server saw two distinct connections across the reconnect.
		assert.equal(s.server.served, 2)
	})
})

describe('client: reconnect timing', () => {
	it('reconnects at once when a connection that was up drops', async () => {
		const s = await bootServer()
		const client = makeClient(s.baseUrl)
		try {
			await waitFor(() => client.connected)
			// Past the retry minimum, so this counts as a working connection.
			await new Promise(r => setTimeout(r, 2100))
			const [sock] = s.server.sockets
			const dropped = Date.now()
			sock.disconnect()
			await waitFor(() => s.server.served === 2 && client.connected)
			const took = Date.now() - dropped
			assert.ok(took < 500, `reconnected after ${took}ms`)
		} finally {
			client.disconnect(true)
			await s.stop()
		}
	})

	it('waits 2–4s before retrying a failed attempt', async () => {
		const port = await freePort()
		const client = makeClient(`ws://127.0.0.1:${port}`)
		try {
			// Nothing listens yet: the first attempt fails and schedules a retry.
			await new Promise(r => setTimeout(r, 100))
			const failed = Date.now()
			const s = new Server()
			await s.listen({ port })
			try {
				await new Promise(r => setTimeout(r, 1700))
				assert.equal(s.served, 0, 'retried before the minimum delay')
				await waitFor(() => client.connected, 160)
				const took = Date.now() - failed
				assert.ok(took >= 1800 && took < 4500, `retried after ${took}ms`)
			} finally {
				client.disconnect(true)
				await s.stop()
			}
		} finally {
			client.disconnect(true)
		}
	})

	it('waits before reconnecting when the server drops it right after opening', async () => {
		const s = await bootServer()
		s.server.hooks.connect = sock => sock.disconnect()
		const client = makeClient(s.baseUrl)
		try {
			await waitFor(() => s.server.served === 1)
			await new Promise(r => setTimeout(r, 1500))
			assert.equal(s.server.served, 1, 'must not loop on an instant drop')
		} finally {
			client.disconnect(true)
			await s.stop()
		}
	})
})

describe('client: pending callbacks reject on reconnect', () => {
	let s, client

	before(async () => {
		s = await bootServer()
	})
	after(async () => {
		client?.disconnect(true)
		await s.stop()
	})

	it('outstanding emit-with-callback rejects with Error("reconnecting")', async () => {
		// Handler that never replies — the callback would otherwise
		// resolve normally.
		s.server.events.willNotReply = () => {}

		client = makeClient(s.baseUrl)
		await waitFor(() => client.connected)

		const emitP = client.emit('willNotReply', 'data', () => 'never')
		// Attach a no-op catch up front so the eventual rejection
		// isn't flagged as unhandled while we wait through the
		// disconnect / reconnect window.
		emitP.catch(() => {})

		// Soft disconnect + manual reconnect, same trick as above.
		client.disconnect()
		await waitFor(() => !client.connected)
		client.connect()
		await waitFor(() => client.connected)

		// connect()'s reconnect branch synchronously cancels every
		// pending callback with Error('reconnecting').
		await assert.rejects(emitP, /reconnecting/)
	})
})

describe('client: URL packing', () => {
	/** Bytes of the handshake request line for request target `url`. */
	const requestLine = url => `GET ${url} HTTP/1.1\r\n`.length
	/** Form-encoded length of `text`, as the client measures it. */
	const encoded = text => new URLSearchParams({ m: text }).toString().length - 2

	/** Messages a connect request carried in its `m` param. */
	const packedIn = url =>
		JSON.parse(new URL(url, 'http://x').searchParams.get('m') || '[]')

	/** Server recording each connect URL and every dispatched batch. */
	const bootRecording = async (port = 0) => {
		const s = new Server()
		const urls = []
		const batches = []
		s.hooks.connect = (_sock, request) => urls.push(request.url)
		s.hooks.incoming = (_sock, messages) =>
			batches.push(messages.map(m => [m[0], m[1]]))
		s.events.m = () => {}
		await s.listen({ port })
		return { s, port: s.port, urls, batches }
	}

	it('packs every pre-connect message into the URL when they fit', async () => {
		const { s, port, urls, batches } = await bootRecording()
		const client = makeClient(`ws://127.0.0.1:${port}`)
		try {
			client.emit('m', 1)
			client.emit('m', 2)
			client.emit('m', 3)
			await waitFor(() => batches.length === 1)
			assert.deepEqual(packedIn(urls[0]), [['m', 1], ['m', 2], ['m', 3]])
			assert.deepEqual(batches, [[['m', 1], ['m', 2], ['m', 3]]])
		} finally {
			client.disconnect(true)
			await s.stop()
		}
	})

	it('packs what fits and sends the rest over the socket, in order', async () => {
		const { s, port, urls, batches } = await bootRecording()
		const client = makeClient(`ws://127.0.0.1:${port}`)
		try {
			// Two of these fit nginx's 8 KB request line, the third doesn't.
			const big = n => 'x'.repeat(3000) + n
			client.emit('m', big(1))
			client.emit('m', big(2))
			client.emit('m', big(3))
			client.emit('m', 'small')
			await waitFor(() => batches.flat().length === 4)

			// As full as it can be: within the limit, but not with one more.
			const line = requestLine(urls[0])
			assert.ok(line <= 8192, `request line is ${line} bytes`)
			assert.ok(line + encoded(',' + JSON.stringify(['m', big(3)])) > 8192)
			assert.deepEqual(packedIn(urls[0]), [['m', big(1)], ['m', big(2)]])
			assert.deepEqual(batches, [
				[['m', big(1)], ['m', big(2)]],
				[['m', big(3)], ['m', 'small']],
			])
		} finally {
			client.disconnect(true)
			await s.stop()
		}
	})

	it('stops at the first message that does not fit, so order is kept', async () => {
		const { s, port, urls, batches } = await bootRecording()
		const client = makeClient(`ws://127.0.0.1:${port}`)
		try {
			const huge = 'x'.repeat(9000)
			client.emit('m', huge)
			client.emit('m', 'small')
			await waitFor(() => batches.flat().length === 2)
			assert.deepEqual(packedIn(urls[0]), [])
			assert.deepEqual(batches, [[['m', huge], ['m', 'small']]])
		} finally {
			client.disconnect(true)
			await s.stop()
		}
	})

	it('requeues packed messages after a failed connect, keeping order and callbacks', async () => {
		const port = await freePort()
		const client = makeClient(`ws://127.0.0.1:${port}`, {
			noConnect: true,
		})
		try {
			client.emit('m', 'a')
			const replied = client.emit('echo', 'b', r => r)

			// Nothing listens yet: this attempt fails before opening.
			client.connect()
			await new Promise(r => setTimeout(r, 300))
			assert.equal(client.connected, false)
			client.emit('m', 'c')

			const { s, urls, batches } = await bootRecording(port)
			s.events.echo = (_sock, data, reply) => reply(data)
			try {
				client.connect()
				await waitFor(() => batches.flat().length === 3)
				// The retry doesn't pack: the URL may be what failed.
				assert.deepEqual(packedIn(urls[0]), [])
				assert.deepEqual(batches, [[['m', 'a'], ['echo', 'b'], ['m', 'c']]])
				assert.equal(await replied, 'b')
			} finally {
				client.disconnect(true)
				await s.stop()
			}
		} finally {
			client.disconnect(true)
		}
	})

	it('gets through a proxy that rejects long URLs instead of retrying the same URL', async () => {
		const { s, port, urls, batches } = await bootRecording()
		// Stands in for a proxy with a small URL limit: 414 for any packed URL.
		const proxy = createNetServer(conn => {
			let head = ''
			const onData = chunk => {
				head += chunk.toString('latin1')
				if (!head.includes('\r\n')) return
				conn.off('data', onData)
				if (head.split('\r\n')[0].includes('m=')) {
					conn.end('HTTP/1.1 414 URI Too Long\r\nConnection: close\r\n\r\n')
					return
				}
				const upstream = connect(port, '127.0.0.1', () => {
					upstream.write(head, 'latin1')
					conn.pipe(upstream).pipe(conn)
				})
				upstream.on('error', () => conn.destroy())
				conn.on('error', () => upstream.destroy())
			}
			conn.on('data', onData)
		})
		const proxyPort = await freePort()
		await new Promise(resolve =>
			proxy.listen(proxyPort, '127.0.0.1', () => resolve(undefined)),
		)
		const client = makeClient(`ws://127.0.0.1:${proxyPort}`, {
			noConnect: true,
		})
		try {
			client.emit('m', 'a')
			client.connect()
			await new Promise(r => setTimeout(r, 300))
			assert.equal(urls.length, 0, 'the packed attempt was rejected')

			client.connect()
			await waitFor(() => batches.length === 1)
			assert.deepEqual(packedIn(urls[0]), [])
			assert.deepEqual(batches, [[['m', 'a']]])
		} finally {
			client.disconnect(true)
			proxy.close()
			await s.stop()
		}
	})
})

describe('client: protocol and keys', () => {
	it('server disconnect(true) fires disconnect once and stops reconnecting', async () => {
		const s = await bootServer()
		const client = makeClient(s.baseUrl)
		try {
			const events = []
			client.on('disconnect', v => events.push(['disconnect', v]))
			await waitFor(() => client.connected)
			const [sock] = s.server.sockets
			sock.disconnect(true)
			await waitFor(() => !client.connected)
			await new Promise(r => setTimeout(r, 100))
			assert.deepEqual(events, [['disconnect', undefined]])
			client.connect()
			await new Promise(r => setTimeout(r, 100))
			assert.equal(s.server.served, 1)
		} finally {
			client.disconnect(true)
			await s.stop()
		}
	})

	it('accepts key 0 and rejects only the empty key', async () => {
		const s = await bootServer()
		const client = makeClient(s.baseUrl)
		try {
			const seen = []
			s.server.events['0'] = (_sock, v) => seen.push(v)
			s.server.events.after = (_sock, v) => seen.push(v)
			client.emit(/** @type {any} */ (0), 'zero')
			// Logged and dropped on the client: nothing reaches the server.
			assert.equal(client.emit('', 'empty'), undefined)
			client.emit('after', 'last')
			await waitFor(() => seen.length === 2)
			assert.deepEqual(seen, ['zero', 'last'])
			assert.equal(s.server.messagesGarbage, 0)
		} finally {
			client.disconnect(true)
			await s.stop()
		}
	})

	it('connects to the URL path when one is given, the default otherwise', async () => {
		const custom = await bootServer({ path: '/live' })
		const plain = await bootServer()
		const a = makeClient(`${custom.baseUrl}/live`)
		const b = makeClient(plain.baseUrl)
		try {
			await waitFor(() => a.connected && b.connected)
			assert.equal(custom.server.sockets.size, 1)
			assert.equal(plain.server.sockets.size, 1)
		} finally {
			a.disconnect(true)
			b.disconnect(true)
			await custom.stop()
			await plain.stop()
		}
	})

	it('disconnect with a reason over 123 bytes throws and keeps the connection', async () => {
		const s = await bootServer()
		const client = makeClient(s.baseUrl)
		try {
			await waitFor(() => client.connected)
			assert.throws(() => client.disconnect(true, 'x'.repeat(124)), RangeError)
			await new Promise(r => setTimeout(r, 50))
			assert.equal(client.connected, true)
		} finally {
			client.disconnect(true)
			await s.stop()
		}
	})
})
