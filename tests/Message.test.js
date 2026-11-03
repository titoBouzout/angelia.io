import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { Message } from '../server/index.js'
import { Room } from '../server/Room.js'
import { Server } from '../server/Server.js'
import { Socket } from '../server/Socket.js'

/** A socket that records the tuples it is given, without a connection. */
const fakeSocket = () => {
	const queued = []
	return /** @type {any} */ ({ queue: tuple => queued.push(tuple), queued })
}

const text = frames => Buffer.concat(frames).subarray(2).toString()

describe('Message', () => {
	it('encodes as it is made, so later changes never reach the wire', () => {
		const value = { a: 1 }
		const message = new Message('k', value)
		value.a = 2
		assert.equal(message.json, '["k",{"a":1}]')
		assert.equal(text(new Server().cacheMessages([message.tuple])), '[["k",{"a":1}]]')
	})

	it('encodes equal messages to equal text', () => {
		assert.equal(new Message('k', [1]).json, new Message('k', [1]).json)
		assert.notEqual(new Message('k', [1]).json, new Message('k', [2]).json)
	})

	it('reads toJSON once however many times it is sent', () => {
		let reads = 0
		const message = new Message('k', { toJSON: () => ++reads })
		const server = new Server()
		server.cacheMessages([message.tuple])
		server.cacheMessages([message.tuple])
		server.cacheMessages([['other', 1], message.tuple])
		assert.equal(reads, 1)
	})

	it('keeps its frame across ticks', async () => {
		const server = new Server()
		const message = new Message('k', 'v')
		const frames = server.cacheMessages([message.tuple])
		server.nextQueue(/** @type {any} */ ({ processQueue() {} }))
		await new Promise(resolve => setImmediate(resolve))
		assert.equal(server.cacheMessages([message.tuple]), frames)
		assert.equal(server.messagesSentCacheHit, 1)
	})

	it('send reaches every socket, sendExcept all but one, with the same tuple', () => {
		const room = new Room()
		const a = fakeSocket()
		const b = fakeSocket()
		room.sockets.add(a)
		room.sockets.add(b)
		const message = new Message('k', 'v')
		room.send(message)
		room.sendExcept(a, message)
		assert.deepEqual(a.queued, [message.tuple])
		assert.deepEqual(b.queued, [message.tuple, message.tuple])
		assert.equal(b.queued[0], message.tuple)
	})

	it('socket.send queues the tuple', () => {
		const socket = fakeSocket()
		const message = new Message('k', 'v')
		Socket.prototype.send.call(socket, message)
		assert.deepEqual(socket.queued, [message.tuple])
	})
})

describe('Server.cacheMessages encoding', () => {
	const values = [undefined, null, 0, '', 'é ✓', [1, [2]], { a: { b: [] } }]

	it('writes the same text as stringifying the batch', () => {
		for (const value of values) {
			const tuple = ['k', value]
			assert.equal(text(new Server().cacheMessages([tuple])), JSON.stringify([tuple]))
			const batch = [['first', 1], ['k', value], ['last', value, 7]]
			assert.equal(text(new Server().cacheMessages(batch)), JSON.stringify(batch))
		}
	})

	it('stringifies a tuple once across the batches it lands in', () => {
		let reads = 0
		const tuple = ['k', { toJSON: () => ++reads }]
		const server = new Server()
		server.cacheMessages([tuple])
		server.cacheMessages([['a', 1], tuple])
		server.cacheMessages([['b', 2], tuple])
		assert.equal(reads, 1)
	})

	it('reads a plain tuple as it drains, not as it is emitted', () => {
		let value = 'before'
		const tuple = ['k', { toJSON: () => value }]
		value = 'after'
		assert.equal(text(new Server().cacheMessages([tuple])), '[["k","after"]]')
	})
})

