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

describe('Rooms.toJSON', () => {
	it('returns an array of the rooms', () => {
		const list = new Rooms(Room)
		list.join(fakeSocket('a'), 'r1')
		list.join(fakeSocket('b'), 'r2')
		const json = list.toJSON()
		assert.ok(Array.isArray(json))
		assert.deepEqual(
			json.map(r => r.id),
			['r1', 'r2'],
		)
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

describe('Rooms deleting a room', () => {
	it('detaches it, so joins through a kept reference stay out of the list', () => {
		const list = new Rooms(Room)
		const a = fakeSocket('a')
		list.join(a, 'tmp')
		const kept = list.get('tmp')
		assert.ok(kept)
		list.leave(a, 'tmp')
		assert.equal(list.get('tmp'), undefined)

		const b = fakeSocket('b')
		kept.join(b)
		assert.deepEqual(kept.sockets, new Set([b]))
		assert.deepEqual(list.sockets, new Set())
	})
})

describe('Room.leave in a Rooms list', () => {
	it('deletes the room its last socket leaves, firing onDelete with that socket', () => {
		const deleted = []
		class R extends Room {
			onDelete(socket) {
				deleted.push(socket.id)
			}
		}
		const list = new Rooms(R)
		const a = fakeSocket('a')
		list.join(a, 'r')
		list.get('r')?.leave(a)
		assert.equal(list.get('r'), undefined)
		assert.equal(list.sockets.has(a), false)
		assert.deepEqual(deleted, ['a'])
	})

	it('keeps a persistent room', () => {
		class R extends Room {
			persistent = true
		}
		const list = new Rooms(R)
		const a = fakeSocket('a')
		list.join(a, 'r')
		list.get('r')?.leave(a)
		assert.ok(list.get('r'))
	})

	it('keeps a room that onLeave joined someone to', () => {
		const b = fakeSocket('b')
		class R extends Room {
			onLeave() {
				this.join(b)
			}
		}
		const list = new Rooms(R)
		const a = fakeSocket('a')
		list.join(a, 'r')
		list.get('r')?.leave(a)
		assert.ok(list.get('r')?.sockets.has(b))
	})

	it('a socket not in the room changes nothing', () => {
		let deletes = 0
		class R extends Room {
			persistent = false
			onDelete() {
				deletes++
			}
		}
		const list = new Rooms(R)
		const a = fakeSocket('a')
		list.join(a, 'r')
		list.leave(fakeSocket('other'), 'r')
		assert.ok(list.get('r')?.sockets.has(a))
		assert.equal(deletes, 0)
	})

	it('deletes once when the socket leaves through the list', () => {
		let deletes = 0
		class R extends Room {
			onDelete() {
				deletes++
			}
		}
		const list = new Rooms(R)
		const a = fakeSocket('a')
		list.join(a, 'r')
		list.leave(a, 'r')
		list.leave(a, 'r')
		assert.equal(deletes, 1)
	})
})

describe('Rooms.join with a failing onCreate', () => {
	class R extends Room {
		onCreate(socket) {
			if (socket.id == 'bad') throw new Error('no')
			this.ready = true
		}
	}

	it('rethrows, lists no room and joins no one', () => {
		const list = new Rooms(R)
		const bad = fakeSocket('bad')
		assert.throws(() => list.join(bad, 'r'), /no/)
		assert.equal(list.get('r'), undefined)
		assert.equal(list.sockets.has(bad), false)
		assert.equal(bad.rooms.size, 0)
	})

	it('finds itself on the list as it runs', () => {
		let found
		const list = new Rooms(
			class extends Room {
				onCreate() {
					found = list.get('r') === this
				}
			},
		)
		list.join(fakeSocket('a'), 'r')
		assert.equal(found, true)
	})

	it('runs no onDelete, and the next to join creates it anew', () => {
		let deletes = 0
		class Counted extends R {
			onDelete() {
				deletes++
			}
		}
		const list = new Rooms(Counted)
		assert.throws(() => list.join(fakeSocket('bad'), 'r'))
		assert.equal(deletes, 0)
		list.join(fakeSocket('good'), 'r')
		assert.equal(list.get('r')?.ready, true)
	})
})

describe('Rooms.of', () => {
	it('yields only the rooms of this list the socket is in', () => {
		const chats = new Rooms(Room)
		const games = new Rooms(Room)
		const a = fakeSocket('a')
		chats.join(a, 'one')
		chats.join(a, 'two')
		chats.join(fakeSocket('b'), 'three')
		// the same id in another list, and a lone room, aren't this list's
		games.join(a, 'one')
		new Room().join(a)
		assert.deepEqual([...chats.of(a)].map(room => room.id), ['one', 'two'])
		assert.deepEqual([...games.of(a)].map(room => room.id), ['one'])
		assert.deepEqual([...new Rooms(Room).of(a)], [])
	})

	it('allows leaving as it iterates', () => {
		const chats = new Rooms(Room)
		const a = fakeSocket('a')
		chats.join(a, 'one')
		chats.join(a, 'two')
		for (const room of chats.of(a)) room.leave(a)
		assert.equal(a.rooms.size, 0)
		assert.equal(chats.rooms.size, 0)
	})
})
