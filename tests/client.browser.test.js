/**
 * The Client in real browsers, where it runs its WebSocket in a Web
 * Worker. Every test runs in each browser Playwright has installed
 * (`npx playwright install chromium firefox`); missing ones are skipped.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect, createServer as createNetServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { chromium, firefox } from 'playwright'

import { Server, bootServer, freePort, waitFor } from './helpers.js'
import { TIMEOUT_MS } from '../shared/protocol.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Runs the worker's clock this many times faster, for its heartbeat's fixed times.
const WORKER_SPEED = 20

// Counts WebSockets built on the main thread, then exposes the Client and
// `make(url, options)`, which logs the predefined events into `log`.
const PAGE = `<!doctype html>
<script type="module">
	const Native = WebSocket
	window.mainThreadSockets = 0
	const NativeBlob = Blob
	window.Blob = class extends NativeBlob {
		constructor(parts, options) {
			super([window.workerPrelude || '', ...parts], options)
		}
	}
	window.WebSocket = class extends Native {
		constructor(...args) {
			super(...args)
			window.mainThreadSockets++
		}
	}
	const { default: Client } = await import('/client/index.js')
	window.Client = Client
	window.log = []
	window.make = (url, options) => {
		const client = new Client({ url, ...options })
		for (const e of ['connect', 'reconnect', 'disconnect'])
			client.on(e, () => window.log.push(e))
		window.client = client
	}
	window.busy = ms => {
		const end = Date.now() + ms
		while (Date.now() < end) {}
	}
</script>`

/**
 * The client as an app would ship it: bundled and minified, with the
 * worker's source turned into a string after minification.
 */
async function minifiedClient() {
	const result = await build({
		entryPoints: [join(root, 'client/index.js')],
		bundle: true,
		minify: true,
		format: 'esm',
		write: false,
	})
	return result.outputFiles[0].text
}

/** Serves the test page and the client sources, nothing else. */
async function bootPageServer() {
	const minified = await minifiedClient()
	const files = [
		'/client/index.js',
		'/client/transport.js',
		'/shared/protocol.js',
	]
	const http = createServer(async (req, res) => {
		const path = (req.url || '/').split('?')[0]
		if (path === '/') {
			res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)
		} else if (path === '/elsewhere') {
			res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>')
		} else if (path === '/no-workers') {
			// The page under a policy that blocks every worker.
			res
				.writeHead(200, {
					'content-type': 'text/html',
					'content-security-policy': "worker-src 'none'",
				})
				.end(PAGE)
		} else if (path === '/minified') {
			res
				.writeHead(200, { 'content-type': 'text/html' })
				.end(PAGE.replace('/client/index.js', '/client.min.js'))
		} else if (path === '/client.min.js') {
			res.writeHead(200, { 'content-type': 'text/javascript' }).end(minified)
		} else if (files.includes(path)) {
			const body = await readFile(join(root, path))
			res.writeHead(200, { 'content-type': 'text/javascript' }).end(body)
		} else {
			res.writeHead(404).end()
		}
	})
	const port = await new Promise(resolve =>
		http.listen(0, '127.0.0.1', () => {
			const address = http.address()
			resolve(address && typeof address === 'object' ? address.port : 0)
		}),
	)
	return { url: `http://127.0.0.1:${port}/`, close: () => http.close() }
}

/** Bytes of the handshake request line for request target `url`. */
const requestLine = url => `GET ${url} HTTP/1.1\r\n`.length
/** Form-encoded length of `text`, as the client measures it. */
const encoded = text =>
	new URLSearchParams({ m: text }).toString().length - 2
/** Messages a connect request carried in its `m` param. */
const packedIn = url =>
	JSON.parse(new URL(url, 'http://x').searchParams.get('m') || '[]')

