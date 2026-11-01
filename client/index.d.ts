import type {
	ClientEvents,
	ClientReplies,
	EventKey,
	EventValue,
	ServerEvents,
	ServerReplies,
} from '../server/index.js'

export interface ClientOptions {
	/** Server origin, as `ws://` or `wss://`. */
	url: string
	params?: Record<string, any> | (() => Record<string, any>)
	noConnect?: boolean
	/**
	 * Run the WebSocket in a Web Worker (default `true`). Ignored where
	 * `Worker` doesn't exist. Pass `false` under a CSP that blocks
	 * `worker-src blob:`.
	 */
	worker?: boolean
}

/** Client-side predefined events. Dispatched with no payload. */
export type ClientPredefinedEvent =
	| 'connect'
	| 'reconnect'
	| 'disconnect'

export default class Client {
	constructor(options: ClientOptions)

	options: ClientOptions
	connected: boolean

	/** Open the WebSocket. Auto-reconnects on disconnection. */
	connect(): void
	/**
	 * Close the WebSocket.
	 *
	 * @param noReconnect Pass `true` to disable the auto-reconnect
	 *   loop.
	 * @param reason Close reason sent to the server, up to 123 bytes.
	 */
	disconnect: (noReconnect?: boolean, reason?: string) => void

	/** Emit to the server without a value or reply. */
	emit<K extends EventKey<ServerEvents>>(key: K): undefined
	/** Emit to the server with a value. */
	emit<K extends EventKey<ServerEvents>>(
		key: K,
		value: EventValue<ServerEvents, K>,
	): undefined
	/**
	 * Emit to the server with a reply callback. Returns a promise that
	 * resolves with whatever the callback returns.
	 */
	emit<K extends EventKey<ServerEvents>, R>(
		key: K,
		callback: (reply: EventValue<ServerReplies, K>) => R,
	): Promise<R>
	emit<K extends EventKey<ServerEvents>, R>(
		key: K,
		value: EventValue<ServerEvents, K>,
		callback: (reply: EventValue<ServerReplies, K>) => R,
	): Promise<R>

	/**
	 * Listen for a predefined client event (connect / reconnect /
	 * disconnect).
	 */
	on(
		key: ClientPredefinedEvent,
		value: () => void,
	): (() => void) | undefined
	/** Listen for a server event. */
	on<K extends EventKey<ClientEvents>>(
		key: K,
		value: (
			v: EventValue<ClientEvents, K>,
			reply?: (v: EventValue<ClientReplies, K>) => void,
		) => void,
	): (() => void) | undefined
}
