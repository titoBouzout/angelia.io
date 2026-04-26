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

	/**
	 * Fire-and-forget out-of-band send to every socket in scope. The
	 * payload is encoded once and pushed onto a fresh send-only stream
	 * per recipient. Per-stream failures are swallowed.
	 */
	http<K extends EventKey<ClientEvents>>(
		k: K,
		v: EventValue<ClientEvents, K>,
	): void
	/** Like {@link http} but skip `me`. */
	broadcastHttp<K extends EventKey<ClientEvents>>(
		me: Socket,
		k: K,
		v: EventValue<ClientEvents, K>,
	): void
}
