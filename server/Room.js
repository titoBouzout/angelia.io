import { Emitter } from './Emitter.js'
import { parent } from './constants.js'

/** @import { Socket } from './Socket.js' */
/** @import { Rooms } from './Rooms.js' */

/** A group of sockets to emit to; subclass it to hook its lifecycle. */
export class Room extends Emitter {
	/** @type {Set<Socket>} */
	#sockets = new Set()
	/** @type {any} Set by `Rooms` for its rooms; yours to set otherwise. */
	id
	/** @type {Rooms<any> | undefined} The list the room belongs to, if any. */
	;[parent]

	/**
	 * Off the room's own fields, as a subclass may spread its fields into
	 * what it sends.
	 */
	get sockets() {
		return this.#sockets
	}

	/**
	 * Called when a `Rooms` list creates the room for `socket`.
	 *
	 * @param {Socket} socket
	 */
	onCreate(socket) {}
	/**
	 * Called when a `Rooms` list deletes the room after `socket` left.
	 *
	 * @param {Socket} socket
	 */
	onDelete(socket) {}
	/** @param {Socket} socket */
	onJoin(socket) {}
	/** @param {Socket} socket */
	onLeave(socket) {}

	/** @param {Socket} socket */
	join(socket) {
		// Joining after disconnect would never be undone: `onclose` already ran.
		if (socket.closed || this.sockets.has(socket)) return
		this.sockets.add(socket)
		socket.rooms.add(this)
		this[parent]?.sockets.add(socket)
		this.onJoin(socket)
	}
	/**
	 * Leave the room; a room in a `Rooms` list that this empties is deleted
	 * unless it's `persistent`.
	 *
	 * @param {Socket} socket
	 */
	leave(socket) {
		if (!this.sockets.delete(socket)) return
		socket.rooms.delete(this)
		const list = this[parent]
		if (list && !inList(socket, list)) list.sockets.delete(socket)
		this.onLeave(socket)
		if (list && !this.persistent && this.sockets.size === 0) {
			list.rooms.delete(this.id)
			this.onDelete(socket)
			// Joins through a kept reference no longer reach this list.
			this[parent] = undefined
		}
	}
}

/** Keep the room in its `Rooms` list when its last socket leaves. */
Room.prototype.persistent = false

/**
 * Whether `socket` is still in another room of `list`. Walks the
 * socket's own rooms, which stay few, not the list's members.
 *
 * @param {Socket} socket
 * @param {Rooms<any>} list
 */
function inList(socket, list) {
	for (const room of socket.rooms) {
		if (room[parent] === list) return true
	}
	return false
}
