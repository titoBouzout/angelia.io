'use strict'

const { join, leave, parent } = require('./constants.js')

class Room {
	constructor() {
		this.users = []
	}
	has(socket) {
		return this.users.indexOf(socket) !== -1
	}
	[join](roomList, socket) {
		// add to list of room list
		if (!this[parent]) {
			this[parent] = roomList
			this[parent].add(this)
		}

		// add user
		this.users.push(socket)

		// to be able to list rooms for socket
		socket.rooms.add(this)

		if (this.users.length === 1) {
			// dispatch create
			this.create && this.create(socket)
		}

		// dispatch join
		this.join && this.join(socket)
	}
	[leave](socket) {
		// remove user
		let index = this.users.indexOf(socket)
		if (index !== -1) this.users.splice(index, 1)

		// to be able to list rooms for socket
		socket.rooms.delete(this)

		// check removal
		if (this.users.length === 0 && !this.persistent) {
			// remove room from list
			this[parent].delete(this)

			// dispatch leave
			this.leave && this.leave(socket)

			// dispatch that the room has been deleted
			this.delete && this.delete(socket)
		} else {
			// dispatch leave
			this.leave && this.leave(socket)
		}
	}

	emit(k, v) {
		let d = [k, v]

		for (let socket of this.users) {
			socket.emit(d)
		}
	}
	once(k, v) {
		let d = [k, v]

		for (let socket of this.users) {
			socket.once(d)
		}
	}
	broadcast(me, k, v) {
		let d = [k, v]

		for (let socket of this.users) {
			if (me != socket) socket.emit(d)
		}
	}
	broadcastOnce(me, k, v) {
		let d = [k, v]

		for (let socket of this.users) {
			if (me != socket) socket.once(d)
		}
	}

	[Symbol.iterator]() {
		return this.users
	}
}

module.exports = Room
