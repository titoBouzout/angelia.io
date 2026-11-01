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

	/**
	 * Close the connection.
	 *
	 * @param noReconnect Pass `true` to send a `disconnect` frame so
	 *   the client suppresses its auto-reconnect loop.
	 * @param reason Close reason sent to the client, up to 123 bytes.
	 */
	disconnect(noReconnect?: boolean, reason?: string): void

	listen(): void
	onmessage: (raw: import('ws').RawData) => void
	onclose: () => void
	onerror: (err: Error) => void

	callback(c: Function): number
	oncallback(d: [number, any[]], m: any): void

	parse(o: string): any

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
