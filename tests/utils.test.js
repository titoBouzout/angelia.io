import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
	empty,
	isArray,
	ListenerTemplate,
	params,
	parse,
	remove,
	stringify,
} from '../server/utils.js'

describe('utils.remove', () => {
	it('removes the first occurrence in place', () => {
		const arr = ['a', 'b', 'c']
		remove(arr, 'b')
		assert.deepEqual(arr, ['a', 'c'])
	})

	it('is a no-op when the item is not present', () => {
		const arr = [1, 2, 3]
		remove(arr, 99)
		assert.deepEqual(arr, [1, 2, 3])
	})

	it('removes only the first occurrence on duplicates', () => {
		const arr = [1, 2, 2, 3]
		remove(arr, 2)
		assert.deepEqual(arr, [1, 2, 3])
	})

	it('handles object identity, not equality', () => {
		const a = { x: 1 }
		const b = { x: 1 }
		const arr = [a, b]
		remove(arr, b)
		assert.deepEqual(arr, [a])
		assert.equal(arr[0], a)
	})

	it('works on an empty array', () => {
		const arr = []
		remove(arr, 'x')
		assert.deepEqual(arr, [])
	})
})

describe('utils.ListenerTemplate', () => {
	it('returns a function whose .fns is the registry', () => {
		const l = ListenerTemplate()
		assert.equal(typeof l, 'function')
		assert.ok(Array.isArray(l.fns))
		assert.equal(l.fns.length, 0)
	})

	it('invokes every registered fn with the same args', () => {
		const l = ListenerTemplate()
		const calls = []
		l.fns.push((...a) => calls.push(['a', ...a]))
		l.fns.push((...a) => calls.push(['b', ...a]))
		l(1, 'two')
		assert.deepEqual(calls, [
			['a', 1, 'two'],
			['b', 1, 'two'],
		])
	})

	it('does nothing when no fns are registered', () => {
		const l = ListenerTemplate()
		assert.doesNotThrow(() => l('anything'))
	})
})

describe('utils.stringify', () => {
	it('aliases JSON.stringify', () => {
		assert.equal(stringify, JSON.stringify)
		assert.equal(stringify({ a: 1 }), '{"a":1}')
	})
})

describe('utils.parse', () => {
	it('aliases JSON.parse', () => {
		assert.equal(parse, JSON.parse)
		assert.deepEqual(parse('{"a":1}'), { a: 1 })
	})
})

describe('utils.isArray', () => {
	it('aliases Array.isArray', () => {
		assert.equal(isArray, Array.isArray)
		assert.equal(isArray([]), true)
		assert.equal(isArray({}), false)
	})
})

describe('utils.empty', () => {
	it('returns a null-prototype object', () => {
		const o = empty()
		assert.equal(Object.getPrototypeOf(o), null)
	})

	it('returns a fresh object each call', () => {
		assert.notEqual(empty(), empty())
	})
})

describe('utils.params', () => {
	it('returns {} for an empty / undefined / no-query url', () => {
		assert.deepEqual(params(), {})
		assert.deepEqual(params(''), {})
		assert.deepEqual(params('/angelia'), {})
	})

	it('parses the query string into a plain object', () => {
		assert.deepEqual(params('/angelia?foo=bar&baz=qux'), {
			foo: 'bar',
			baz: 'qux',
		})
	})

	it('decodes URL-encoded values', () => {
		assert.deepEqual(params('/x?greeting=hi%20there'), {
			greeting: 'hi there',
		})
	})

	it('keeps the last value for duplicate keys', () => {
		assert.deepEqual(params('/x?k=1&k=2&k=3'), { k: '3' })
	})
})

