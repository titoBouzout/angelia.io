// Wire protocol details the client and the server must agree on.

/** WebSocket path when neither the client URL nor `listen()` sets one. */
export const DEFAULT_PATH = '/angelia'

/** Query param that carries messages packed into the connect URL. */
export const PACKED_PARAM = 'm'

/**
 * Message key reserved for the protocol: `['', [id, args]]` is a reply,
 * `['', command]` a command.
 */
export const PROTOCOL_KEY = ''

/** Command telling the client to close and not reconnect. */
export const NO_RECONNECT = 'disconnect'

/** WebSocket close frames carry at most this many bytes of reason. */
const MAX_CLOSE_REASON_BYTES = 123

const encoder = new TextEncoder()

/**
 * Throw before closing with a reason the WebSocket would reject, so a
 * bad reason fails with nothing half done.
 *
 * @param {string} reason
 */
export function assertCloseReason(reason) {
	const bytes = encoder.encode(reason).length
	if (bytes > MAX_CLOSE_REASON_BYTES) {
		throw new RangeError(
			`close reason is ${bytes} bytes; the limit is ${MAX_CLOSE_REASON_BYTES}. WebSocket close frames can't carry more, so shorten it.`,
		)
	}
}
