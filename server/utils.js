export const now = Date.now

import { Sender } from 'ws'

const TEXT_FRAME = {
	fin: true,
	opcode: 1,
	mask: false,
	readOnly: false,
	rsv1: false,
}

/**
 * Frame `text` as a complete WebSocket text message, once, so the same
 * frame can be written to every recipient.
 *
 * @param {string} text
 */
export const frame = text => Sender.frame(Buffer.from(text), TEXT_FRAME)

export const stringify = JSON.stringify

export const parse = JSON.parse

export const isArray = Array.isArray

export const empty = () => Object.create(null)

/** Parse the query string of a URL into a plain params object. */
export function params(url = '') {
	const q = url.indexOf('?')
	return q === -1
		? {}
		: Object.fromEntries(new URLSearchParams(url.slice(q + 1)))
}

export const inspect = Symbol.for('nodejs.util.inspect.custom')

/** Returns a function that, when called, invokes every fn pushed into its `.fns` array. */
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
