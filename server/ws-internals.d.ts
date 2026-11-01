// The parts of `ws` the server uses that `@types/ws` doesn't declare.
import 'ws'

declare module 'ws' {
	/** Exported by `ws`; only `frame` is used. */
	export const Sender: {
		frame(
			data: Buffer,
			options: {
				fin: boolean
				opcode: number
				mask: boolean
				readOnly: boolean
				rsv1: boolean
			},
		): Buffer[]
	}
	interface WebSocket {
		/** ws's frame writer; `sendFrame` writes a pre-built frame as-is. */
		_sender: { sendFrame(chunks: Buffer[]): void }
	}
}
