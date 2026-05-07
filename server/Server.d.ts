import { Emitter } from './Emitter.js'
import type { Socket } from './Socket.js'
import type {
	EventValue,
	ServerEvents,
	ServerReplies,
} from './index.js'

export interface ServerListenOptions {
	hostname?: string
	port?: number
	timeout?: number
	/**
	 * Path to the PEM-encoded TLS certificate file. Read from disk
	 * each time `listen()` runs (including cert reloads).
	 */
	cert: string
	/** Path to the PEM-encoded private key file. */
	privKey: string
	/**
	 * QUIC retry-token / anti-amplification secret. Defaults to a
	 * random 32-byte hex string per process. Pin it across rolling
	 * restarts to let in-flight 0-RTT keys survive. The secret is
	 * also pinned automatically across `reloadCerts()` calls.
	 */
	secret?: string
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
	 * in milliseconds. Defaults to 1000 — long enough that LE writing
	 * cert + key in quick succession coalesces into one reload.
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
	disconnect?: (socket: Socket) => void
	ping?: (socket: Socket) => void
	timeout?: (socket: Socket, delay: number) => void
	garbage?: (socket: Socket, data: any) => void
	incoming?: (socket: Socket, messages: any[]) => void
	outgoing?: (socket: Socket, messages: any[]) => void
}

/** Shape a listener class instance must satisfy for `Server.on(Class)`. */
export type ServerListener = UserHandlers & PredefinedServerHandlers

export declare class Server extends Emitter {
	sockets: Socket[]

	hostname: string
	port: number

	timeout: number
	timeoutCheck: number

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

	queue: Socket[]

	cacheSymbol: symbol
	cached: number
	cache: Record<string, Uint8Array>

	events: Record<string, any>

	/** Underlying Http3Server instance (assigned in listen()). */
	io: any
	/** Reader for the session stream (assigned in listen()). */
	sessionReader: any

	/** Start server listening over WebTransport (HTTP/3 / QUIC). */
	listen(options: ServerListenOptions): Promise<void>

	/** Stop the server and release the port. */
	stop(): Promise<void>

	/**
	 * Re-read cert/privKey from the paths passed to `listen()` and
	 * restart the underlying server. Existing sessions are torn down;
	 * clients reconnect via their auto-reconnect loop. If the new
	 * files can't be read, the running server is left untouched.
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
