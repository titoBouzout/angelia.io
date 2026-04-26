import type {
	ClientEvents,
	ClientReplies,
	EventKey,
	EventValue,
	ServerEvents,
	ServerReplies,
} from '../server/index.js'

export interface ClientOptions {
	url: string
	params?: Record<string, any> | (() => Record<string, any>)
	noConnect?: boolean
	/**
	 * Pin the server certificate by SHA-256 hash. Lets browsers accept
	 * a self-signed cert (must be ECDSA P-256/P-384, valid ≤ 14 days).
	 * Use the output of `npm run gen-cert`.
	 */
	serverCertificateHashes?: Array<{
		algorithm: 'sha-256'
		value: BufferSource
	}>
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

	/** Open the WebTransport session. Auto-reconnects on disconnection. */
	connect(): void
	/**
	 * Close the WebTransport session.
	 *
	 * @param noReconnect Pass `true` to disable the auto-reconnect
	 *   loop.
	 * @param reason Human-readable reason carried in QUIC's
	 *   `CONNECTION_CLOSE` frame; surfaced in server logs and on the
	 *   server-side `WebTransportError`. Up to 1024 bytes.
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

	/** Out-of-band emit over HTTP POST — same shape as {@link emit}. */
	http<K extends EventKey<ServerEvents>>(key: K): undefined
	http<K extends EventKey<ServerEvents>>(
		key: K,
		value: EventValue<ServerEvents, K>,
	): undefined
	http<K extends EventKey<ServerEvents>, R>(
		key: K,
		callback: (reply: EventValue<ServerReplies, K>) => R,
	): Promise<R>
	http<K extends EventKey<ServerEvents>, R>(
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
