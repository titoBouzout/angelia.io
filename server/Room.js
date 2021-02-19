'use strict';

const inspect = Symbol.for('nodejs.util.inspect.custom');

const listeners = Symbol.for('Room.listeners');
const parent = Symbol.for('Room.parent');
const id = Symbol.for('Room.id');
const join = Symbol.for('Room.join');
const leave = Symbol.for('Room.leave');
const proto = Symbol.for('Room.proto');
const property = Symbol.for('Room.property');

const Listeners = require('./Listeners.js');

class Room {
	constructor(aParent, i, socket) {
		this[listeners] = new Listeners();
		this[parent] = aParent;
		this[id] = i;
		this.users = [];

		// copy this.user = []
		Object.assign(i, this);

		// copy methods
		if (typeof i === 'object' && !i.__proto__[proto]) {
			i.__proto__[proto] = true;

			for (let m of Object.getOwnPropertyNames(this.__proto__)) {
				if (m != 'constructor') {
					i.__proto__[m] = this.__proto__[m];
				}
			}
		}
	}
	on(k, cb) {
		this[listeners].on(k, cb);
	}
	[join](socket) {
		this.users.push(socket);

		let events = this[listeners].events;
		let parentEvents = this[parent][listeners].events;

		events.join && events.join(this, socket);
		parentEvents.join && parentEvents.join(this[parent], this, socket);

		events.update && events.update(this);
		parentEvents.update && parentEvents.update(this[parent], this);
	}
	[leave](socket) {
		this.users.splice(this.users.indexOf(socket), 1);

		let events = this[listeners].events;
		let parentEvents = this[parent][listeners].events;

		events.leave && events.leave(this, socket);
		parentEvents.leave && parentEvents.leave(this[parent], this, socket);

		events.update && events.update(this);
		parentEvents.update && parentEvents.update(this[parent], this);

		if (this.users.length === 0) {
			this[parent].delete(this, socket);
		}
	}
	[property](name, oldValue, newValue) {
		let events = this[listeners].events;
		let parentEvents = this[parent][listeners].events;

		events.property && events.property(this, name, oldValue, newValue);
		parentEvents.property && parentEvents.property(this[parent], this, name, oldValue, newValue);

		events.update && events.update(this);
		parentEvents.update && parentEvents.update(this[parent], this);
	}
	emit(k, v) {
		// lala
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
	[inspect]() {
		return {
			id: this[id],
			users: this.users,
		};
	}
}

module.exports = Room;
