import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { Room } from '../server/Room.js'

/** Minimal socket-shaped object — Room only reads `rooms` and identity. */
const fakeSocket = id => /** @type {any} */ ({ id, rooms: [] })

describe('Room defaults', () => {
	it('persistent defaults to false', () => {
		const r = new Room()
		assert.equal(r.persistent, false)
	})

	it('starts with empty sockets array', () => {
		const r = new Room()
		assert.ok(Array.isArray(r.sockets))
		assert.equal(r.sockets.length, 0)
	})
})

describe('Room.join', () => {
	it('adds the socket and back-links via socket.rooms', () => {
		const r = new Room()
		const s = fakeSocket('s1')
		r.join(s)
		assert.deepEqual(r.sockets, [s])
		assert.deepEqual(s.rooms, [r])
	})

	it('fires onJoin once per join', () => {
		const calls = []
		class R extends Room {
			onJoin(s) {
				calls.push(s.id)
			}
		}
		const r = new R()
		r.join(fakeSocket('s1'))
		assert.deepEqual(calls, ['s1'])
	})

	it('dedups: a second join of the same socket is a no-op', () => {
		const calls = []
		class R extends Room {
			onJoin(s) {
				calls.push(s.id)
			}
		}
		const r = new R()
		const s = fakeSocket('s1')
		r.join(s)
		r.join(s)
		assert.equal(r.sockets.length, 1)
		assert.equal(s.rooms.length, 1)
		assert.deepEqual(calls, ['s1'])
	})
})

describe('Room.leave', () => {
	it('removes the socket from both sides and fires onLeave', () => {
		const calls = []
		class R extends Room {
			onLeave(s) {
				calls.push(s.id)
			}
		}
		const r = new R()
		const s = fakeSocket('s1')
		r.join(s)
		r.leave(s)
		assert.deepEqual(r.sockets, [])
		assert.deepEqual(s.rooms, [])
		assert.deepEqual(calls, ['s1'])
	})

	it('is a no-op when the socket was never joined', () => {
		const calls = []
		class R extends Room {
			onLeave() {
				calls.push('leave')
			}
		}
		const r = new R()
		const s = fakeSocket('s1')
		r.leave(s)
		assert.deepEqual(calls, [])
	})

	it('only removes the leaving socket — others remain', () => {
		const r = new Room()
		const a = fakeSocket('a')
		const b = fakeSocket('b')
		const c = fakeSocket('c')
		r.join(a)
		r.join(b)
		r.join(c)
		r.leave(b)
		assert.deepEqual(r.sockets, [a, c])
		assert.deepEqual(b.rooms, [])
	})
})

describe('Room hooks', () => {
	it('onCreate/onDelete are no-ops by default and never throw', () => {
		const r = new Room()
		assert.doesNotThrow(() => r.onCreate(fakeSocket('s')))
		assert.doesNotThrow(() => r.onDelete(fakeSocket('s')))
	})
})
