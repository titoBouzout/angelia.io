'use strict';

const inspect = Symbol.for('nodejs.util.inspect.custom');

const listeners = Symbol.for('Room.listeners');
const parent = Symbol.for('Room.parent');
const id = Symbol.for('Room.id');

const Listeners = require('./Listeners.js');
const Room = require('./Room.js');

class Rooms {
	constructor(path) {
		this.path = path;
		this.rooms = new Map();
		this[listeners] = new Listeners();
	}
	on(k, cb) {
		this[listeners].on(k, cb);
	}
	has(id) {
		return this.rooms.has(id);
	}
	get(id) {
		return this.rooms.get(id);
	}
	keys() {
		return this.rooms.keys();
	}
	create(id, socket) {
		let room = new Room(this, id, socket);
		this.rooms.set(id, room);

		this[listeners].events.create && this[listeners].events.create(this, room, socket);

		return room;
	}
	delete(room, socket) {
		this.rooms.delete(room[id]);
		this[listeners].events.delete && this[listeners].events.delete(this, room, socket);
	}
	emit(k, v) {
		let d = [k, v];

		for (let [id, room] of this.rooms) {
			for (let socket of room.users) {
				socket.emit(d);
			}
		}
	}
	once(k, v) {
		let d = [k, v];

		for (let [id, room] of this.rooms) {
			for (let socket of room.users) {
				socket.once(d);
			}
		}
	}
	broadcast(me, k, v) {
		let d = [k, v];

		for (let [id, room] of this.rooms) {
			for (let socket of room.users) {
				if (me != socket) {
					socket.emit(d);
				}
			}
		}
	}
	broadcastOnce(me, k, v) {
		let d = [k, v];

		for (let [id, room] of this.rooms) {
			for (let socket of room.users) {
				if (me != socket) {
					socket.once(d);
				}
			}
		}
	}
}

module.exports = Rooms;
