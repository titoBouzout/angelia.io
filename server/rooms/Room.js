'use strict'

const { join, leave, parent, add, remove } = require('./constants.js')

class Room {
	constructor() {
		this.sockets = new Set()
	}
	has(socket) {
		return this.sockets.has(socket)
	}
	[join](roomList, socket) {
		// add to list of room list
		if (!this[parent]) {
			this[parent] = roomList
			this[parent][add](this)
		}

		// add user
		this.sockets.add(socket)

		// to be able to list rooms for a socket
		socket.rooms.add(this)

		// if the room has the property "persistent"
		// then maybe the room is old and someone just joined
		// for this reason we dont dispatch onCreate for persistent rooms
		// as that would be misleading
		if (!this.persistent && this.sockets.size === 1) {
			// dispatch create
			this.onCreate && this.onCreate(socket)
		}

		// dispatch join
		this.onJoin && this.onJoin(socket)
	}
	[leave](socket) {
		// remove user
		this.sockets.delete(socket)

		// to be able to list rooms for socket
		socket.rooms.delete(this)

		// check room deletion
		if (!this.persistent && this.sockets.size === 0) {
			// remove room from list
			this[parent][remove](this)

			// dispatch leave
			this.onLeave && this.onLeave(socket)

			// dispatch that the room has been deleted
			this.onDelete && this.onDelete(socket)
		} else {
			// dispatch leave
			this.onLeave && this.onLeave(socket)
		}
	}

	emit(k, v) {
		let d = [k, v]

		for (let socket of this.sockets) {
			socket.emit(d)
		}
	}
	once(k, v) {
		let d = [k, v]

		for (let socket of this.sockets) {
			socket.once(d)
		}
	}
	broadcast(me, k, v) {
		let d = [k, v]

		for (let socket of this.sockets) {
			if (me != socket) socket.emit(d)
		}
	}
	broadcastOnce(me, k, v) {
		let d = [k, v]

		for (let socket of this.sockets) {
			if (me != socket) socket.once(d)
		}
	}

	toJSON() {
		return this.sockets
	}
	[Symbol.iterator]() {
		return this.sockets[Symbol.iterator]()
	}
}

module.exports = Room
