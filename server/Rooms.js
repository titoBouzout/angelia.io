'use strict';

const parent = Symbol.for('Room.parent');

class Rooms {
	constructor(path) {
		this.path = path;
		this.rooms = [];
		this.roomsById = new Map();
	}

	has(room) {
		return this.rooms.indexOf(room) !== -1;
	}

	get(id) {
		return this.roomsById.get(id);
	}

	add(room) {
		this.create(room);
	}

	create(room) {
		if (!this.has(room)) {
			this.rooms.push(room);
			this.roomsById.set(room.id, room);

			room[parent] = this;
		}
	}
	delete(room) {
		if (!room.persistent) {
			let index = this.rooms.indexOf(room);
			if (index !== -1) this.rooms.splice(index, 1);

			this.roomsById.delete(room.id);
		}
	}

	emit(k, v) {
		let d = [k, v];

		for (let room of this.rooms) {
			for (let socket of room.users) {
				socket.emit(d);
			}
		}
	}
	once(k, v) {
		let d = [k, v];

		for (let room of this.rooms) {
			for (let socket of room.users) {
				socket.once(d);
			}
		}
	}
	broadcast(me, k, v) {
		let d = [k, v];

		for (let room of this.rooms) {
			for (let socket of room.users) {
				if (me != socket) {
					socket.emit(d);
				}
			}
		}
	}
	broadcastOnce(me, k, v) {
		let d = [k, v];

		for (let room of this.rooms) {
			for (let socket of room.users) {
				if (me != socket) {
					socket.once(d);
				}
			}
		}
	}

	toJSON() {
		return this.rooms;
	}

	[Symbol.iterator]() {
		return this.rooms;
	}
}

module.exports = Rooms;