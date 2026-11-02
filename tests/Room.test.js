import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { Room } from '../server/Room.js'

/** Minimal socket-shaped object — Room only reads `rooms` and identity. */
const fakeSocket = id => /** @type {any} */ ({ id, rooms: new Set(), messages: [] })

describe('Room defaults', () => {
	it('persistent defaults to false', () => {
		const r = new Room()
		assert.equal(r.persistent, false)
	})

	it('starts with an empty sockets Set', () => {
		const r = new Room()
		assert.ok(r.sockets instanceof Set)
		assert.equal(r.sockets.size, 0)
	})
})

describe('Room.join', () => {
	it('adds the socket and back-links via socket.rooms', () => {
		const r = new Room()
		const s = fakeSocket('s1')
		r.join(s)
		assert.deepEqual(r.sockets, new Set([s]))
		assert.deepEqual(s.rooms, new Set([r]))
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
		assert.equal(r.sockets.size, 1)
		assert.equal(s.rooms.size, 1)
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
		assert.deepEqual(r.sockets, new Set([]))
		assert.deepEqual(s.rooms, new Set([]))
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
		assert.deepEqual(r.sockets, new Set([a, c]))
		assert.deepEqual(b.rooms, new Set([]))
	})
})

describe('Room hooks', () => {
	it('onCreate/onDelete are no-ops by default and never throw', () => {
		const r = new Room()
		assert.doesNotThrow(() => r.onCreate(fakeSocket('s')))
		assert.doesNotThrow(() => r.onDelete(fakeSocket('s')))
	})
})

describe('Room.join on a closed socket', () => {
	it('is a no-op: no member, no back-link, no onJoin', () => {
		let joins = 0
		class R extends Room {
			onJoin() {
				joins++
			}
		}
		const room = new R()
		const closed = /** @type {any} */ ({ rooms: new Set(), closed: true })
		room.join(closed)
		assert.equal(room.sockets.size, 0)
		assert.deepEqual(closed.rooms, new Set([]))
		assert.equal(joins, 0)
	})
})
