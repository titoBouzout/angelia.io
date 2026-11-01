/**
 * Main-thread client vs Web Worker client, in real browsers.
 *
 *   node bench/browser/run.js
 *
 * sync    = sends only: time from the first emit until the main
 *           thread is free again (stringify / postMessage clone + send)
 * blocked = main-thread time spent on anything but an idle probe loop,
 *           wherever the browser does the work (also covers string
 *           decoding and clone deserialization outside handlers)
 * longest = longest single main-thread stall
 * total   = wall time until the server acked / the last message was
 *           dispatched on the main thread. Round trip = median latency.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, firefox } from 'playwright'

import Server from '../../server/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const WS_PORT = 17100
const HTTP_PORT = 17101
const RUNS = 7
const WARMUP = 2

const item = { id: 1, user: 'José', text: 'héllo wörld — ✓ ok' }
const big = Array.from({ length: 12000 }, (_, i) => ({ ...item, id: i }))

Server.on(
	class {
		m() {}
		ack(_socket, _data, reply) {
			reply?.()
		}
		push(socket, { count, big: isBig }) {
			for (let i = 0; i < count; i++) socket.emit('pushed', isBig ? big : item)
			socket.emit('end')
		}
	},
)
await Server.listen({ port: WS_PORT, maxMessageSize: 200 })

const files = {
	'/client/index.js': join(root, 'client/index.js'),
	'/client/transport.js': join(root, 'client/transport.js'),
}
const http = createServer(async (req, res) => {
	const path = (req.url || '/').split('?')[0]
	const file =
		files[path] ?? normalize(join(here, path === '/' ? 'index.html' : path))
	if (!file.startsWith(here + sep) && !Object.values(files).includes(file)) {
		res.writeHead(404).end()
		return
	}
	try {
		const body = await readFile(file)
		const type = file.endsWith('.html') ? 'text/html' : 'text/javascript'
		res.writeHead(200, { 'content-type': `${type}; charset=utf-8` }).end(body)
	} catch {
		res.writeHead(404).end()
	}
})
await new Promise(resolve => http.listen(HTTP_PORT, '127.0.0.1', resolve))

const configs = [
	{ name: 'Chromium', browser: chromium },
	// Exact timers; Firefox rounds performance.now() to 1 ms by default.
	{
		name: 'Firefox',
		browser: firefox,
		options: { firefoxUserPrefs: { 'privacy.reduceTimerPrecision': false } },
	},
]
const variants = [
	['main', 'client, worker: false'],
	['worker', 'client, worker (default)'],
	['clone', 'worker, objects via postMessage (old design)'],
]

const fmt = v => (v === undefined ? '' : v.toFixed(1)).padStart(8)

for (const config of configs) {
	const browser = await config.browser.launch(config.options)
	/** @type {Record<string, Record<string, {busy?: number, total?: number}>>} */
	const table = {}
	for (const [variant, label] of variants) {
		const page = await browser.newPage()
		page.on('pageerror', err => console.error(`[${config.name} ${variant}]`, err))
		await page.goto(`http://127.0.0.1:${HTTP_PORT}/?port=${WS_PORT}`)
		await page.waitForFunction(() => window.benchReady)
		table[label] = await page.evaluate(
			([v, runs, warmup]) => window.runBench(v, runs, warmup),
			/** @type {const} */ ([variant, RUNS, WARMUP]),
		)
		await page.close()
	}
	await browser.close()

	console.log(`\n## ${config.name} — median of ${RUNS} runs, ms\n`)
	const scenarios = Object.keys(Object.values(table)[0])
	for (const scenario of scenarios) {
		console.log(scenario)
		for (const [label, results] of Object.entries(table)) {
			const r = results[scenario]
			console.log(
				`  ${label.padEnd(46)} sync ${fmt(r.busy)}  blocked ${fmt(r.blocked)}  longest ${fmt(r.longest)}  total ${fmt(r.total)}`,
			)
		}
	}
}

http.close()
await Server.stop()
