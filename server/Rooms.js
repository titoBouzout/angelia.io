import { parent } from './constants.js'
import { Emitter } from './Emitter.js'

/** @template {import('./Room.js').Room} R */
export class Rooms extends Emitter {
	/** @param {new () => R} RoomClass */
	constructor(RoomClass) {
		super()

		this.RoomClass = RoomClass
		/** @type {Map<any, R>} */
		this.rooms = new Map()
	}

	/** @returns {import('./Socket.js').Socket[]} */
	get sockets() {
		const out = []
		for (const room of this.rooms.values()) {
			for (const s of room.sockets) out.push(s)
		}
		return out
	}

	/** @param {any} id */
	get(id) {
		return this.rooms.get(id)
	}

	/**
	 * @param {import('./Socket.js').Socket} socket
	 * @param {any} [id]
	 */
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

	/**
	 * @param {import('./Socket.js').Socket} socket
	 * @param {any} [id]
	 */
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

	get connections() {
		let count = 0
		for (const room of this.rooms.values()) {
			count += room.sockets.length
		}
		return count
	}

	/** @returns {R[]} */
	get list() {
		return [...this.rooms.values()]
	}

	toJSON() {
		return this.list
	}
}
