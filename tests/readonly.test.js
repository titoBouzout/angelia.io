import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { WebSocket } from 'ws'

import { Room } from '../server/Room.js'
import { Rooms } from '../server/Rooms.js'
import { bootServer, waitFor } from './helpers.js'

const read_only = (object, fields) => {
	for (const field of fields) {
		const value = object[field]
		assert.throws(() => (object[field] = 'changed'), TypeError, field)
		assert.equal(object[field], value, field)
	}
}

describe('what angelia keeps is read from outside, never written', () => {
	let s, client, socket

	before(async () => {
		s = await bootServer()
		client = new WebSocket(s.url)
		await waitFor(() => s.server.sockets.size === 1)
		;[socket] = s.server.sockets
	})
	after(async () => {
		client.close()
		await s.stop()
	})

	it('Socket', () => {
		read_only(socket, ['server', 'io', 'ip', 'userAgent', 'params', 'since', 'seen', 'timedout', 'closed', 'rooms', 'bytesSent', 'bytesReceived', 'messagesSent', 'messagesReceived', 'pendingReplies'])
	})

	it('Server', () => {
		read_only(s.server, ['sockets', 'hostname', 'port', 'path', 'maxMessageSize', 'trustProxy', 'since', 'now', 'served', 'bytesSent', 'bytesReceived', 'messagesSent', 'messagesReceived', 'messagesSentCacheHit', 'messagesGarbage', 'serverErrors', 'socketErrors', 'events', 'hooks', 'io', 'httpServer'])
	})

	it('Rooms and Room', () => {
		read_only(new Rooms(Room), ['RoomClass', 'rooms', 'sockets'])
		read_only(new Room(), ['sockets'])
	})

	it('a socket keeps what its user adds', () => {
		socket.game = 'mine'
		assert.equal(socket.game, 'mine')
		delete socket.game
	})

	it('a room keeps what its subclass adds, its id among them', () => {
		class Mine extends Room {
			id = 'lobby'
			persistent = true
			name = 'mine'
		}
		const room = new Mine()
		assert.deepEqual({ id: room.id, persistent: room.persistent, name: room.name }, { id: 'lobby', persistent: true, name: 'mine' })
		room.name = 'renamed'
		assert.equal(room.name, 'renamed')
	})

	it('nothing of angelia\'s shows in a socket\'s own fields', () => {
		for (const field of ['ip', 'rooms', 'messages', 'callbacks', 'server', 'io', 'closed']) assert.ok(!Object.keys(socket).includes(field), field)
	})
})

describe('Room.reorder', () => {
	const fake = id => /** @type {any} */ ({ id, rooms: new Set() })

	it('puts the sockets it names last, in that order, running no hook', () => {
		let hooks = 0
		class Counted extends Room {
			onJoin() {
				hooks++
			}
			onLeave() {
				hooks++
			}
		}
		const room = new Counted()
		const [a, b, c] = ['a', 'b', 'c'].map(fake)
		for (const socket of [a, b, c]) room.join(socket)
		hooks = 0
		room.reorder([a])
		assert.deepEqual([...room.sockets], [b, c, a])
		room.reorder([c, a, b])
		assert.deepEqual([...room.sockets], [c, a, b])
		assert.equal(hooks, 0)
	})

	it('adds no one who is not in the room', () => {
		const room = new Room()
		const [a, stranger] = ['a', 'b'].map(fake)
		room.join(a)
		room.reorder([stranger, a])
		assert.deepEqual([...room.sockets], [a])
	})
})
