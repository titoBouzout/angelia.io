export const now = Date.now

// `encode` is stateless, safe to share. `decode` (TextDecoder) keeps
// state across `{stream: true}` chunks, so each pump creates its own.
export const encode = TextEncoder.prototype.encode.bind(new TextEncoder())

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

/** Remove the first occurrence of `item` from `arr` in place. */
export function remove(arr, item) {
	const i = arr.indexOf(item)
	if (i !== -1) arr.splice(i, 1)
}

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
