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
					if (typeof id === 'string' && this.paths[path + '.' + id]) {
						let oldValue = target[id]
						target[id] = value

						this.check(
							socket,
							path + '.' + id,
							target,
							oldValue,
							value,
							receiver,
						)
					} else {
						target[id] = value
					}
					return true
				},
			})
		}
		return target
	}
	check(socket, path, target, oldValue, newValue, receiver) {
		if (this.rooms.has(path)) {
			if (oldValue !== newValue) {
				/*console.log(
					'YES "' + path + '"',
					'changed from',
					oldValue,
					'to',
					newValue,
				)*/

				// LEAVE
				// we wont leave undefined or null
				if (typeof oldValue === 'object' && oldValue !== null) {
					oldValue[leave](socket.proxy)
					// console.log('leaving room', oldValue)
				}

				// JOIN
				// we wont join undefined and null
				if (typeof newValue === 'object' && newValue !== null) {
					newValue[join](this.rooms.get(path), socket.proxy)
					// console.log('joining room', newValue)
				}
			} else {
				// console.log('value didnt change', path, oldValue, newValue)
			}
		} else {
			// console.log('not tracking path', path)
		}
	}

	[Symbol.iterator]() {
		return this.rooms[Symbol.iterator]()
	}
}

const Manager = new ManagerSingleton()

module.exports = Manager
