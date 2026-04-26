import { inspect } from './utils.js'
import type { Room } from './Room.js'
import type {
	ClientEvents,
	ClientReplies,
	EventKey,
	EventValue,
} from './index.js'

export class Socket {
	/**
	 * @param session WebTransport session
	 * @param controlStream Bidi stream for queued messages
	 * @param server
	 */
	constructor(session: any, controlStream: any, server: any)

	server: any
	/** WebTransport session. */
	session: any
	/** Control bidi stream. */
	control: any
	/** Writer for the control stream. */
	writer: any

	ip: string
	userAgent: string
	params: Record<string, string>

	/** Outbound queues split by transport channel. */
	messages: { emit: any[]; http: any[] }
	callbacks: (Function | null)[]

	bytesSent: number
	bytesReceived: number
	messagesSent: number
	messagesReceived: number

	since: number
	seen: number
	contacted: number

	ping: number
	timedout: boolean
	closed: boolean

	rooms: Room[]

	/** Array-form used by Emitter to share a pre-built message across sockets. */
	emit(message: [string, any] | [string, any, number]): void
	emit<K extends EventKey<ClientEvents>>(
		k: K,
		v: EventValue<ClientEvents, K>,
		cb?: (reply: EventValue<ClientReplies, K>) => void,
	): void

	/** Array-form used by `Emitter.http` to share one tuple across recipients. */
	http(message: [string, any] | [string, any, number]): void
	/** Queue a message for the next out-of-band batch. */
	http<K extends EventKey<ClientEvents>>(
		k: K,
		v: EventValue<ClientEvents, K>,
		cb?: (reply: EventValue<ClientReplies, K>) => void,
	): void
	/**
	 * Send pre-encoded bytes on a fresh send-only stream. Internal —
	 * called from `processQueue` once per http batch.
	 */
	httpBytes(bytes: Uint8Array): Promise<void>
	/**
	 * Close the session.
	 *
	 * @param noReconnect Pass `true` to send a `disconnect` protocol
	 *   frame so the client suppresses its auto-reconnect loop.
	 * @param reason Human-readable reason carried in QUIC's
	 *   `CONNECTION_CLOSE` frame; surfaced client-side via
	 *   `WebTransportError`. Up to 1024 bytes.
	 */
	disconnect(noReconnect?: boolean, reason?: string): void

	listen(): void
	/**
	 * Pump a readable stream — dispatch each `\n`-terminated frame
	 * via `onframe` mid-stream, plus any unterminated leftover when
	 * the stream ends. Used for both the long-lived control stream
	 * and per-call http payload streams.
	 */
	pump(readable: any): Promise<void>
	onframe(line: string): void
	onclose: () => void

	/** Shared push+schedule path for `emit` and `http`. */
	enqueue(queue: any[], k: any, v?: any, cb?: Function): void

	callback(c: Function): number
	oncallback(d: [number, any[]], m: any): void

	parse(o: string): any

	/**
	 * Route an array of parsed messages through the registered event
	 * handlers.
	 */
	dispatch(messages: any[]): void

	processQueue(): void
	write(bytes: Uint8Array): void

	toJSON(): string
	[inspect](): any
}
