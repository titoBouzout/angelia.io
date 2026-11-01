import { Emitter } from './Emitter.js'
import { remove } from './utils.js'

export class Room extends Emitter {
	sockets = []
	id
	persistent = false

	onCreate(socket) {}
	onDelete(socket) {}
	onJoin(socket) {}
	onLeave(socket) {}

	join(socket) {
		// Joining after disconnect would never be undone: `onclose` already ran.
		if (socket.closed) return
		if (this.sockets.indexOf(socket) === -1) {
			this.sockets.push(socket)
			socket.rooms.push(this)
			this.onJoin(socket)
		}
	}
	leave(socket) {
		if (this.sockets.indexOf(socket) !== -1) {
			remove(this.sockets, socket)
			remove(socket.rooms, this)
			this.onLeave(socket)
		}
	}
}
