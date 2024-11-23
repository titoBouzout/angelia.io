// utils

export const empty = () => Object.create(null)

export const now = Date.now

export const inspect = Symbol.for('nodejs.util.inspect.custom')

export const stringify = JSON.stringify

export const parse = JSON.parse

export const assign = Object.assign

export const isArray = Array.isArray

export const fromEntries = Object.fromEntries

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
