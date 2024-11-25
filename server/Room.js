import { join, leave } from './constants.js'

import { Emitter } from './Emitter.js'

export class Room extends Emitter {
	id
	persistent

	/** @param socket {import('./Socket.js').Socket} */
	onCreate(socket) {}
	/** @param socket {import('./Socket.js').Socket} */
	onDelete(socket) {}
	/** @param socket {import('./Socket.js').Socket} */
	onJoin(socket) {}
	/** @param socket {import('./Socket.js').Socket} */
	onLeave(socket) {}

	/** @param socket {import('./Socket.js').Socket} */
	[join](socket) {
		this.sockets.add(socket)

		socket.rooms.add(this)

		this.onJoin(socket)
	}
	/** @param socket {import('./Socket.js').Socket} */
	[leave](socket) {
		this.sockets.delete(socket)

		socket.rooms.delete(this)

		this.onLeave(socket)
	}

	[Symbol.iterator]() {
		return this.sockets
	}
}
