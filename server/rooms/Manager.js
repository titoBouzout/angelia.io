'use strict'

const { join, leave } = require('./constants.js')

const Rooms = require('./Rooms.js')

class ManagerSingleton {
	constructor() {
		Object.assign(this, {
			paths: {}, // path tree as string
			pathsObject: {}, // path tree as object

			rooms: new Map(),

			proxied: Symbol('proxied'),

			track: this.track.bind(this),
			observe: this.observe.bind(this),
		})
	}
	track(path) {
		let root = '.' + path

		if (!this.rooms.has(root)) {
			// index for fast access
			let paths = ''
			let pathsObject = this.pathsObject
			for (let child of path.split('.')) {
				paths += '.' + child
				pathsObject = pathsObject[child] = pathsObject[child] || {}
				this.paths[paths] = pathsObject
			}

			// room list
			this.rooms.set(root, new Rooms(root))

			// console.log('New path to track "' + path + '"', this.paths)
		}
		return this.rooms.get(root)
	}

	observe(socket) {
		return this.proxy(socket, '', socket)
	}

	proxy(target, path, socket) {
		if (!target[this.proxied]) {
			target[this.proxied] = true
			target = new Proxy(target, {
				set: (target, id, value, receiver) => {
					// if not Symbol and path in track
					// subpath:   path is inside a path we track /*|| this.paths[path]*/
					if (typeof id === 'string' && this.paths[path + '.' + id]) {
						// console.log('entering', path + '.' + id);

						// if new value is object need to be set to proxy too to not lose track of changes
						if (typeof value === 'object' && value !== null) {
							/*if (!value[this.proxied]) {
							// console.log('proxy1 setting for', path + '.' + id, value);
							value = this.proxy(value, path + '.' + id, socket);
							value[this.proxied] = true;
						}*/
						}

						let refOldValue = { value: target[id] }
						let refNewValue = { value: value }

						this.check(
							socket,
							path + '.' + id,
							target,
							refOldValue,
							refNewValue,
							receiver,
						)
						return Reflect.set(target, id, refNewValue.value, receiver)
					}
					return Reflect.set(target, id, value, receiver)
				},
			})
		}
		return target
	}
	check(socket, path, target, oldValue, newValue, receiver) {
		// console.log('changed', path, 'from', oldValue.value, 'to', newValue.value);

		if (this.rooms.has(path)) {
			if (oldValue.value !== newValue.value) {
				/*	console.log(
					'YES "' + path + '"',
					'changed from',
					oldValue.value,
					'to',
					newValue.value,
				)*/

				// LEAVE
				// we wont leave undefined or null
				if (
					typeof oldValue.value === 'object' &&
					oldValue.value !== undefined &&
					oldValue.value !== null
				) {
					oldValue.value[leave](socket.proxy)
					// console.log('leaving room', oldValue.value)
				} else {
					// console.log('old value not valid', oldValue)
				}

				// JOIN
				// we wont join undefined and null
				if (typeof newValue.value === 'object' && newValue.value !== null) {
					// setup proxy
					/*if (!newValue.value[this.proxied]) {
						newValue.value = this.proxy(newValue.value, path, socket);
						newValue.value[this.proxied] = true;
					}*/

					newValue.value[join](this.rooms.get(path), socket.proxy)
					// console.log('joining room', newValue.value)
				} else {
					// console.log('new value not valid', newValue)
				}
			} else {
				// console.log('value didnt change', path, target === receiver);
			}
		} else {
			// console.log('not tracking path', path);
		}

		/*
		we dont go deep for now
		for (let id in this.paths[path]) {
			console.log('tracking subpaths ', path, id);
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
		}*/
	}

	[Symbol.iterator]() {
		return this.rooms
	}
}

const Manager = new ManagerSingleton()

module.exports = Manager
