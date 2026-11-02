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

/**
 * Parse the query string of a URL into a plain params object, leaving
 * out the `exclude` param, whose value is returned alongside.
 *
 * @param {string} [url]
 * @param {string} [exclude]
 * @returns {[Record<string, string>, string | null]}
 */
export function params(url = '', exclude) {
	const q = url.indexOf('?')
	if (q === -1) return [{}, null]
	const query = new URLSearchParams(url.slice(q + 1))
	/** @type {string | null} */
	let excluded = null
	if (exclude !== undefined) {
		excluded = query.get(exclude)
		query.delete(exclude)
	}
	return [Object.fromEntries(query), excluded]
}

export const inspect = Symbol.for('nodejs.util.inspect.custom')

/**
 * Returns a function that, when called, invokes every fn pushed into its
 * `.fns` array. Fixed arity (every event and hook takes at most three
 * arguments), so a call allocates no rest array.
 */
export function ListenerTemplate() {
	const fns = []
	function Listener(a, b, c) {
		for (const fn of fns) {
			fn(a, b, c)
		}
	}

	Listener.fns = fns

	return Listener
}
