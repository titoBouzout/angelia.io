import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { Server } from '../server/Server.js'


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

	it('starts with an empty sockets Set', () => {
		const s = new Server()
		assert.ok(s.sockets instanceof Set)
		assert.equal(s.sockets.size, 0)
	})

	it('events is a null-prototype object', () => {
		const s = new Server()
		assert.equal(Object.getPrototypeOf(s.events), null)
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
			timeout() {
				calls.push('a')
			}
		}
		class B {
			timeout() {
				calls.push('b')
			}
		}
		s.on(A)
		s.on(B)
		s.hooks.timeout?.(/** @type {any} */ ({}), 0)
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

	it('returns a complete unmasked text frame of the JSON batch', () => {
		const s = new Server()
		const json = '[["k","v"]]'
		const wire = Buffer.concat(s.cacheMessages([['k', 'v']]))
		// FIN + text opcode, then the 7-bit length with no mask bit.
		assert.equal(wire[0], 0x81)
		assert.equal(wire[1], json.length)
		assert.equal(wire.subarray(2).toString(), json)
	})
})

describe('Server.nextQueue / processQueue', () => {
	it('first nextQueue schedules processQueue on next tick', async () => {
		const s = new Server()
		const drained = []
		const fakeSock = /** @type {any} */ ({
			processQueue() {
				drained.push(this)
			},
		})
		s.nextQueue(fakeSock)
		assert.equal(drained.length, 0)
		await new Promise(r => setImmediate(r))
		assert.equal(drained.length, 1)
	})

	it('processQueue drains every queued socket and clears cache', async () => {
		const s = new Server()
		const calls = []
		const a = /** @type {any} */ ({
			processQueue() {
				calls.push('a')
			},
		})
		const b = /** @type {any} */ ({
			processQueue() {
				calls.push('b')
			},
		})
		const batch = [['k', 'v'], ['k2', 'v2']]
		const before = s.cacheMessages(batch)
		s.nextQueue(a)
		s.nextQueue(b)
		await new Promise(r => setImmediate(r))
		assert.deepEqual(calls, ['a', 'b'])
		assert.notEqual(s.cacheMessages(batch), before, 'a batch frames anew the next tick')
	})
})

describe('Server.toJSON', () => {
	it('toJSON returns a placeholder string', () => {
		const s = new Server()
		assert.equal(typeof s.toJSON(), 'string')
	})
})

describe('Server.on(Class) with handlers assigned directly', () => {
	it('keeps a handler assigned to events and adds the class method next to it', () => {
		const s = new Server()
		const calls = []
		s.events.typing = (_sock, v) => calls.push(['direct', v])
		class Chat {
			typing(_sock, v) {
				calls.push(['class', v])
			}
		}
		s.on(Chat)
		s.events.typing(null, 1)
		assert.deepEqual(calls, [
			['direct', 1],
			['class', 1],
		])
	})

	it('calls a lone handler directly, with no fan-out wrapper', () => {
		const s = new Server()
		class Chat {
			typing() {}
		}
		s.on(Chat)
		assert.equal(s.events.typing.fns, undefined)
	})
})
