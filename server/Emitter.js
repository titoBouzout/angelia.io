/**
 * @typedef {{
 *   sockets: import('./Socket.js').Socket[]
 *   emit: (k: any, v?: any) => void
 *   broadcast: (me: any, k: any, v?: any) => void
 * }} HasSockets
 */

/**
 * Common emit / broadcast logic. Subclasses own the `sockets` field
 * (Server/Room as a plain Array, Rooms as a computed getter). Each
 * fan-out builds the wire tuple **once** and passes the same reference
 * to every recipient — `Server.cacheMessages` keys the encoded form by
 * message identity, so all sockets share a single encoding.
 */
export class Emitter {
	/** @this {HasSockets} */
	emit(k, v) {
		/** @type {[string, any]} */
		const d = [k, v]
		for (const socket of this.sockets) {
			socket.emit(d)
		}
	}

	/** @this {HasSockets} */
	broadcast(me, k, v) {
		/** @type {[string, any]} */
		const d = [k, v]
		for (const socket of this.sockets) {
			if (me != socket) {
				socket.emit(d)
			}
		}
	}
}
