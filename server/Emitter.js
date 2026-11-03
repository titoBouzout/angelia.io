/** @import { ClientEvents, EventKey, EventValue } from './index.js' */
/** @import { Message } from './Message.js' */
/** @import { Socket } from './Socket.js' */

/**
 * @typedef {{
 * 	sockets: Iterable<Socket>
 * }} HasSockets
 */

/**
 * @param {Iterable<Socket>} sockets
 * @param {any[]} tuple
 */
function queueAll(sockets, tuple) {
	for (const socket of sockets) {
		socket.queue(tuple)
	}
}

/**
 * @param {Iterable<Socket>} sockets
 * @param {Socket | undefined} me
 * @param {any[]} tuple
 */
function queueExcept(sockets, me, tuple) {
	for (const socket of sockets) {
		if (me !== socket) {
			socket.queue(tuple)
		}
	}
}

/**
 * Common emit / broadcast logic. Subclasses own the `sockets` field
 * (a Set on Server, Room and Rooms). Each fan-out queues **one** wire
 * tuple on every recipient, and `Server.cacheMessages` keeps the encoded
 * form on it, so all sockets share a single encoding.
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
		queueAll(this.sockets, [k, v])
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
		queueExcept(this.sockets, me, [k, v])
	}

	/**
	 * Send an encoded message to every socket in scope.
	 *
	 * @this {HasSockets}
	 * @param {Message<any>} message
	 */
	send(message) {
		queueAll(this.sockets, message.tuple)
	}

	/**
	 * Send an encoded message to every socket in scope except `me`.
	 *
	 * @this {HasSockets}
	 * @param {Socket | undefined} me
	 * @param {Message<any>} message
	 */
	sendExcept(me, message) {
		queueExcept(this.sockets, me, message.tuple)
	}
}
