/** @import { ClientEvents, EventKey, EventValue } from './index.js' */
/** @import { Socket } from './Socket.js' */

/**
 * @typedef {{
 * 	sockets: Iterable<Socket>
 * 	broadcast(me: Socket | undefined, k: any, v?: any): void
 * }} HasSockets
 */

/**
 * Common emit / broadcast logic. Subclasses own the `sockets` field
 * (a Set on Server, Room and Rooms). Each fan-out builds the wire tuple
 * **once** and passes the same reference to every recipient —
 * `Server.cacheMessages` keys the encoded form by message identity, so
 * all sockets share a single encoding.
 */
export class Emitter {
	/**
	 * Emit to every socket in scope.
	 *
	 * @template {EventKey<ClientEvents>} K
	 * @this {HasSockets}
	 * @param {K} k
	 * @param {EventValue<ClientEvents, K>} v
	 */
	emit(k, v) {
		this.broadcast(undefined, k, v)
	}

	/**
	 * Emit to every socket in scope except `me`.
	 *
	 * @template {EventKey<ClientEvents>} K
	 * @this {HasSockets}
	 * @param {Socket | undefined} me
	 * @param {K} k
	 * @param {EventValue<ClientEvents, K>} v
	 */
	broadcast(me, k, v) {
		/** @type {[string, any]} */
		const d = [k, v]
		for (const socket of this.sockets) {
			if (me !== socket) {
				socket.emit(d)
			}
		}
	}
}
