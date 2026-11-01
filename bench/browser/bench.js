import { WorkerClient } from './worker-client.js'
import Client from '/client/index.js'

const URL_ = `ws://127.0.0.1:${new URLSearchParams(location.search).get('port')}`

/** Resolve on the next macrotask, after every pending microtask ran. */
const yieldTask = () =>
	new Promise(resolve => {
		const channel = new MessageChannel()
		channel.port1.onmessage = resolve
		channel.port2.postMessage(0)
	})

const item = { id: 1, user: 'José', text: 'héllo wörld — ✓ ok' }
const big = Array.from({ length: 12000 }, (_, i) => ({ ...item, id: i }))

async function makeClient(variant) {
	if (variant !== 'clone') {
		const client = new Client({ url: URL_, worker: variant === 'worker' })
		await new Promise(resolve => client.on('connect', resolve))
		return { client, close: () => client.disconnect(true) }
	}
	const client = new WorkerClient(`${URL_}/angelia`)
	await client.ready
	return { client, close: () => client.close() }
}

const scenarios = {
	/** Many small emits in one tick, then wait for the server ack. */
	async 'send small (10000 × 1 msg)'(client) {
		const t0 = performance.now()
		for (let i = 0; i < 10000; i++) client.emit('m', item)
		const ack = client.emit('ack', 0, () => {})
		await yieldTask()
		const busy = performance.now() - t0
		await ack
		return { busy, total: performance.now() - t0 }
	},
	async 'send large (10 × 0.7 MB)'(client) {
		const t0 = performance.now()
		for (let i = 0; i < 10; i++) client.emit('m', big)
		const ack = client.emit('ack', 0, () => {})
		await yieldTask()
		const busy = performance.now() - t0
		await ack
		return { busy, total: performance.now() - t0 }
	},
	async 'receive small (10000 × 1 msg)'(client) {
		return receive(client, { count: 10000, big: false })
	},
	async 'receive large (10 × 0.7 MB)'(client) {
		return receive(client, { count: 10, big: true })
	},
	async 'round trip (200 sequential)'(client) {
		const times = []
		for (let i = 0; i < 200; i++) {
			const t = performance.now()
			await client.emit('ack', 0, () => {})
			times.push(performance.now() - t)
		}
		times.sort((a, b) => a - b)
		return { total: times[times.length >> 1] }
	},
}

/** Ask the server to push, and wait until `end` is dispatched here. */
async function receive(client, request) {
	const { promise, resolve } = Promise.withResolvers()
	client.onEnd = resolve
	const t0 = performance.now()
	client.emit('push', request)
	await promise
	return { total: performance.now() - t0 }
}

/**
 * Spin a macrotask loop and record gaps between its turns: any gap is
 * time the main thread spent on something else (parse, clone, send,
 * dispatch), wherever the browser runs it.
 */
function startProbe() {
	const channel = new MessageChannel()
	let last = performance.now()
	let blocked = 0
	let longest = 0
	let running = true
	channel.port1.onmessage = () => {
		const now = performance.now()
		const gap = now - last
		if (gap > 1) blocked += gap
		if (gap > longest) longest = gap
		last = now
		if (running) channel.port2.postMessage(0)
	}
	channel.port2.postMessage(0)
	return () => {
		running = false
		channel.port1.close()
		return { blocked, longest }
	}
}

window.runBench = async (variant, runs, warmup) => {
	const { client, close } = await makeClient(variant)
	client.on('end', () => client.onEnd())
	client.on('pushed', () => {})
	const results = {}
	for (const [name, scenario] of Object.entries(scenarios)) {
		const samples = []
		for (let r = 0; r < warmup + runs; r++) {
			const sample = await scenario(client)
			// Second pass under the probe; the probe's own load would skew `total`.
			const stop = startProbe()
			await scenario(client)
			await yieldTask()
			Object.assign(sample, stop())
			if (r >= warmup) samples.push(sample)
		}
		const median = key => {
			const v = samples.map(s => s[key]).filter(x => x !== undefined).sort((a, b) => a - b)
			return v.length ? v[v.length >> 1] : undefined
		}
		results[name] = {
			busy: median('busy'),
			blocked: median('blocked'),
			longest: median('longest'),
			total: median('total'),
		}
	}
	close()
	return results
}
window.benchReady = true
