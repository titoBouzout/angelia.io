'use strict';

const join = Symbol.for('Room.join');
const leave = Symbol.for('Room.leave');

const proxied = Symbol.for('Tracker.proxied');

const Rooms = require('./Rooms.js');

class Tracker {
	constructor() {
		// to keep track of paths
		this.tracking = {}; // full path
		this.paths = {}; // path tree as string
		this.pathsObject = {}; // path tree as object

		// to keep track of rooms
		this.roomsTrack = {};
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

		this.roomsTrack[root] = this.roomsTrack[root] || new Rooms(root);

		// console.log('new path to track "' + path + '"', this.paths);

		return this.roomsTrack[root];
	}

	watch(socket) {
		return this.proxy(socket, '', socket);
	}

	proxy(target, path, socket) {
		return new Proxy(target, {
			set: (target, id, value, receiver) => {
				// if not Symbol and path in track
				// subpath:   path is inside a path we track /*|| this.paths[path]*/
				if (typeof id === 'string' && this.paths[path + '.' + id]) {
					// console.log('entering', path + '.' + id);

					// if new value is object need to be set to proxy too to not lose track of changes
					if (typeof value === 'object' && value !== null) {
						/*if (!value[proxied]) {
							// console.log('proxy1 setting for', path + '.' + id, value);
							value = this.proxy(value, path + '.' + id, socket);
							value[proxied] = true;
						}*/
					}

					let refOldValue = { value: target[id] };
					let refNewValue = { value: value };

					this.check(socket, path + '.' + id, path, target, refOldValue, refNewValue, receiver);

					return Reflect.set(target, id, refNewValue.value, receiver);
				} else {
					return Reflect.set(target, id, value, receiver);
				}
			},
		});
	}
	check(socket, path, parent, target, oldValue, newValue, receiver) {
		// console.log('changed', path, 'from', oldValue.value, 'to', newValue.value);

		if (this.tracking[path]) {
			if (oldValue.value !== newValue.value) {
				// console.log('--------------------------------------------------------');
				// console.log('YES "' + path + '"', 'changed from', oldValue.value, 'to', newValue.value);

				// LEAVE
				// we wont leave undefined or null
				if (
					typeof oldValue.value === 'object' &&
					oldValue.value !== undefined &&
					oldValue.value !== null
				) {
					oldValue.value[leave](socket.proxy);

					// console.log('leave room', oldValue.value);
				}

				// JOIN
				// we wont join undefined and null
				if (typeof newValue.value === 'object' && newValue.value !== null) {
					// setup proxy
					/*if (!newValue.value[proxied]) {
						newValue.value = this.proxy(newValue.value, path, socket);
						newValue.value[proxied] = true;
					}*/

					// create room if doesnt exists
					if (!this.roomsTrack[path].has(newValue.value)) {
						this.roomsTrack[path].create(newValue.value);
						newValue.value.create && newValue.value.create();
					}
					newValue.value[join](socket.proxy);

					// console.log('joined room', newValue.value);
				}
				// console.log('full list of rooms', this.roomsTrack);
			} else {
				// console.log('value didnt change', path);
			}
		} else {
			// console.log('not tracking path', path);
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
