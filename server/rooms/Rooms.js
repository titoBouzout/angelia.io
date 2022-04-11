'use strict'

const { add, remove } = require('./constants.js')

class Rooms {
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

module.exports = Rooms
