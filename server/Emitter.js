import { MapeableSet } from './utils.js'

export class Emitter {
	constructor() {
		/** @type MapeableSet<import('./Socket.js').Socket> */
		this.sockets = new MapeableSet()
	}

	get connections() {
		return this.sockets.size
	}

	emit(k, v) {
		const d = [k, v]
		for (const socket of this.sockets) {
			socket.emit(d)
		}
	}
	once(k, v) {
		const d = [k, v]
		for (const socket of this.sockets) {
			socket.once(d)
		}
	}
	broadcast(me, k, v) {
		const d = [k, v]
		for (const socket of this.sockets) {
			if (me != socket) {
				socket.emit(d)
			}
		}
	}
	broadcastOnce(me, k, v) {
		const d = [k, v]
		for (const socket of this.sockets) {
			if (me != socket) {
				socket.once(d)
			}
		}
	}
}
