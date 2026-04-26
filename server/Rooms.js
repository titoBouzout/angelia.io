import { parent } from './constants.js'
import { Emitter } from './Emitter.js'

export class Rooms extends Emitter {
	constructor(RoomClass) {
		super()

		this.RoomClass = RoomClass
		this.rooms = new Map()
	}

	/** Every socket across every room, flattened into one array. */
	get sockets() {
		const out = []
		for (const room of this.rooms.values()) {
			for (const s of room.sockets) out.push(s)
		}
		return out
	}

/** Array of every room in this list. */
	get list() {
		return [...this.rooms.values()]
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
			if (!room.persistent && room.sockets.length === 0) {
				this.rooms.delete(id)
				room.onDelete(socket)
			}
		}
	}

	toJSON() {
		return this.list
	}
}
