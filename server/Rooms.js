import { join, leave } from './constants.js'

export class Rooms {
	constructor(Room) {
		this.Room = Room
		this.rooms = new Map()
	}
	join(socket, id = undefined) {
		let room = this.rooms.get(id)
		if (!room) {
			room = new this.Room()
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

			if (!room.persistent && room.size === 0) {
				room.onDelete(socket)
				this.rooms.delete(id)
			}
		}
	}

	[Symbol.iterator]() {
		return this.rooms.values()
	}
}
