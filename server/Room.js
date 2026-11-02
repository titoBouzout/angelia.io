import { Emitter } from './Emitter.js'
import { parent } from './constants.js'

export class Room extends Emitter {
	/** @type {Set<import('./Socket.js').Socket>} */
	sockets = new Set()
	id
	persistent = false

	onCreate(socket) {}
	onDelete(socket) {}
	onJoin(socket) {}
	onLeave(socket) {}

	join(socket) {
		// Joining after disconnect would never be undone: `onclose` already ran.
		if (socket.closed || this.sockets.has(socket)) return
		this.sockets.add(socket)
		socket.rooms.add(this)
		this[parent]?.sockets.add(socket)
		this.onJoin(socket)
	}
	leave(socket) {
		if (!this.sockets.delete(socket)) return
		socket.rooms.delete(this)
		const list = this[parent]
		if (list && !inList(socket, list)) list.sockets.delete(socket)
		this.onLeave(socket)
	}
}

/**
 * Whether `socket` is still in another room of `list`. Walks the
 * socket's own rooms, which stay few, not the list's members.
 */
function inList(socket, list) {
	for (const room of socket.rooms) {
		if (room[parent] === list) return true
	}
	return false
}
