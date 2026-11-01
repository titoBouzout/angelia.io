import type { Socket } from './Socket.js'
import type {
	ClientEvents,
	EventKey,
	EventValue,
} from './index.js'

/**
 * Common emit / broadcast logic over `this.sockets`. Subclasses own the
 * `sockets` collection (Server/Room as a plain Array, Rooms as a getter).
 */
export class Emitter {
	emit<K extends EventKey<ClientEvents>>(
		k: K,
		v: EventValue<ClientEvents, K>,
	): void
	broadcast<K extends EventKey<ClientEvents>>(
		me: Socket,
		k: K,
		v: EventValue<ClientEvents, K>,
	): void

}
