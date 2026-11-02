import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { Room } from '../server/Room.js'
import { Rooms } from '../server/Rooms.js'

/** Minimal socket-shaped object — Rooms only reads `rooms` and identity. */
const fakeSocket = id => /** @type {any} */ ({ id, rooms: new Set(), messages: [] })

describe('Rooms.join', () => {
	it('lazily creates a room with the given id and fires onCreate', () => {
		const created = []
		class R extends Room {
			onCreate(s) {
				created.push([this.id, s.id])
			}
		}
		const list = new Rooms(R)
		list.join(fakeSocket('s1'), 'lobby')
		const room = list.get('lobby')
		assert.ok(room instanceof R)
		assert.equal(room.id, 'lobby')
		assert.deepEqual(created, [['lobby', 's1']])
	})

	it('does not re-create on subsequent joins to the same id', () => {
		let creates = 0
		class R extends Room {
			onCreate() {
				creates++
			}
		}
		const list = new Rooms(R)
		list.join(fakeSocket('a'), 'x')
		list.join(fakeSocket('b'), 'x')
		assert.equal(creates, 1)
		const x = list.get('x')
		assert.ok(x)
		assert.equal(x.sockets.size, 2)
	})

	it('supports undefined id (the default room)', () => {
		const list = new Rooms(Room)
		list.join(fakeSocket('s'))
		const def = list.get(undefined)
		assert.ok(def)
		assert.equal(def.sockets.size, 1)
	})
})

describe('Rooms.leave', () => {
	it('removes the room when last socket leaves and fires onDelete', () => {
		const deleted = []
		class R extends Room {
			onDelete(s) {
				deleted.push([this.id, s.id])
			}
		}
		const list = new Rooms(R)
		const s = fakeSocket('s1')
		list.join(s, 'tmp')
		list.leave(s, 'tmp')
		assert.equal(list.get('tmp'), undefined)
		assert.deepEqual(deleted, [['tmp', 's1']])
	})

	it('keeps a persistent room even when empty', () => {
		const deleted = []
		class R extends Room {
			persistent = true
			onDelete() {
				deleted.push('del')
			}
		}
		const list = new Rooms(R)
		const s = fakeSocket('s1')
		list.join(s, 'lobby')
		list.leave(s, 'lobby')
		const lobby = list.get('lobby')
		assert.ok(lobby)
		assert.equal(lobby.sockets.size, 0)
		assert.deepEqual(deleted, [])
	})

	it('is a no-op when the room id does not exist', () => {
		const list = new Rooms(Room)
		assert.doesNotThrow(() => list.leave(fakeSocket('s'), 'nope'))
	})

	it('does not delete a room with remaining sockets', () => {
		const list = new Rooms(Room)
		const a = fakeSocket('a')
		const b = fakeSocket('b')
		list.join(a, 'r')
		list.join(b, 'r')
		list.leave(a, 'r')
		const r = list.get('r')
		assert.ok(r)
		assert.equal(r.sockets.size, 1)
	})
})

describe('Rooms.sockets', () => {
	it('sockets returns a Set with every socket across rooms', () => {
		const list = new Rooms(Room)
		const a = fakeSocket('a')
		const b = fakeSocket('b')
		const c = fakeSocket('c')
		list.join(a, 'r1')
		list.join(b, 'r1')
		list.join(c, 'r2')
		assert.deepEqual(list.sockets, new Set([a, b, c]))
	})

	it('sockets is one live Set, kept up to date by joins and leaves', () => {
		const list = new Rooms(Room)
		const live = list.sockets
		const a = fakeSocket('a')
		const b = fakeSocket('b')
		list.join(a, 'r1')
		list.join(b, 'r1')
		list.join(a, 'r2')
		assert.equal(list.sockets, live)
		assert.deepEqual(live, new Set([a, b]))

		// `a` is still in r2, so leaving r1 keeps it in the list.
		list.leave(a, 'r1')
		assert.deepEqual(live, new Set([a, b]))
		list.leave(a, 'r2')
		assert.deepEqual(live, new Set([b]))

		// Joining or leaving through the Room itself updates the list too.
		const r1 = list.get('r1')
		assert.ok(r1)
		r1.join(a)
		assert.deepEqual(live, new Set([b, a]))
		r1.leave(b)
		assert.deepEqual(live, new Set([a]))
	})
})

describe('Rooms.list / toJSON', () => {
	it('list returns an Array of every room', () => {
		const list = new Rooms(Room)
		list.join(fakeSocket('a'), 'r1')
		list.join(fakeSocket('b'), 'r2')
		const arr = list.list
		assert.ok(Array.isArray(arr))
		assert.equal(arr.length, 2)
		assert.deepEqual(
			arr.map(r => r.id).sort(),
			['r1', 'r2'],
		)
	})

	it('list supports native array methods (map, filter)', () => {
		const list = new Rooms(Room)
		list.join(fakeSocket('a'), 'r1')
		list.join(fakeSocket('b'), 'r1')
		list.join(fakeSocket('c'), 'r2')
		const big = list.list.filter(r => r.sockets.size > 1)
		assert.equal(big.length, 1)
		assert.equal(big[0].id, 'r1')
	})

	it('list is recomputed on each access (not cached)', () => {
		const list = new Rooms(Room)
		list.join(fakeSocket('a'), 'r1')
		const first = list.list
		list.join(fakeSocket('b'), 'r2')
		const second = list.list
		assert.notEqual(first, second)
		assert.equal(first.length, 1)
		assert.equal(second.length, 2)
	})

	it('toJSON returns the rooms array', () => {
		const list = new Rooms(Room)
		list.join(fakeSocket('a'), 'r1')
		const json = list.toJSON()
		assert.ok(Array.isArray(json))
		assert.equal(json[0].id, 'r1')
	})
})

describe('Rooms with closed or shared sockets', () => {
	it('join ignores a closed socket and creates no room', () => {
		let creates = 0
		class R extends Room {
			onCreate() {
				creates++
			}
		}
		const list = new Rooms(R)
		const closed = /** @type {any} */ ({ id: 'c', rooms: new Set(), closed: true })
		list.join(closed, 'x')
		assert.equal(list.get('x'), undefined)
		assert.equal(creates, 0)
		assert.deepEqual(closed.rooms, new Set([]))
	})

	it('sockets lists a socket in several rooms once', () => {
		const list = new Rooms(Room)
		const s = fakeSocket('s')
		const t = fakeSocket('t')
		list.join(s, 'a')
		list.join(s, 'b')
		list.join(t, 'b')
		assert.deepEqual(list.sockets, new Set([s, t]))
	})
})
