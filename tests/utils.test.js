import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
	empty,
	isArray,
	createFanOut,
	params,
	parse,
	stringify,
} from '../server/utils.js'

describe('utils.createFanOut', () => {
	it('returns a function whose .fns is the registry', () => {
		const l = createFanOut()
		assert.equal(typeof l, 'function')
		assert.ok(Array.isArray(l.fns))
		assert.equal(l.fns.length, 0)
	})

	it('invokes every registered fn with the same three args', () => {
		const l = createFanOut()
		const calls = []
		l.fns.push((a, b, c) => calls.push(['a', a, b, c]))
		l.fns.push((a, b, c) => calls.push(['b', a, b, c]))
		l(1, 'two', 3)
		assert.deepEqual(calls, [
			['a', 1, 'two', 3],
			['b', 1, 'two', 3],
		])
	})

	it('does nothing when no fns are registered', () => {
		const l = createFanOut()
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
		assert.deepEqual(params(), [{}, null])
		assert.deepEqual(params(''), [{}, null])
		assert.deepEqual(params('/angelia'), [{}, null])
	})

	it('parses the query string into a plain object', () => {
		assert.deepEqual(params('/angelia?foo=bar&baz=qux'), [
			{ foo: 'bar', baz: 'qux' },
			null,
		])
	})

	it('decodes URL-encoded values', () => {
		assert.deepEqual(params('/x?greeting=hi%20there')[0], {
			greeting: 'hi there',
		})
	})

	it('keeps the last value for duplicate keys', () => {
		assert.deepEqual(params('/x?k=1&k=2&k=3')[0], { k: '3' })
	})

	it('takes out the excluded param and returns its value', () => {
		assert.deepEqual(params('/x?a=1&m=%5B%5D&b=2', 'm'), [
			{ a: '1', b: '2' },
			'[]',
		])
		assert.deepEqual(params('/x?a=1', 'm'), [{ a: '1' }, null])
	})
})
