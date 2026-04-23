export const now = Date.now

export const inspect = Symbol.for('nodejs.util.inspect.custom')

/**
 * Remove the first occurrence of `item` from `arr` in place.
 *
 * @template T
 * @param {T[]} arr
 * @param {T} item
 */
export function remove(arr, item) {
	const i = arr.indexOf(item)
	if (i !== -1) arr.splice(i, 1)
}

export function ListenerTemplate() {
	const fns = []
	function Listener(...args) {
		for (const fn of fns) {
			fn(...args)
		}
	}

	Listener.fns = fns

	return Listener
}

import { Sender } from 'ws'

export const frame = function (
	frame,
	bufferFrom,
	WebSocketFrame,
	data,
) {
	return frame(bufferFrom(data), WebSocketFrame)
}.bind(null, Sender.frame, Buffer.from, {
	readOnly: false,
	mask: false,
	rsv1: false,
	opcode: 1,
	fin: true,
})
