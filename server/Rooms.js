import { parent } from './constants.js'
import { Emitter } from './Emitter.js'

/** @import { Room } from './Room.js' */
/** @import { Socket } from './Socket.js' */

/**
 * A list of rooms created and deleted on demand as sockets join and
 * leave them by id.
 *
 * @template {Room} [R=Room]
 */
export class Rooms extends Emitter {
	/** @param {new () => R} RoomClass Class of the rooms it creates */
	constructor(RoomClass) {
		super()

		this.RoomClass = RoomClass
		/** @type {Map<any, R>} Every room in this list, by id. */
		this.rooms = new Map()
		/**
		 * Every socket across every room, each once. Kept up to date by
		 * `Room.join` / `Room.leave`, so reading it costs nothing.
		 *
		 * @type {Set<Socket>}
		 */
		this.sockets = new Set()
	}

	/**
	 * @param {any} id
	 * @returns {R | undefined}
	 */
	get(id) {
		return this.rooms.get(id)
	}

	/**
	 * Join `socket` to room `id`, creating the room if needed.
	 *
	 * @param {Socket} socket
	 * @param {any} [id]
	 */
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

	/**
	 * Remove `socket` from room `id`; an emptied room is deleted unless
	 * it's `persistent`.
	 *
	 * @param {Socket} socket
	 * @param {any} [id]
	 */
	leave(socket, id = undefined) {
		const room = this.rooms.get(id)
		if (room) {
			room.leave(socket)
			if (!room.persistent && room.sockets.size === 0) {
				this.rooms.delete(id)
				room.onDelete(socket)
				// Joins through a kept reference no longer reach this list.
				room[parent] = undefined
			}
		}
	}

	/** @returns {R[]} */
	toJSON() {
		return [...this.rooms.values()]
	}
}
