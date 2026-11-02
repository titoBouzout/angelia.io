/**
 * The Client in real browsers, where it runs its WebSocket in a Web
 * Worker. Skips when Playwright's browsers aren't installed
 * (`npx playwright install chromium firefox`).
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, firefox } from 'playwright'

import { Server, freePort, waitFor } from './helpers.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Counts WebSockets built on the main thread, then exposes the Client.
const PAGE = `<!doctype html>
<script type="module">
	const Native = WebSocket
	window.mainThreadSockets = 0
	window.WebSocket = class extends Native {
		constructor(...args) {
			super(...args)
			window.mainThreadSockets++
		}
	}
	const { default: Client } = await import('/client/index.js')
	window.Client = Client
	window.events = []
	window.make = (url, options) => {
		const client = new Client({ url, ...options })
		for (const e of ['connect', 'reconnect', 'disconnect'])
			client.on(e, () => window.events.push(e))
		client.on('news', v => window.events.push('news:' + v))
		window.client = client
	}
	window.busy = ms => {
		const end = Date.now() + ms
		while (Date.now() < end) {}
	}
</script>`

/** Serves the test page and the client sources, nothing else. */
async function bootPageServer() {
	const files = [
		'/client/index.js',
		'/client/transport.js',
		'/shared/protocol.js',
	]
	const http = createServer(async (req, res) => {
		const path = (req.url || '/').split('?')[0]
		if (path === '/') {
			res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)
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

for (const browserType of [chromium, firefox]) {
	const name = browserType.name()
	const installed = existsSync(browserType.executablePath())

	describe(`client in ${name}`, { skip: !installed && 'browser not installed' }, () => {
		let pageServer, browser, s, wsUrl

		before(async () => {
			pageServer = await bootPageServer()
			browser = await browserType.launch()
		})
		after(async () => {
			await browser?.close()
			pageServer?.close()
		})

		/** Fresh angelia server + page per test. */
		const setup = async (options = {}) => {
			s = new Server()
			await s.listen({ port: 0 })
			wsUrl = `ws://127.0.0.1:${s.port}`
			const page = await browser.newPage()
			page.on('pageerror', err => console.error(`[${name}]`, err))
			await page.goto(pageServer.url)
			await page.waitForFunction(() => window.Client)
			await page.evaluate(([url, o]) => window.make(url, o), [wsUrl, options])
			await waitFor(() => s.sockets.size === 1)
			return page
		}
		const teardown = async page => {
			await page.close()
			await s.stop()
		}

		it('runs the socket in a worker; emit, reply and server emit work', async () => {
			const page = await setup()
			try {
				assert.equal(await page.evaluate(() => window.mainThreadSockets), 0)

				s.events.shout = (_sock, data, reply) => reply(data.toUpperCase())
				const reply = await page.evaluate(() =>
					window.client.emit('shout', 'hi', r => r),
				)
				assert.equal(reply, 'HI')

				s.emit('news', 'hello')
				assert.ok(
					await waitFor(() =>
						page.evaluate(() => window.events.includes('news:hello')),
					),
				)
				assert.deepEqual(
					await page.evaluate(() => window.events),
					['connect', 'news:hello'],
				)
			} finally {
				await teardown(page)
			}
		})

		it('a throwing listener surfaces its error without skipping the batch', async () => {
			const page = await setup()
			const pageErrors = []
			page.on('pageerror', err => pageErrors.push(err.message))
			try {
				await page.evaluate(() => {
					window.client.on('boom', () => {
						throw new Error('listener failed')
					})
					window.client.on('boom', v => window.events.push('boom:' + v))
				})
				// Same tick, so both arrive in one batch.
				s.emit('boom', 1)
				s.emit('news', 'after')
				assert.ok(
					await waitFor(() =>
						page.evaluate(() => window.events.includes('news:after')),
					),
				)
				assert.deepEqual(await page.evaluate(() => window.events), [
					'connect',
					'boom:1',
					'news:after',
				])
				assert.ok(await waitFor(() => pageErrors.length === 1))
				assert.match(pageErrors[0], /listener failed/)
			} finally {
				await teardown(page)
			}
		})

		it('worker: false keeps the socket on the main thread', async () => {
			const page = await setup({ worker: false })
			try {
				assert.equal(await page.evaluate(() => window.mainThreadSockets), 1)
			} finally {
				await teardown(page)
			}
		})

		// Firefox delivers a worker's WebSocket events through the main
		// thread, so a blocked page delays the worker's pong there too.
		const answersWhileBlocked = name === 'chromium'
		for (const worker of [true, false]) {
			const answered = worker && answersWhileBlocked
			it(`heartbeat ${answered ? 'is' : 'is not'} answered while the main thread is blocked (worker: ${worker})`, async () => {
				const page = await setup({ worker })
				try {
					const pinged = new Promise(resolve => {
						s.hooks.ping = () => resolve(Date.now())
					})
					const blockMs = 1500
					// Not awaited: the page is now stuck for `blockMs`.
					const blocking = page.evaluate(ms => window.busy(ms), blockMs)
					await new Promise(r => setTimeout(r, 100))
					const [sock] = s.sockets
					sock.seen = s.now - s.timeoutCheck - 100
					const sent = Date.now()
					s.ping()
					const answeredAt = await pinged
					await blocking
					const waited = answeredAt - sent
					if (answered) assert.ok(waited < 500, `pong took ${waited}ms`)
					else assert.ok(waited > 1000, `pong took only ${waited}ms`)
				} finally {
					await teardown(page)
				}
			})
		}

		it('soft disconnect + connect() dispatches reconnect over the same worker', async () => {
			const page = await setup()
			try {
				await page.evaluate(() => window.client.disconnect())
				await waitFor(() => page.evaluate(() => !window.client.connected))
				await page.evaluate(() => window.client.connect())
				await waitFor(() => page.evaluate(() => window.client.connected))
				await waitFor(() => s.sockets.size === 1)
				assert.deepEqual(
					await page.evaluate(() => window.events),
					['connect', 'disconnect', 'reconnect'],
				)
				assert.equal(s.served, 2)
				assert.equal(await page.evaluate(() => window.mainThreadSockets), 0)
			} finally {
				await teardown(page)
			}
		})

		it('requeues URL-packed messages when the worker socket fails to connect', async () => {
			const port = await freePort()
			const page = await browser.newPage()
			page.on('pageerror', err => console.error(`[${name}]`, err))
			await page.goto(pageServer.url)
			await page.waitForFunction(() => window.Client)
			await page.evaluate(url => {
				window.make(url, { noConnect: true })
				window.client.emit('m', 'a')
				window.client.connect()
			}, `ws://127.0.0.1:${port}`)
			// Nothing listens on `port` yet, so that attempt fails.
			await new Promise(r => setTimeout(r, 300))

			s = new Server()
			const urls = []
			const seen = []
			s.hooks.connect = (_sock, request) => urls.push(request.url)
			s.events.m = (_sock, data) => seen.push(data)
			await s.listen({ port })
			try {
				await page.evaluate(() => window.client.connect())
				await waitFor(() => seen.length === 1)
				assert.deepEqual(seen, ['a'])
				// Requeued and sent over the socket, not repacked.
				assert.doesNotMatch(urls[0], /[?&]m=/)
			} finally {
				await teardown(page)
			}
		})

		it('server disconnect(true) closes the client and disables reconnect', async () => {
			const page = await setup()
			try {
				const [sock] = s.sockets
				sock.disconnect(true)
				await waitFor(() => page.evaluate(() => !window.client.connected))
				await page.evaluate(() => window.client.connect())
				await new Promise(r => setTimeout(r, 200))
				assert.equal(s.sockets.size, 0)
				assert.equal(s.served, 1)
			} finally {
				await teardown(page)
			}
		})
	})
}
