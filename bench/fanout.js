/**
 * Server fan-out cost: one frame built per batch and written per socket
 * through ws's `_sender.sendFrame` (the server's code), vs `ws.send()`
 * re-framing per socket, vs raw cork/write/uncork on the TCP socket
 * (the pre-WebTransport code). Server runs in its own process; clients in
 * another.
 *
 *   node bench/fanout.js
 */
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

import { WebSocket } from 'ws'

const SELF = fileURLToPath(import.meta.url)
const PORT = 17200
const SOCKETS = 1000
const RUNS = 5

const median = values => {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)]
}

/** Swap `Socket.write` for the variant under test; `sendFrame` is the real one. */
function install(Socket, variant) {
	if (variant === 'sendFrame') return
	Socket.prototype.write = function (chunks) {
		if (this.io.readyState !== WebSocket.OPEN) return
		if (variant === 'send') {
			// What `ws.send()` gets: the payload, framed again per socket.
			this.io.send(chunks.length > 1 ? chunks[1] : '', { binary: false })
		} else {
			const tcp = this.io._socket
			tcp.cork()
			for (const chunk of chunks) tcp.write(chunk)
			tcp.uncork()
		}
	}
}

/** Child: the server. On `go`, broadcasts and reports its CPU time. */
async function serve(variant) {
	const { default: Server } = await import('../server/index.js')
	const { Socket } = await import('../server/Socket.js')
	install(Socket, variant)
	await Server.listen({ port: PORT })
	process.on('message', async ({ broadcasts, payload }) => {
		const start = process.cpuUsage()
		const t0 = performance.now()
		for (let i = 0; i < broadcasts; i++) {
			Server.emit('m', payload)
			// One batch per broadcast: let the next-tick drain run.
			await new Promise(setImmediate)
		}
		const used = process.cpuUsage(start)
		process.send?.({
			cpuMs: (used.user + used.system) / 1000,
			loopMs: performance.now() - t0,
		})
	})
	process.send?.('ready')
}

/** Child: SOCKETS clients that report once every message arrived. */
async function clients() {
	let expected = 0
	let received = 0
	const sockets = []
	for (let i = 0; i < SOCKETS; i++) {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/angelia`)
		ws.on('message', raw => {
			if (raw.length === 0) return
			if (++received === expected) process.send?.('done')
		})
		sockets.push(once(ws, 'open'))
	}
	await Promise.all(sockets)
	process.on('message', ({ total }) => {
		expected = total
		received = 0
	})
	process.send?.('ready')
}

const spawn = (...args) =>
	fork(SELF, args, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })

async function run(variant, broadcasts, payload) {
	const server = spawn('serve', variant)
	await once(server, 'message')
	const client = spawn('clients')
	await once(client, 'message')
	// Let the connect-time pings settle.
	await new Promise(r => setTimeout(r, 400))

	client.send({ total: broadcasts * SOCKETS })
	const delivered = once(client, 'message')
	const t0 = performance.now()
	server.send({ broadcasts, payload })
	const [{ cpuMs }] = await once(server, 'message')
	await delivered
	const wallMs = performance.now() - t0

	client.kill()
	server.kill()
	await Promise.all([once(client, 'exit'), once(server, 'exit')])
	return { cpuMs, wallMs }
}

async function main() {
	const item = { id: 1, user: 'José', text: 'héllo wörld — ✓ ok' }
	const workloads = [
		{ name: `small: 1000 broadcasts × ${SOCKETS} sockets`, broadcasts: 1000, payload: item },
		{
			name: `large: 20 broadcasts × ${SOCKETS} sockets × 16 KB`,
			broadcasts: 20,
			payload: Array.from({ length: 280 }, (_, i) => ({ ...item, id: i })),
		},
	]
	const variants = [
		['sendFrame', 'pre-framed, _sender.sendFrame (current)'],
		['send', 'ws.send(payload) per socket'],
		['raw', 'pre-framed, raw cork/write (old code)'],
	]
	console.log(`median (min–max) of ${RUNS} runs; server CPU while broadcasting / wall until all delivered\n`)
	for (const w of workloads) {
		console.log(w.name)
		for (const [variant, label] of variants) {
			const cpu = []
			const wall = []
			for (let r = 0; r < RUNS; r++) {
				const result = await run(variant, w.broadcasts, w.payload)
				cpu.push(result.cpuMs)
				wall.push(result.wallMs)
			}
			const spread = v => `${Math.min(...v).toFixed(0)}–${Math.max(...v).toFixed(0)}`
			console.log(
				`  ${label.padEnd(40)} cpu ${median(cpu).toFixed(0).padStart(6)} ms (${spread(cpu)})   wall ${median(wall).toFixed(0).padStart(6)} ms`,
			)
		}
	}
}

if (process.argv[2] === 'serve') await serve(process.argv[3])
else if (process.argv[2] === 'clients') await clients()
else await main()
