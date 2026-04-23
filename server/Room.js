import { Emitter } from './Emitter.js'
import { remove } from './utils.js'

export class Room extends Emitter {
	/** @type {import('./Socket.js').Socket[]} */
	sockets = []

	/** @type {any} */
	id
	persistent = false

	/** @param {import('./Socket.js').Socket} socket */
	onCreate(socket) {}
	/** @param {import('./Socket.js').Socket} socket */
	onDelete(socket) {}
	/** @param {import('./Socket.js').Socket} socket */
	onJoin(socket) {}
	/** @param {import('./Socket.js').Socket} socket */
	onLeave(socket) {}

	/** @param {import('./Socket.js').Socket} socket */
	join(socket) {
		if (this.sockets.indexOf(socket) === -1) {
			this.sockets.push(socket)
			socket.rooms.push(this)
			this.onJoin(socket)
		}
	}
	/** @param {import('./Socket.js').Socket} socket */
	leave(socket) {
		if (this.sockets.indexOf(socket) !== -1) {
			remove(this.sockets, socket)
			remove(socket.rooms, this)
			this.onLeave(socket)
		}
	}
}