/** Server recording each connect URL and every dispatched batch. */
async function bootRecording(port = 0) {
	const s = new Server()
	/** @type {string[]} */
	const urls = []
	/** @type {any[][]} */
	const batches = []
	s.hooks.connect = (_sock, request) => urls.push(request.url)
	s.hooks.incoming = (_sock, messages) =>
		batches.push(messages.map(m => [m[0], m[1]]))
	s.events.m = () => {}
	await s.listen({ port })
	return { s, port: s.port, urls, batches }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Firefox reloads a page holding a socket instead of caching it, and
// only full Chromium caches pages, with Playwright's switch against it off.
const caching = {
	channel: 'chromium',
	ignoreDefaultArgs: ['--disable-back-forward-cache'],
}

describe('client in a page kept in the back/forward cache', { skip: !existsSync(chromium.executablePath()) && 'browser not installed' }, () => {
	/** @type {Awaited<ReturnType<typeof bootPageServer>>} */
	let pageServer
	/** @type {import('playwright').Browser} */
	let browser
	before(async () => {
		pageServer = await bootPageServer()
		browser = await chromium.launch(caching)
	})
	after(async () => {
		await browser?.close()
		pageServer?.close()
	})

	/** A page with a connected client, navigated away from. */
	const leave = async url => {
		const page = await browser.newPage()
		page.on('pageerror', err => console.error('[cached page]', err))
		await page.goto(pageServer.url)
		await page.waitForFunction(() => window.Client)
		await page.evaluate(url => {
			addEventListener('pageshow', e => (window.restored = e.persisted))
			window.make(url)
		}, url)
		await page.waitForFunction(() => window.client.connected)
		await page.goto(pageServer.url + 'elsewhere')
		return page
	}
	/** Goes back to a page that must come from the cache, and checks it works. */
	const restored = async (page, s) => {
		await page.evaluate(() => history.back())
		await page.waitForFunction(() => window.restored === true)
		await page.waitForFunction(() => window.client.connected)
		s.server.events.shout = (_sock, data, reply) => reply(data.toUpperCase())
		assert.equal(await page.evaluate(() => window.client.request('shout', 'hi')), 'HI')
		assert.deepEqual(await page.evaluate(() => window.log), ['connect', 'disconnect', 'reconnect'])
		assert.equal(s.server.sockets.size, 1)
	}

	it('holds its connection while cached, and reconnects as it is restored', async () => {
		const s = await bootServer()
		const page = await leave(s.baseUrl)
		try {
			await sleep(500)
			assert.equal(s.server.sockets.size, 1, 'held while cached')
			await restored(page, s)
		} finally {
			await page.close()
			await s.stop()
		}
	})

	it('is timed out by the server while cached, and reconnects as it is restored', async () => {
		const s = await bootServer()
		const page = await leave(s.baseUrl)
		try {
			for (const socket of s.server.sockets) socket.seen = s.server.now - (TIMEOUT_MS + 1)
			s.server.sweep()
			assert.equal(s.server.sockets.size, 0, 'timed out')
			await restored(page, s)
		} finally {
			await page.close()
			await s.stop()
		}
	})
})

for (const browserType of [chromium, firefox]) {
	const name = browserType.name()
	const installed = existsSync(browserType.executablePath())

	describe(`client in ${name}`, { skip: !installed && 'browser not installed' }, () => {
		/** @type {Awaited<ReturnType<typeof bootPageServer>>} */
		let pageServer
		/** @type {import('playwright').Browser} */
		let browser

		before(async () => {
			pageServer = await bootPageServer()
			browser = await browserType.launch()
		})
		after(async () => {
			await browser?.close()
			pageServer?.close()
		})

		/**
		 * A fresh page with the client loaded; with `url`, also a client
		 * as `window.client`. Close it with `page.close()`.
		 *
		 * @param {string} [url]
		 * @param {object} [options]
		 */
		const open = async (url, options = {}) => {
			const page = await browser.newPage()
			page.on('pageerror', err => console.error(`[${name}]`, err))
			await page.goto(pageServer.url)
			await page.waitForFunction(() => window.Client)
			if (url) {
				await page.evaluate(arg => window.make(arg.url, arg.options), {
					url,
					options,
				})
			}
			return page
		}
		/** @param {import('playwright').Page} page */
		const connected = page => page.evaluate(() => window.client.connected)

		describe('worker', () => {
			it('runs the socket in a worker; emit, reply and server emit work', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => connected(page))
					assert.equal(await page.evaluate(() => window.mainThreadSockets), 0)

					s.server.events.shout = (_sock, data, reply) =>
						reply(data.toUpperCase())
					assert.equal(
						await page.evaluate(() => window.client.emit('shout', 'hi', r => r)),
						'HI',
					)

					await page.evaluate(() =>
						window.client.on('news', v => window.log.push('news:' + v)),
					)
					s.server.emit('news', 'hello')
					await waitFor(() =>
						page.evaluate(() => window.log.includes('news:hello')),
					)
					assert.deepEqual(await page.evaluate(() => window.log), [
						'connect',
						'news:hello',
					])
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('reports a worker blocked by a Content Security Policy', async () => {
				const page = await browser.newPage()
				/** @type {string[]} */
				const errors = []
				page.on('console', m => m.type() === 'error' && errors.push(m.text()))
				try {
					await page.goto(pageServer.url + 'no-workers')
					await page.waitForFunction(() => window.Client)
					await page.evaluate(() => window.make('ws://127.0.0.1:1'))
					assert.ok(
						await waitFor(() => errors.some(e => e.startsWith('[angelia.io] client'))),
						`expected the client to report it, got ${JSON.stringify(errors)}`,
					)
				} finally {
					await page.close()
				}
			})

			it('works bundled and minified', async () => {
				const s = await bootServer()
				s.server.events.shout = (_sock, data, reply) => reply(data.toUpperCase())
				const page = await browser.newPage()
				page.on('pageerror', err => console.error(`[${name}]`, err))
				try {
					await page.goto(pageServer.url + 'minified')
					await page.waitForFunction(() => window.Client)
					await page.evaluate(url => window.make(url), s.baseUrl)
					await waitFor(() => connected(page))
					assert.equal(await page.evaluate(() => window.mainThreadSockets), 0)
					assert.equal(
						await page.evaluate(() => window.client.request('shout', 'hi')),
						'HI',
					)
					await page.evaluate(() =>
						window.client.on('news', v => window.log.push('news:' + v)),
					)
					s.server.emit('news', 1)
					await waitFor(() => page.evaluate(() => window.log.includes('news:1')))
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('throws when the environment has no Worker', async () => {
				const page = await open()
				try {
					const message = await page.evaluate(() => {
						Reflect.deleteProperty(window, 'Worker')
						try {
							new window.Client({ url: 'ws://127.0.0.1:1', noConnect: true })
							return 'no error'
						} catch (err) {
							return err instanceof Error ? err.message : String(err)
						}
					})
					assert.match(message, /Web Worker/)
				} finally {
					await page.close()
				}
			})

			/** Resolves with the time of each heartbeat the server gets from its socket. */
			const heartbeats = sock => {
				const times = []
				sock.io.on('message', raw => raw.length === 0 && times.push(Date.now()))
				return times
			}

			/** A page whose client's worker runs on a fast clock. */
			const openFast = async url => {
				const page = await open()
				await page.evaluate(
					([url, speed]) => {
						window.workerPrelude = `{
							const start = Date.now(), now = Date.now, every = setInterval
							Date.now = () => start + (now() - start) * ${speed}
							self.setInterval = (run, ms) => every(run, ms / ${speed})
						};`
						window.make(url)
					},
					[url, WORKER_SPEED],
				)
				return page
			}
			const heartbeatEvery = (TIMEOUT_MS / 2 / WORKER_SPEED)

			// Firefox routes a worker's WebSocket through the main thread, so a
			// blocked page holds the heartbeat back there until it's free.
			const beatsWhileBlocked = name === 'chromium'
			it(`heartbeat ${beatsWhileBlocked ? 'goes out' : 'is held back'} while the main thread is blocked`, async () => {
				const s = await bootServer()
				const page = await openFast(s.baseUrl)
				try {
					await waitFor(() => s.server.sockets.size === 1)
					const times = heartbeats([...s.server.sockets][0])
					await page.evaluate(ms => window.busy(ms), heartbeatEvery * 2)
					if (beatsWhileBlocked) assert.ok(times.length > 0, 'a heartbeat while blocked')
					else assert.ok(await waitFor(() => times.length > 0), 'a heartbeat once free')
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('sends its heartbeat while only listening', async () => {
				const s = await bootServer()
				const page = await openFast(s.baseUrl)
				const listening = setInterval(() => s.server.emit('news', 1), 200)
				try {
					await waitFor(() => s.server.sockets.size === 1)
					const times = heartbeats([...s.server.sockets][0])
					await sleep(heartbeatEvery * 2)
					assert.ok(times.length > 0, 'a heartbeat while only listening')
				} finally {
					clearInterval(listening)
					await page.close()
					await s.stop()
				}
			})

			it('stays connected while only talking, as the server answers', async () => {
				const s = await bootServer()
				s.server.events.chat = () => {}
				const page = await openFast(s.baseUrl)
				try {
					await waitFor(() => s.server.sockets.size === 1)
					await page.evaluate(() => {
						window.talking = setInterval(() => window.client.emit('chat', 1), 200)
					})
					await sleep(heartbeatEvery * 4)
					assert.deepEqual(await page.evaluate(() => window.log), ['connect'])
					assert.equal(s.server.served, 1)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('gives up on a server that stopped answering, and reconnects', async () => {
				const s = await bootServer()
				const page = await openFast(s.baseUrl)
				try {
					await waitFor(() => s.server.sockets.size === 1)
					const [sock] = s.server.sockets
					// The connection stays open, as one the network dropped silently.
					sock.write = () => {}
					await page.waitForFunction(() => window.log.includes('reconnect'), null, { timeout: heartbeatEvery * 5 })
					assert.deepEqual(await page.evaluate(() => window.log), ['connect', 'disconnect', 'reconnect'])
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('a reply lost to a drop is no unhandled rejection, a throwing callback is', async () => {
				const s = await bootServer()
				s.server.events.silent = () => {}
				s.server.events.answer = (_sock, _data, reply) => reply(1)
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => s.server.sockets.size === 1)
					await page.evaluate(() => {
						window.unhandled = []
						addEventListener('unhandledrejection', e => {
							e.preventDefault()
							window.unhandled.push(e.reason.message)
						})
						window.client.emit('silent', 1, () => {})
					})
					await waitFor(() => [...s.server.sockets][0].messagesReceived === 1)
					;[...s.server.sockets][0].disconnect()
					await page.waitForFunction(() => window.log.includes('reconnect'))
					await page.evaluate(() => {
						window.client.emit('answer', 1, () => {
							throw new Error('from the callback')
						})
					})
					await page.waitForFunction(() => window.unhandled.length > 0)
					await page.evaluate(() => {
						window.client.emit('silent', 1, () => {})
						window.client.disconnect(true)
						window.client.emit('silent', 1, () => {})
					})
					await sleep(200)
					assert.deepEqual(await page.evaluate(() => window.unhandled), ['from the callback'])
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('going online does nothing while connected', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => s.server.sockets.size === 1)
					await page.evaluate(() => dispatchEvent(new Event('online')))
					await sleep(300)
					assert.deepEqual(await page.evaluate(() => window.log), ['connect'])
					assert.equal(s.server.served, 1)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('going online reconnects at once instead of waiting for the retry', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => s.server.sockets.size === 1)
					const [sock] = s.server.sockets
					// Going away makes the client wait 2-4s before it retries.
					sock.io.close(1001)
					await page.waitForFunction(() => window.log.includes('disconnect'))
					await page.evaluate(() => dispatchEvent(new Event('online')))
					await page.waitForFunction(() => window.log.includes('reconnect'), null, { timeout: 1500 })
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('going online stays quiet after disconnect(true) and before connect()', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl, { noConnect: true })
				try {
					await page.evaluate(() => dispatchEvent(new Event('online')))
					await sleep(300)
					assert.equal(s.server.served, 0)
					await page.evaluate(() => window.client.connect())
					await waitFor(() => s.server.sockets.size === 1)
					await page.evaluate(() => {
						window.client.disconnect(true)
						dispatchEvent(new Event('online'))
					})
					await sleep(300)
					assert.equal(s.server.served, 1)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('a throwing listener surfaces its error without skipping the batch', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				/** @type {string[]} */
				const pageErrors = []
				page.on('pageerror', err => pageErrors.push(err.message))
				try {
					await page.evaluate(() => {
						window.client.on('boom', () => {
							throw new Error('listener failed')
						})
						window.client.on('boom', v => window.log.push('boom:' + v))
						window.client.on('news', v => window.log.push('news:' + v))
					})
					await waitFor(() => connected(page))
					// Same tick, so both arrive in one batch.
					s.server.emit('boom', 1)
					s.server.emit('news', 'after')
					await waitFor(() =>
						page.evaluate(() => window.log.includes('news:after')),
					)
					assert.deepEqual(await page.evaluate(() => window.log), [
						'connect',
						'boom:1',
						'news:after',
					])
					assert.ok(await waitFor(() => pageErrors.length === 1))
					assert.match(pageErrors[0], /listener failed/)
				} finally {
					await page.close()
					await s.stop()
				}
			})
		})

		describe('emit and replies', () => {
			it('emits before and after connecting reach the server', async () => {
				const s = await bootServer()
				let connects = 0
				const seen = []
				s.server.hooks.connect = () => connects++
				s.server.events.hi = (_sock, data) => seen.push(data)
				const page = await open()
				try {
					await page.evaluate(url => {
						window.make(url)
						window.client.emit('hi', 'pre-connect')
					}, s.baseUrl)
					await waitFor(() => seen.length === 1)
					await page.evaluate(() => window.client.emit('hi', 'post-connect'))
					await waitFor(() => seen.length === 2)
					assert.deepEqual(seen, ['pre-connect', 'post-connect'])
					assert.equal(connects, 1)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('emit(k, v, fn) resolves with fn(reply)', async () => {
				const s = await bootServer()
				s.server.events.shout = (_sock, data, reply) => reply(data.toUpperCase())
				s.server.events.echo = (_sock, data, reply) => reply(data)
				const page = await open(s.baseUrl)
				try {
					const [length, echoed] = await page.evaluate(async () => [
						await window.client.emit('shout', 'hello', r => r.length),
						await window.client.emit('echo', undefined, r => r),
					])
					assert.equal(length, 5)
					// No value: JSON sends `null` in its place.
					assert.equal(echoed, null)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('request(k, v) resolves with the reply', async () => {
				const s = await bootServer()
				s.server.events.add = (_sock, [a, b], reply) => reply(a + b)
				s.server.events.knock = (_sock, _data, reply) => reply('who')
				const page = await open(s.baseUrl)
				try {
					assert.deepEqual(
						await page.evaluate(async () => [
							await window.client.request('add', [2, 3]),
							await window.client.request('knock'),
						]),
						[5, 'who'],
					)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('a reply callback that throws rejects its promise', async () => {
				const s = await bootServer()
				s.server.events.echo = (_sock, data, reply) => reply(data)
				const page = await open(s.baseUrl)
				try {
					const message = await page.evaluate(() =>
						window.client
							.emit('echo', 1, () => {
								throw new Error('callback failed')
							})
							.then(
								() => 'resolved',
								err => err.message,
							),
					)
					assert.equal(message, 'callback failed')
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('the server can request a reply from the client', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await page.evaluate(() =>
						window.client.on('double', (v, reply) => reply?.(v * 2)),
					)
					await waitFor(() => s.server.sockets.size === 1)
					const [sock] = s.server.sockets
					assert.equal(await sock.request('double', 21), 42)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('drops a second reply() call without throwing', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await page.evaluate(() =>
						window.client.on('ask', (_data, reply) => {
							reply?.('first')
							reply?.('second')
						}),
					)
					await waitFor(() => s.server.sockets.size === 1)
					const [sock] = s.server.sockets
					assert.equal(await sock.request('ask', 'q'), 'first')
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('emit(k) sends no value; key 0 works and the empty key is dropped', async () => {
				const s = await bootServer()
				const seen = []
				s.server.events.bare = (_sock, data) => seen.push(['bare', data])
				s.server.events['0'] = (_sock, data) => seen.push(['0', data])
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => connected(page))
					const empty = await page.evaluate(() => {
						window.client.emit('bare')
						// Not a key the types allow; checks the runtime handles it.
						Reflect.apply(window.client.emit, window.client, [0, 'zero'])
						return window.client.emit('', 'empty') === undefined
					})
					await waitFor(() => seen.length === 2)
					assert.equal(empty, true)
					assert.deepEqual(seen, [
						['bare', undefined],
						['0', 'zero'],
					])
					assert.equal(s.server.messagesGarbage, 0)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('emits in the same tick go out as one batch', async () => {
				const s = await bootServer()
				const seen = []
				let batches = 0
				s.server.events.batch = (_sock, data) => seen.push(data)
				s.server.hooks.incoming = () => batches++
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => connected(page))
					await page.evaluate(() => {
						window.client.emit('batch', 1)
						window.client.emit('batch', 2)
						window.client.emit('batch', 3)
					})
					await waitFor(() => seen.length === 3)
					assert.deepEqual(seen, [1, 2, 3])
					assert.equal(batches, 1)
				} finally {
					await page.close()
					await s.stop()
				}
			})
		})

		describe('listeners', () => {
			it('off() and an aborted signal both stop listening', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await page.evaluate(() => {
						window.off = window.client.on('a', v => window.log.push('a:' + v))
						window.controller = new AbortController()
						window.client.on('b', v => window.log.push('b:' + v), {
							signal: window.controller.signal,
						})
						const aborted = new AbortController()
						aborted.abort()
						window.client.on('c', v => window.log.push('c:' + v), {
							signal: aborted.signal,
						})
						window.client.on('done', () => window.log.push('done'))
					})
					await waitFor(() => connected(page))
					s.server.emit('a', 1)
					s.server.emit('b', 1)
					s.server.emit('c', 1)
					await waitFor(() => page.evaluate(() => window.log.length === 3))
					await page.evaluate(() => {
						window.off?.()
						window.controller.abort()
					})
					s.server.emit('a', 2)
					s.server.emit('b', 2)
					s.server.emit('done', 1)
					await waitFor(() => page.evaluate(() => window.log.includes('done')))
					assert.deepEqual(await page.evaluate(() => window.log), [
						'connect',
						'a:1',
						'b:1',
						'done',
					])
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('a listener that removes itself does not make the next one miss the event', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await page.evaluate(() => {
						const off = window.client.on('once', v => {
							off?.()
							window.log.push('first:' + v)
						})
						window.client.on('once', v => window.log.push('second:' + v))
					})
					await waitFor(() => connected(page))
					s.server.emit('once', 1)
					s.server.emit('once', 2)
					await waitFor(() => page.evaluate(() => window.log.includes('second:2')))
					assert.deepEqual(await page.evaluate(() => window.log), [
						'connect',
						'first:1',
						'second:1',
						'second:2',
					])
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('names on Object.prototype are ordinary events', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await page.evaluate(() => {
						for (const n of ['constructor', '__proto__', 'toString', 'done']) {
							window.client.on(n, v => window.log.push(n + ':' + v))
						}
					})
					await waitFor(() => connected(page))
					s.server.emit('constructor', 1)
					s.server.emit('__proto__', 2)
					s.server.emit('toString', 3)
					// Nobody listens to these: skipped, not a crash.
					s.server.emit('hasOwnProperty', 4)
					s.server.emit('valueOf', 5)
					s.server.emit('done', 6)
					await waitFor(() => page.evaluate(() => window.log.includes('done:6')))
					assert.deepEqual(await page.evaluate(() => window.log), [
						'connect',
						'constructor:1',
						'__proto__:2',
						'toString:3',
						'done:6',
					])
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('connect fires once on the first connection', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => connected(page))
					await sleep(50)
					assert.deepEqual(await page.evaluate(() => window.log), ['connect'])
				} finally {
					await page.close()
					await s.stop()
				}
			})
		})

		describe('options and state', () => {
			it('params, as an object or a function called per connect, reach the server', async () => {
				const s = await bootServer()
				const seen = []
				s.server.hooks.connect = sock => seen.push({ ...sock.params })
				const page = await open()
				try {
					await page.evaluate(url => {
						window.calls = 0
						window.make(url, { params: { user: 'tito' } })
						window.second = new window.Client({
							url,
							params: () => ({ n: String(++window.calls) }),
						})
					}, s.baseUrl)
					await waitFor(() => seen.length === 2)
					const byUser = seen.find(p => p.user)
					const byFn = seen.find(p => p.n)
					assert.equal(byUser.user, 'tito')
					assert.equal(typeof byUser.connid, 'string')
					assert.equal(byFn.n, '1')
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('accepts only ws:// and wss:// URLs', async () => {
				const page = await open()
				try {
					const results = await page.evaluate(() =>
						['http://x:1', 'https://x:1', 'ftp://x', 'ws://x:1', 'wss://x:1'].map(url => {
							try {
								new window.Client({ url, noConnect: true })
								return 'ok'
							} catch (err) {
								return err instanceof Error ? err.message : String(err)
							}
						}),
					)
					for (const r of results.slice(0, 3)) assert.match(r, /ws:\/\/ or wss:\/\//)
					assert.deepEqual(results.slice(3), ['ok', 'ok'])
				} finally {
					await page.close()
				}
			})

			it('connects to the path in its URL, the default without one', async () => {
				const custom = await bootServer({ path: '/live' })
				const plain = await bootServer()
				const page = await open()
				try {
					await page.evaluate(([a, b]) => {
						window.a = new window.Client({ url: a })
						window.b = new window.Client({ url: b })
					}, [`${custom.baseUrl}/live`, plain.baseUrl])
					await waitFor(
						() => custom.server.sockets.size === 1 && plain.server.sockets.size === 1,
					)
				} finally {
					await page.close()
					await custom.stop()
					await plain.stop()
				}
			})

			it('noConnect waits for connect()', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl, { noConnect: true })
				try {
					await sleep(200)
					assert.equal(s.server.sockets.size, 0)
					await page.evaluate(() => window.client.connect())
					await waitFor(() => s.server.sockets.size === 1)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('connected is read-only', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => connected(page))
					const assigned = await page.evaluate(() =>
						Reflect.set(window.client, 'connected', false),
					)
					assert.equal(assigned, false)
					assert.equal(await connected(page), true)
				} finally {
					await page.close()
					await s.stop()
				}
			})
		})

		describe('disconnect and reconnect', () => {
			it('disconnect(true) closes for good', async () => {
				const s = await bootServer()
				let disconnects = 0
				s.server.hooks.disconnect = () => disconnects++
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => s.server.sockets.size === 1)
					await page.evaluate(() => window.client.disconnect(true))
					await waitFor(() => s.server.sockets.size === 0)
					await sleep(200)
					assert.equal(s.server.sockets.size, 0)
					assert.equal(disconnects, 1)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('disconnect(true) between retries settles what was waiting', async () => {
				const port = await freePort()
				const page = await open(`ws://127.0.0.1:${port}`)
				try {
					const message = await page.evaluate(async () => {
						const pending = window.client
							.request('never', 1)
							.catch(err => err.message)
						// Nothing listens: the first attempt fails, a retry is scheduled.
						await new Promise(r => setTimeout(r, 300))
						window.client.disconnect(true)
						return pending
					})
					assert.match(message, /^disconnected:/)
				} finally {
					await page.close()
				}
			})

			it('emits after disconnect(true) are dropped; replies reject', async () => {
				const s = await bootServer()
				const seen = []
				s.server.events.late = (_sock, v) => seen.push(v)
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => connected(page))
					const result = await page.evaluate(async () => {
						window.client.disconnect(true)
						const plain = window.client.emit('late', 1)
						const message = await window.client
							.request('late', 2)
							.catch(err => err.message)
						return [plain === undefined, message]
					})
					assert.equal(result[0], true)
					assert.match(result[1], /^disconnected:/)
					await sleep(100)
					assert.deepEqual(seen, [])
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('`using` a client disconnects it for good at scope end', async () => {
				const s = await bootServer()
				const page = await open()
				try {
					await page.evaluate(async url => {
						using client = new window.Client({ url })
						await new Promise(resolve => client.on('connect', resolve))
					}, s.baseUrl)
					await waitFor(() => s.server.served === 1 && s.server.sockets.size === 0)
					await sleep(200)
					assert.equal(s.server.served, 1)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('a reason over 123 bytes throws and keeps the connection', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => connected(page))
					const error = await page.evaluate(() => {
						try {
							window.client.disconnect(true, 'x'.repeat(124))
						} catch (err) {
							return err instanceof Error ? err.name : String(err)
						}
					})
					assert.equal(error, 'RangeError')
					await sleep(50)
					assert.equal(await connected(page), true)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('server disconnect(true) fires disconnect once and stops reconnecting', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => s.server.sockets.size === 1)
					const [sock] = s.server.sockets
					sock.disconnect(true)
					await waitFor(async () => !(await connected(page)))
					await page.evaluate(() => window.client.connect())
					await sleep(200)
					assert.equal(s.server.served, 1)
					assert.deepEqual(await page.evaluate(() => window.log), [
						'connect',
						'disconnect',
					])
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('soft disconnect + connect() dispatches reconnect over the same worker', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => connected(page))
					await page.evaluate(() => window.client.disconnect())
					await waitFor(async () => !(await connected(page)))
					await page.evaluate(() => window.client.connect())
					await waitFor(() => connected(page))
					await waitFor(() => s.server.sockets.size === 1)
					assert.deepEqual(await page.evaluate(() => window.log), [
						'connect',
						'disconnect',
						'reconnect',
					])
					assert.equal(s.server.served, 2)
					assert.equal(await page.evaluate(() => window.mainThreadSockets), 0)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('pending replies reject with Error("reconnecting")', async () => {
				const s = await bootServer()
				s.server.events.never = () => {}
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => connected(page))
					await page.evaluate(() => {
						window.pending = window.client
							.emit('never', 1, () => 'unused')
							.catch(err => err.message)
						window.client.disconnect()
					})
					await waitFor(async () => !(await connected(page)))
					await page.evaluate(() => window.client.connect())
					assert.match(await page.evaluate(() => window.pending), /^reconnecting:/)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('pending replies reject with Error("disconnected") on disconnect(true)', async () => {
				const s = await bootServer()
				s.server.events.never = () => {}
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => connected(page))
					const message = await page.evaluate(() => {
						const pending = window.client
							.request('never', 1)
							.catch(err => err.message)
						window.client.disconnect(true)
						return pending
					})
					assert.match(message, /^disconnected:/)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('reconnects at once when a connection that was up drops', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => connected(page))
					// Past the retry minimum, so this counts as a working connection.
					await sleep(2100)
					const [sock] = s.server.sockets
					const dropped = Date.now()
					sock.disconnect()
					await waitFor(() => s.server.served === 2 && s.server.sockets.size === 1)
					const took = Date.now() - dropped
					assert.ok(took < 500, `reconnected after ${took}ms`)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('reconnects after a delay when the server goes away (1001)', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => connected(page))
					// Past the retry minimum, where a plain drop reconnects at once.
					await sleep(2100)
					const [sock] = s.server.sockets
					const dropped = Date.now()
					sock.io.close(1001, 'server restarting')
					await sleep(1500)
					assert.equal(s.server.served, 1, 'not at once: it may be the page leaving')
					await waitFor(() => s.server.served === 2, 160)
					const took = Date.now() - dropped
					assert.ok(took >= 1900 && took < 4500, `reconnected after ${took}ms`)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('a page reload does not open a second connection', async () => {
				const s = await bootServer()
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => connected(page))
					// Past the retry minimum: a reconnect would be immediate.
					await sleep(2100)
					await page.reload()
					await page.waitForFunction(() => window.Client)
					await page.evaluate(url => window.make(url), s.baseUrl)
					await waitFor(() => connected(page))
					await sleep(500)
					assert.equal(s.server.served, 2, 'one connection before, one after')
					assert.equal(s.server.sockets.size, 1)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('waits 2–4s before retrying a failed attempt', async () => {
				const port = await freePort()
				const page = await open(`ws://127.0.0.1:${port}`)
				const s = new Server()
				try {
					// Nothing listens yet: the first attempt fails and schedules a retry.
					await sleep(150)
					const failed = Date.now()
					await s.listen({ port })
					await sleep(1650)
					assert.equal(s.served, 0, 'retried before the minimum delay')
					await waitFor(() => s.served === 1, 160)
					const took = Date.now() - failed
					assert.ok(took >= 1800 && took < 4500, `retried after ${took}ms`)
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('waits before reconnecting when the server drops it right after opening', async () => {
				const s = await bootServer()
				s.server.hooks.connect = sock => sock.disconnect()
				const page = await open(s.baseUrl)
				try {
					await waitFor(() => s.server.served === 1)
					await sleep(1500)
					assert.equal(s.server.served, 1, 'must not loop on an instant drop')
				} finally {
					await page.close()
					await s.stop()
				}
			})
		})

		describe('URL packing', () => {
			it('packs every pre-connect message into the URL when they fit', async () => {
				const { s, port, urls, batches } = await bootRecording()
				const page = await open()
				try {
					await page.evaluate(url => {
						window.make(url)
						window.client.emit('m', 1)
						window.client.emit('m', 2)
						window.client.emit('m', 3)
					}, `ws://127.0.0.1:${port}`)
					await waitFor(() => batches.length === 1)
					assert.deepEqual(packedIn(urls[0]), [['m', 1], ['m', 2], ['m', 3]])
					assert.deepEqual(batches, [[['m', 1], ['m', 2], ['m', 3]]])
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('packs what fits and sends the rest over the socket, in order', async () => {
				const { s, port, urls, batches } = await bootRecording()
				const big = n => 'x'.repeat(3000) + n
				const page = await open()
				try {
					await page.evaluate(url => {
						window.make(url)
						for (const n of [1, 2, 3]) window.client.emit('m', 'x'.repeat(3000) + n)
						window.client.emit('m', 'small')
					}, `ws://127.0.0.1:${port}`)
					await waitFor(() => batches.flat().length === 4)
					// As full as it can be: within the limit, but not with one more.
					const line = requestLine(urls[0])
					assert.ok(line <= 8192, `request line is ${line} bytes`)
					assert.ok(line + encoded(',' + JSON.stringify(['m', big(3)])) > 8192)
					assert.deepEqual(packedIn(urls[0]), [['m', big(1)], ['m', big(2)]])
					assert.deepEqual(batches, [
						[['m', big(1)], ['m', big(2)]],
						[['m', big(3)], ['m', 'small']],
					])
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('stops at the first message that does not fit, so order is kept', async () => {
				const { s, port, urls, batches } = await bootRecording()
				const page = await open()
				try {
					await page.evaluate(url => {
						window.make(url)
						window.client.emit('m', 'x'.repeat(9000))
						window.client.emit('m', 'small')
					}, `ws://127.0.0.1:${port}`)
					await waitFor(() => batches.flat().length === 2)
					assert.deepEqual(packedIn(urls[0]), [])
					assert.deepEqual(batches, [[['m', 'x'.repeat(9000)], ['m', 'small']]])
				} finally {
					await page.close()
					await s.stop()
				}
			})

			it('requeues packed messages after a failed connect, keeping order and callbacks', async () => {
				const port = await freePort()
				const page = await open(`ws://127.0.0.1:${port}`, { noConnect: true })
				/** @type {Awaited<ReturnType<typeof bootRecording>> | undefined} */
				let recording
				try {
					await page.evaluate(() => {
						window.client.emit('m', 'a')
						window.replied = window.client.emit('echo', 'b', r => r)
						window.client.connect()
					})
					// Nothing listens yet: that attempt fails before opening.
					await sleep(300)
					assert.equal(await connected(page), false)
					await page.evaluate(() => window.client.emit('m', 'c'))

					recording = await bootRecording(port)
					recording.s.events.echo = (_sock, data, reply) => reply(data)
					await page.evaluate(() => window.client.connect())
					const { urls, batches } = recording
					await waitFor(() => batches.flat().length === 3)
					// The retry doesn't pack: the URL may be what failed.
					assert.deepEqual(packedIn(urls[0]), [])
					assert.deepEqual(batches, [[['m', 'a'], ['echo', 'b'], ['m', 'c']]])
					assert.equal(await page.evaluate(() => window.replied), 'b')
				} finally {
					await page.close()
					await recording?.s.stop()
				}
			})

			it('gets through a proxy that rejects long URLs instead of retrying the same URL', async () => {
				const { s, port, urls, batches } = await bootRecording()
				// Stands in for a proxy with a small URL limit: 414 for any packed URL.
				const proxy = createNetServer(conn => {
					let head = ''
					const onData = chunk => {
						head += chunk.toString('latin1')
						if (!head.includes('\r\n')) return
						conn.off('data', onData)
						if (head.split('\r\n')[0].includes('m=')) {
							conn.end('HTTP/1.1 414 URI Too Long\r\nConnection: close\r\n\r\n')
							return
						}
						const upstream = connect(port, '127.0.0.1', () => {
							upstream.write(head, 'latin1')
							conn.pipe(upstream).pipe(conn)
						})
						upstream.on('error', () => conn.destroy())
						conn.on('error', () => upstream.destroy())
					}
					conn.on('data', onData)
				})
				const proxyPort = await freePort()
				await new Promise(resolve =>
					proxy.listen(proxyPort, '127.0.0.1', () => resolve(undefined)),
				)
				const page = await open(`ws://127.0.0.1:${proxyPort}`, { noConnect: true })
				try {
					await page.evaluate(() => {
						window.client.emit('m', 'a')
						window.client.connect()
					})
					await sleep(300)
					assert.equal(urls.length, 0, 'the packed attempt was rejected')
					await page.evaluate(() => window.client.connect())
					await waitFor(() => batches.length === 1)
					assert.deepEqual(packedIn(urls[0]), [])
					assert.deepEqual(batches, [[['m', 'a']]])
				} finally {
					await page.close()
					proxy.close()
					await s.stop()
				}
			})
		})
	})
}
