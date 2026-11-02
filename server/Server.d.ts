import { Emitter } from './Emitter.js'
import type { Socket } from './Socket.js'
import type {
	EventValue,
	ServerEvents,
	ServerReplies,
} from './index.js'

export interface ServerListenOptions {
	hostname?: string
	/** TCP port; `0` lets the OS pick one, readable from `port` after. */
	port?: number
	/** WebSocket path clients connect to. */
	path?: string
	timeout?: number
	/** Max size of a single incoming message, in megabytes. */
	maxMessageSize?: number
	/**
	 * Skip `ws`'s UTF-8 validation of incoming text frames. Defaults to
	 * `true`; pass `false` to close connections that send invalid UTF-8.
	 */
	skipUTF8Validation?: boolean
	/**
	 * Path to the PEM-encoded TLS certificate file. When given with
	 * `privKey` the server speaks `wss://`; otherwise plain `ws://`.
	 */
	cert?: string
	/** Path to the PEM-encoded private key file. */
	privKey?: string
	/**
	 * When true, read the client IP from the `X-Forwarded-For` header
	 * (first entry) on the upgrade request. Only enable when a trusted
	 * proxy is in front; otherwise the header is spoofable.
	 */
	trustProxy?: boolean
	/**
	 * When true, watch the parent directories of `cert` and `privKey`
	 * and call `reloadCerts()` when either file changes. Designed for
	 * Let's Encrypt-style atomic-rename renewal. Off by default.
	 */
	watch?: boolean
	/**
	 * Debounce window between watcher events and the actual reload,
	 * in milliseconds. Long enough that LE writing cert + key in quick
	 * succession coalesces into one reload.
	 */
	watchDebounceMs?: number
}

/** Handlers for events the client sends to the server. */
type UserHandlers = {
	[K in keyof ServerEvents]?: (
		socket: Socket,
		data: ServerEvents[K],
		reply?: (v: EventValue<ServerReplies, K>) => void,
	) => void
}

/** Shape passed to `connect` listeners — info about the upgrade request. */
export interface ConnectRequest {
	headers: import('node:http').IncomingHttpHeaders
	url: string
}

/** Server-side predefined events. */
interface PredefinedServerHandlers {
	listen?: () => void
	connect?: (socket: Socket, request: ConnectRequest) => void
	disconnect?: (socket: Socket, code: number, reason: string) => void
	ping?: (socket: Socket) => void
	timeout?: (socket: Socket, delay: number) => void
	garbage?: (socket: Socket, data: any) => void
	incoming?: (socket: Socket, messages: any[]) => void
	outgoing?: (socket: Socket, messages: any[]) => void
}

/** Shape a listener class instance must satisfy for `Server.on(Class)`. */
export type ServerListener = UserHandlers & PredefinedServerHandlers

export declare class Server extends Emitter {
	sockets: Set<Socket>

	hostname: string
	port: number
	path: string

	timeout: number
	timeoutCheck: number

	maxMessageSize: number

	trustProxy: boolean

	since: number
	now: number

	served: number
	bytesReceived: number
	bytesSent: number
	messagesGarbage: number
	messagesReceived: number
	messagesSent: number
	messagesSentCacheHit: number
	serverErrors: number
	socketErrors: number

	queue: Socket[]
	drained: Socket[]

	cacheSymbol: symbol
	cached: number
	cache: Map<unknown, Buffer[]>

	/** Handlers for messages clients send, by event name. */
	events: Record<string, any>
	/** Handlers for events the server fires itself (`connect`, …). */
	hooks: { [K in keyof PredefinedServerHandlers]?: any }

	/** Underlying WebSocketServer (assigned in listen()). */
	io: import('ws').WebSocketServer | null
	/** HTTP(S) server the WebSocketServer is attached to. */
	httpServer: import('node:http').Server | null

	/**
	 * Start listening. Serves `wss://` when `cert` and `privKey` are
	 * given, plain `ws://` otherwise.
	 */
	listen(options?: ServerListenOptions): Promise<void>

	/** Stop the server, drop every connection and release the port. */
	stop(): Promise<void>

	/**
	 * Re-read cert/privKey from the paths passed to `listen()` and swap
	 * them into the running server. Open connections are untouched. If
	 * the new files can't be read or parsed, the current cert stays.
	 */
	reloadCerts(): Promise<void>

	/** Register a listener class. Each method becomes an event handler. */
	on<T extends new () => ServerListener>(
		listener: T & { listeners?: string[] },
	): InstanceType<T>

	/** Sweep all sockets: ping ones approaching idle, kick timed-out ones. */
	ping: () => void

	toJSON(): string
}

declare const server: Server
export default server
