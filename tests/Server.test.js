import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import serverSingleton from '../server/Server.js'

// Server is exported as a pre-built singleton; for isolation we
// instantiate fresh copies via its constructor for each test.
const Server = /** @type {new () => typeof serverSingleton} */ (
	/** @type {unknown} */ (serverSingleton.constructor)
)

describe('Server defaults', () => {
	it('initializes counters to zero', () => {
		const s = new Server()
		assert.equal(s.served, 0)
		assert.equal(s.bytesReceived, 0)
		assert.equal(s.bytesSent, 0)
		assert.equal(s.messagesReceived, 0)
		assert.equal(s.messagesSent, 0)
		assert.equal(s.messagesGarbage, 0)
		assert.equal(s.serverErrors, 0)
	})

	it('starts with empty sockets array', () => {
		const s = new Server()
		assert.ok(Array.isArray(s.sockets))
		assert.equal(s.sockets.length, 0)
	})

	it('events is a null-prototype object', () => {
		const s = new Server()
		assert.equal(Object.getPrototypeOf(s.events), null)
	})

	it('queue starts empty', () => {
		const s = new Server()
		assert.deepEqual(s.queue, [])
	})

	it('default port is 3001', () => {
		const s = new Server()
		assert.equal(s.port, 3001)
	})
})

describe('Server.on(Class)', () => {
	it('registers each method on the prototype as an event listener', () => {
		const s = new Server()
		const calls = []
		class Chat {
			typing(socket, data) {
				calls.push(['typing', data])
			}
			theMessage(socket, data) {
				calls.push(['theMessage', data])
			}
		}
		s.on(Chat)
		assert.equal(typeof s.events.typing, 'function')
		assert.equal(typeof s.events.theMessage, 'function')
		s.events.typing(null, true)
		s.events.theMessage(null, 'hi')
		assert.deepEqual(calls, [
			['typing', true],
			['theMessage', 'hi'],
		])
	})

	it('skips constructor and the empty-key listener', () => {
		const s = new Server()
		class C {
			constructor() {}
			''(socket) {}
			real() {}
		}
		s.on(C)
		assert.equal(s.events.constructor, undefined)
		assert.equal(s.events[''], undefined)
		assert.equal(typeof s.events.real, 'function')
	})

	it('honors a static listeners override', () => {
		const s = new Server()
		class Limited {
			static listeners = ['only']
			only() {}
			alsoExists() {}
		}
		s.on(Limited)
		assert.equal(typeof s.events.only, 'function')
		assert.equal(s.events.alsoExists, undefined)
	})

	it('returns the constructed instance', () => {
		const s = new Server()
		class C {
			marker = true
		}
		const inst = s.on(C)
		assert.ok(inst instanceof C)
		assert.equal(inst.marker, true)
	})

	it('chains multiple classes onto the same event', () => {
		const s = new Server()
		const calls = []
		class A {
			ping() {
				calls.push('a')
			}
		}
		class B {
			ping() {
				calls.push('b')
			}
		}
		s.on(A)
		s.on(B)
		s.events.ping()
		assert.deepEqual(calls, ['a', 'b'])
	})
})

describe('Server.cacheMessages', () => {
	it('caches by message identity sequence; second call is a hit', () => {
		const s = new Server()
		const m1 = ['k', 'v']
		const m2 = ['k2', 'v2']
		const a = s.cacheMessages([m1, m2])
		const b = s.cacheMessages([m1, m2])
		assert.equal(a, b, 'returns the same cached frame')
		assert.equal(s.messagesSentCacheHit, 1)
	})

	it('returns a Uint8Array of newline-delimited JSON', () => {
		const s = new Server()
		const out = s.cacheMessages([['k', 'v']])
		assert.ok(out instanceof Uint8Array)
		const text = new TextDecoder().decode(out)
		assert.equal(text, '[["k","v"]]\n')
	})
})

describe('Server.nextQueue / processQueue', () => {
	it('first nextQueue schedules processQueue on next tick', async () => {
		const s = new Server()
		const drained = []
		const fakeSock = {
			processQueue() {
				drained.push(this)
			},
		}
		s.nextQueue(fakeSock)
		assert.equal(s.queue.length, 1)
		await new Promise(r => setImmediate(r))
		assert.equal(s.queue.length, 0)
		assert.equal(drained.length, 1)
	})

	it('processQueue drains every queued socket and clears cache', async () => {
		const s = new Server()
		const calls = []
		const a = {
			processQueue() {
				calls.push('a')
			},
		}
		const b = {
			processQueue() {
				calls.push('b')
			},
		}
		s.cacheMessages([['k', 'v']])
		const cacheBefore = s.cache
		s.nextQueue(a)
		s.nextQueue(b)
		await new Promise(r => setImmediate(r))
		assert.deepEqual(calls, ['a', 'b'])
		assert.notEqual(s.cache, cacheBefore)
	})
})

describe('Server.pong', () => {
	it('pong updates seen and computes ping from contacted', () => {
		const s = new Server()
		s.now = 1000
		const fakeSock = { contacted: 900, seen: 0, ping: 0 }
		s.pong(fakeSock)
		assert.ok(fakeSock.seen >= 1000)
		assert.equal(fakeSock.ping, fakeSock.seen - 900)
	})

	it('pong fires events.ping when wired', () => {
		const s = new Server()
		const calls = []
		s.events.ping = sock => calls.push(sock)
		const fakeSock = { contacted: 0, seen: 0, ping: 0 }
		s.pong(fakeSock)
		assert.deepEqual(calls, [fakeSock])
	})
})

describe('Server.toJSON', () => {
	it('toJSON returns a placeholder string', () => {
		const s = new Server()
		assert.equal(typeof s.toJSON(), 'string')
	})
})
