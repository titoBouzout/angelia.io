'use strict';

const join = Symbol.for('Room.join');
const leave = Symbol.for('Room.leave');
const parent = Symbol.for('Room.parent');

class Room {
	constructor() {
		this.users = [];
	}
	has(socket) {
		return this.users.indexOf(socket) !== -1;
	}
	[join](socket) {
		// add user
		this.users.push(socket);

		// dispatch join
		this.join && this.join(socket);

		// to be able to list rooms for socket
		socket.rooms.add(this);
	}
	[leave](socket) {
		// remove user
		let index = this.users.indexOf(socket);
		if (index !== -1) this.users.splice(index, 1);

		// to be able to list rooms for socket
		socket.rooms.delete(this);

		// dispatch leave
		this.leave && this.leave(socket);

		// check removal
		if (this.users.length === 0 && !this.persistent) {
			// remove room from list
			this[parent].delete(this);
			// dispatch that the room has been deleted
			this.delete && this.delete();
		}
	}
	emit(k, v) {
		let d = [k, v];

		for (let socket of this.users) {
			socket.emit(d);
		}
	}
	once(k, v) {
		let d = [k, v];

		for (let socket of this.users) {
			socket.once(d);
		}
	}
	broadcast(me, k, v) {
		let d = [k, v];

		for (let socket of this.users) {
			if (me != socket) socket.emit(d);
		}
	}
	broadcastOnce(me, k, v) {
		let d = [k, v];

		for (let socket of this.users) {
			if (me != socket) socket.once(d);
		}
	}
}

module.exports = Room;
