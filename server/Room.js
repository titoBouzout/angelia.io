import { Emitter } from './Emitter.js'

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
		this.onJoin(socket)
	}
	leave(socket) {
		if (!this.sockets.delete(socket)) return
		socket.rooms.delete(this)
		this.onLeave(socket)
	}
}
