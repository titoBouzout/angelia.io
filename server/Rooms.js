import { join, leave } from './constants.js'

export class Rooms {
	/** @param {Object} RoomClass */
	constructor(RoomClass) {
		this.RoomClass = RoomClass
		this.rooms = new Map()
	}
	get(id) {
		return this.rooms.get(id)
	}
	join(socket, id = undefined) {
		let room = this.rooms.get(id)
		if (!room) {
			room = new this.RoomClass()
			room.id = room.id || id
			this.rooms.set(id, room)

			room.onCreate(socket)
		}

		room[join](socket)
	}
	leave(socket, id = undefined) {
		const room = this.rooms.get(id)
		if (room) {
			room[leave](socket)
			if (!room.persistent && room.sockets.size === 0) {
				this.rooms.delete(id)
				room.onDelete(socket)
			}
		}
	}

	[Symbol.iterator]() {
		return this.rooms.values()
	}
}
