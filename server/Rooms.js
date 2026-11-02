import { parent } from './constants.js'
import { Emitter } from './Emitter.js'

export class Rooms extends Emitter {
	constructor(RoomClass) {
		super()

		this.RoomClass = RoomClass
		this.rooms = new Map()
	}

	/** Every socket across every room, each once. */
	get sockets() {
		const unique = new Set()
		for (const room of this.rooms.values()) {
			for (const s of room.sockets) unique.add(s)
		}
		return unique
	}

	/**
	 * Fan out room by room instead of through `sockets`, so nothing is
	 * allocated per call. A socket in several rooms is reached more than
	 * once; the loop runs synchronously, so if `d` is already the last
	 * message it queued, it got this one.
	 */
	broadcast(me, k, v) {
		/** @type {[string, any]} */
		const d = [k, v]
		for (const room of this.rooms.values()) {
			for (const socket of room.sockets) {
				if (me != socket && socket.messages.at(-1) !== d) {
					socket.emit(d)
				}
			}
		}
	}

/** Array of every room in this list. */
	get list() {
		return [...this.rooms.values()]
	}

	get(id) {
		return this.rooms.get(id)
	}

	join(socket, id = undefined) {
		// Don't create a room for a socket `Room.join` would turn away.
		if (socket.closed) return
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

	toJSON() {
		return this.list
	}
}
