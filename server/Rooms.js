import { parent } from './constants.js'
import { Emitter } from './Emitter.js'
import { arrayFrom } from './utils.js'

export class Rooms extends Emitter {
	/** @param {Object} RoomClass */
	constructor(RoomClass) {
		super()

		this.RoomClass = RoomClass
		this.rooms = new Map()

		Object.defineProperty(this, 'sockets', {
			get: this.Sockets.bind(this),
			enumerable: true,
		})
	}

	get(id) {
		return this.rooms.get(id)
	}

	join(socket, id = undefined) {
		let room = this.rooms.get(id)
		if (!room) {
			room = new this.RoomClass()
			room[parent] = this
			room.id = id
			this.rooms.set(id, room)

			room.onCreate(socket)
		}
		room.join(socket)
	}

	leave(socket, id = undefined) {
		const room = this.rooms.get(id)
		if (room) {
			room.leave(socket)
			if (!room.persistent && room.sockets.size === 0) {
				this.rooms.delete(id)
				room.onDelete(socket)
			}
		}
	}

	get connections() {
		let count = 0
		for (const room of this.rooms.values()) {
			count += room.sockets.size
		}
		return count
	}

	*Sockets() {
		for (const room of this.rooms.values()) {
			for (const socket of room.sockets) {
				yield socket
			}
		}
	}

	map(fn) {
		return arrayFrom(this.rooms.values(), fn)
	}
	filter(fn) {
		return this.map().filter(fn)
	}
	toJSON() {
		return this.map()
	}
	[Symbol.iterator]() {
		return this.rooms.values()
	}
}
