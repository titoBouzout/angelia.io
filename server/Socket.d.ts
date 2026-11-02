import { inspect } from './utils.js'
import type { Room } from './Room.js'
import type {
	ClientEvents,
	ClientReplies,
	EventKey,
	EventValue,
} from './index.js'

export class Socket {
	constructor(
		io: import('ws').WebSocket,
		request: import('node:http').IncomingMessage,
		server: any,
	)

	server: any
	/** The underlying `ws` WebSocket. */
	io: import('ws').WebSocket

	ip: string
	userAgent: string
	params: Record<string, string>

	messages: any[]
	/** Replies this socket's client still owes, by callback id. */
	callbacks: Map<
		number,
		{ fire: (args: any[]) => void; cancel: (err: Error) => void }
	>

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

	rooms: Set<Room>

	/** Array-form used by Emitter to share a pre-built message across sockets. */
	emit(message: [string, any] | [string, any, number]): void
	emit<K extends EventKey<ClientEvents>>(
		k: K,
		v: EventValue<ClientEvents, K>,
	): void
	/**
	 * Emit with a reply callback. Returns a promise for the callback's
	 * result, rejected with `Error('disconnected')` if the socket closes
	 * before the client replies.
	 */
	emit<K extends EventKey<ClientEvents>, R>(
		k: K,
		callback: (reply: EventValue<ClientReplies, K>) => R,
	): Promise<R>
	emit<K extends EventKey<ClientEvents>, R>(
		k: K,
		v: EventValue<ClientEvents, K>,
		callback: (reply: EventValue<ClientReplies, K>) => R,
	): Promise<R>

	/**
	 * Close the connection.
	 *
	 * @param noReconnect Pass `true` to also tell the client not to
	 *   reconnect.
	 * @param reason Close reason sent to the client, up to 123 bytes;
	 *   longer throws a `RangeError` before anything is closed.
	 */
	disconnect(noReconnect?: boolean, reason?: string): void

	listen(): void
	onmessage: (raw: Buffer) => void
	onclose: (code: number, reason: Buffer | string) => void
	onerror: (err: Error) => void

	callback(c: Function): [number, Promise<any>]
	/** Settle the callback a reply `[id, args]` is for; false if none. */
	oncallback(d: unknown): boolean

	/** The parsed value, or undefined if not JSON. */
	parse(o: string): unknown
	garbage(m: unknown): void

	/**
	 * Route an array of parsed messages through the registered event
	 * handlers.
	 */
	dispatch(messages: any[]): void

	processQueue(): void
	/** Write a pre-built frame from `utils.frame`. */
	write(chunks: Buffer[]): void

	toJSON(): string
	[inspect](): any
}
