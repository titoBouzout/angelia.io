/**
 * Common emit / broadcast logic. Subclasses provide their own
 * `sockets`: Server and Room as a plain Array; Rooms as a computed
 * getter that walks every room.
 *
 * @typedef {{ sockets: import('./Socket.js').Socket[] }} HasSockets
 */

export class Emitter {
	/** @this {HasSockets} */
	get connections() {
		return this.sockets.length
	}

	/**
	 * @this {HasSockets}
	 * @param {any} k
	 * @param {any} [v]
	 */
	emit(k, v) {
		const d = [k, v]
		for (const socket of this.sockets) {
			socket.emit(d)
		}
	}

	/**
	 * @this {HasSockets}
	 * @param {any} k
	 * @param {any} [v]
	 */
	once(k, v) {
		const d = [k, v]
		for (const socket of this.sockets) {
			socket.once(d)
		}
	}

	/**
	 * @this {HasSockets}
	 * @param {import('./Socket.js').Socket} me
	 * @param {any} k
	 * @param {any} [v]
	 */
	broadcast(me, k, v) {
		const d = [k, v]
		for (const socket of this.sockets) {
			if (me != socket) {
				socket.emit(d)
			}
		}
	}

	/**
	 * @this {HasSockets}
	 * @param {import('./Socket.js').Socket} me
	 * @param {any} k
	 * @param {any} [v]
	 */
	broadcastOnce(me, k, v) {
		const d = [k, v]
		for (const socket of this.sockets) {
			if (me != socket) {
				socket.once(d)
			}
		}
	}
}
