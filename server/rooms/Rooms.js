import { add, remove } from './constants.js'

export class Rooms {
	constructor(path) {
		Object.assign(this, {
			path: path,
			rooms: new Set(),
			roomsById: new Map(),
		})
	}

	get(id) {
		return this.roomsById.get(id)
	}
	get size() {
		return this.rooms.size
	}
	// private
	[add](room) {
		if (!this.rooms.has(room)) {
			this.rooms.add(room)
			this.roomsById.set(room.id, room)
		}
	}
	[remove](room) {
		this.rooms.delete(room)
		this.roomsById.delete(room.id)
	}

	toJSON() {
		return this.rooms
	}
	[Symbol.iterator]() {
		return this.rooms[Symbol.iterator]()
	}
}
