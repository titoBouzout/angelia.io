'use strict';

const join = Symbol.for('Room.join');
const leave = Symbol.for('Room.leave');
const property = Symbol.for('Room.property');

const proxied = Symbol.for('Tracker.proxied');

const Rooms = require('./Rooms.js');
const Room = require('./Room.js');

class Tracker {
	constructor() {
		// to keep track of paths
		this.tracking = {}; // full path
		this.paths = {}; // path tree as string
		this.pathsObject = {}; // path tree as object

		this.roomTrack = {};

		// to remove from everywhere on disconnect
		this.sockets = new Map();
	}
	track(path) {
		let root = '.' + path;

		this.tracking[root] = true;

		// index for fast access
		let paths = '';
		let pathsObject = this.pathsObject;
		for (let child of path.split('.')) {
			paths += '.' + child;
			pathsObject = pathsObject[child] = pathsObject[child] || {};
			this.paths[paths] = pathsObject;
		}

		this.roomTrack[root] = this.roomTrack[root] || new Rooms(root);

		// console.log('new path to track "' + path + '"', this.paths);

		return this.roomTrack[root];
	}

	watch(socket) {
		return this.proxy(socket, '', socket);
	}

	unwatch(socket) {
		let rooms = this.sockets.get(socket);
		// for when the developer doesnt join any room
		if (rooms) {
			for (let room of rooms) {
				room[leave](socket);
			}
		}
		this.sockets.delete(socket);
	}
	proxy(target, path, socket) {
		return new Proxy(target, {
			set: (target, id, value, receiver) => {
				// if not Symbol and path in track
				// or path is inside a path we track
				if (typeof id === 'string' && (this.paths[path + '.' + id] || this.paths[path])) {
					//	console.log('entering', path + '.' + id);

					// only set proxy to trackeable paths
					// if new value is object need to be set to proxy too to not lose track of changes
					// for when tracking deep
					if (this.paths[path + '.' + id] && typeof value === 'object' && value !== null) {
						if (value[proxied]) {
							// console.log('proxy1 had', path + '.' + id, value);
						} else {
							// console.log('proxy1 setting for', path + '.' + id, value);
							value = this.proxy(value, path + '.' + id, socket);
							value[proxied] = true;
						}
						// console.log('creating proxy for ' + path + '.' + id, target, receiver);
						// this would make it stop working with objects as keys
						//return Reflect.set(target, id, this.proxy(value, path + '.' + id, socket), receiver);
					}

					let refOldValue = { value: target[id] };
					let refNewValue = { value: value };

					this.check(socket, path + '.' + id, path, target, refOldValue, refNewValue, receiver);

					return Reflect.set(target, id, refNewValue.value, receiver);

					// dispatch on update here
				} else {
					// console.log('not listening to', path + '.', id);
					return Reflect.set(target, id, value, receiver);
				}
			},
		});
	}
	check(socket, path, parent, target, oldValue, newValue, receiver) {
		// console.log('changed', path, 'from', oldValue.value, 'to', newValue.value);

		if (this.tracking[path]) {
			if (
				// if value actually changed (could be the same for simple values)
				oldValue.value !== newValue.value
			) {
				// console.log('--------------------------------------------------------');
				// console.log('YES "' + path + '"', 'changed from', oldValue.value, 'to', newValue.value);

				// LEAVE
				// we wont leave undefined or null
				if (oldValue.value !== undefined && oldValue.value !== null) {
					//console.log('leave room', oldValue.value);
					let room = this.roomTrack[path].get(oldValue.value);
					room[leave](socket);

					// to be able to remove the socket from all rooms on disconnect
					let rooms = this.sockets.get(socket);
					rooms.delete(room);
					this.sockets.set(socket, rooms);
				}

				// JOIN
				// we wont join undefined and null
				if (newValue.value !== undefined && newValue.value !== null) {
					//console.log('joined room', newValue.value);

					// setup proxy
					if (
						!newValue.value[proxied] &&
						// only proxy objects
						typeof newValue.value === 'object' &&
						newValue.value !== null
					) {
						newValue.value = this.proxy(newValue.value, path, socket);
						newValue.value[proxied] = true;
					}

					// create room
					let room = this.roomTrack[path].get(newValue.value);
					if (!room) {
						room = this.roomTrack[path].create(newValue.value, socket);
					}

					// join room
					room[join](socket);

					// to be able to remove the socket from all rooms on disconnect
					let rooms = this.sockets.get(socket);
					if (!rooms) {
						this.sockets.set(socket, new Set());
						rooms = this.sockets.get(socket);
					}
					rooms.add(room);
					this.sockets.set(socket, rooms);
				}
				// console.log('full list of rooms', this.roomTrack);
			} else {
				// console.log('didnt change!', path);
			}
		} else {
			if (oldValue.value !== newValue.value) {
				if (this.roomTrack[parent]) {
					let room = this.roomTrack[parent].get(target);
					if (room) {
						room[property](path, oldValue.value, newValue.value);
					} else {
						room = this.roomTrack[parent].get(receiver);
						if (room) {
							room[property](path, oldValue.value, newValue.value);
						}
					}
					// console.log('tracking changes on', parent, path);
				} else {
					// console.log('not tracking changes on', parent, path);
				}
			}
		}

		for (let id in this.paths[path]) {
			// console.log('tracking subpaths ', path, id);
			this.check(
				socket,
				path + '.' + id,
				parent,
				// target is undefined when setting the value for the first time
				target !== undefined
					? target[id]
					: oldValue.value !== undefined
					? oldValue.value[id]
					: receiver !== undefined
					? receiver[id]
					: undefined,
				// old value
				oldValue.value !== undefined
					? oldValue.value !== null
						? { value: oldValue.value[id] }
						: { value: oldValue.value }
					: target !== undefined
					? { value: target[id] }
					: receiver !== undefined
					? { value: receiver[id] }
					: { value: undefined },
				// new value
				newValue.value !== undefined
					? newValue.value !== null
						? { value: newValue.value[id] }
						: { value: newValue.value }
					: { value: undefined },
				// new receiver
				oldValue.value !== undefined
					? oldValue.value !== null
						? oldValue.value[id]
						: oldValue.value
					: undefined,
			);
		}
	}
}
const tracker = new Tracker();
module.exports = tracker;
