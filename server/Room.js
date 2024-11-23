import { join, leave } from './constants.js'

import { Emitter } from './Emitter.js'

export class Room extends Emitter {
	id
	persistent

	onCreate(socket) {}
	onDelete(socket) {}
	onJoin(socket) {}
	onLeave(socket) {}

	[join](socket) {
		this.sockets.add(socket)

		socket.rooms.add(this)

		this.onJoin(socket)
	}
	[leave](socket) {
		this.sockets.delete(socket)

		socket.rooms.delete(this)

		this.onLeave(socket)
	}

	[Symbol.iterator]() {
		return this.sockets
	}
}
