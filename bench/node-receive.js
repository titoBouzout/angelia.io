/**
 * Server receive cost of `bufferutil` and `skipUTF8Validation`. Each
 * variant runs the server in its own process and reports that
 * process's CPU time for the receive phase.
 *
 *   node bench/node-receive.js
 */
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

import { WebSocket } from 'ws'

const SELF = fileURLToPath(import.meta.url)
const PORT = 17000
const RUNS = 5

const median = values => {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)]
}

/** Child: an angelia server that counts `m` and reports CPU on `done`. */
async function serve(skipUTF8Validation) {
	const { default: Server } = await import('../server/index.js')
	let start = process.cpuUsage()
	Server.on(
		class {
			begin(_socket, _data, reply) {
				start = process.cpuUsage()
				reply()
			}
			m() {}
			done(_socket, _data, reply) {
				const used = process.cpuUsage(start)
				reply((used.user + used.system) / 1000)
			}
		},
	)
	await Server.listen({ port: PORT, skipUTF8Validation })
	process.send?.('ready')
}

/** Parent: one connection, `frames` copies of `frame`, then ask for CPU. */
async function drive(frames, frame) {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/angelia`)
	await once(ws, 'open')
	let pending = null
	ws.on('message', raw => {
		const text = raw.toString()
		if (text === '') return
		pending?.(JSON.parse(text)[0][1][1][0])
	})
	const call = key =>
		new Promise(resolve => {
			pending = resolve
			ws.send(JSON.stringify([[key, 0, 1]]))
		})

	await call('begin')
	const t0 = performance.now()
	for (let i = 0; i < frames; i++) ws.send(frame)
	const cpuMs = await call('done')
	const wallMs = performance.now() - t0
	ws.close()
	return { cpuMs, wallMs }
}

async function variant(env, skip, frames, frame) {
	const cpu = []
	const wall = []
	for (let r = 0; r < RUNS; r++) {
		const child = fork(SELF, ['serve', String(skip)], {
			env: { ...process.env, ...env },
			stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
		})
		await once(child, 'message')
		const result = await drive(frames, frame)
		cpu.push(result.cpuMs)
		wall.push(result.wallMs)
		child.kill()
		await once(child, 'exit')
	}
	return { cpuMs: median(cpu), wallMs: median(wall) }
}

async function main() {
	// Non-ASCII text so UTF-8 validation has real work to do.
	const item = { id: 1, user: 'José', text: 'héllo wörld — ✓ ok' }
	const small = JSON.stringify([['m', item]])
	const big = JSON.stringify([
		['m', Array.from({ length: 12000 }, (_, i) => ({ ...item, id: i }))],
	])
	const workloads = [
		{ name: `small: 200000 × ${small.length} B`, frames: 200000, frame: small },
		{
			name: `large: 200 × ${(Buffer.byteLength(big) / 1e6).toFixed(1)} MB`,
			frames: 200,
			frame: big,
		},
	]
	const variants = [
		{ name: 'bufferutil + skip validation (new default)', env: {}, skip: true },
		{ name: 'bufferutil + validate', env: {}, skip: false },
		{ name: 'no bufferutil + skip validation', env: { WS_NO_BUFFER_UTIL: '1' }, skip: true },
		{ name: 'no bufferutil + validate', env: { WS_NO_BUFFER_UTIL: '1' }, skip: false },
	]

	console.log(`median of ${RUNS} runs, server process CPU / wall time\n`)
	for (const w of workloads) {
		console.log(w.name)
		for (const v of variants) {
			const r = await variant(v.env, v.skip, w.frames, w.frame)
			console.log(
				`  ${v.name.padEnd(44)} cpu ${r.cpuMs.toFixed(0).padStart(6)} ms   wall ${r.wallMs.toFixed(0).padStart(6)} ms`,
			)
		}
	}
}

if (process.argv[2] === 'serve') await serve(process.argv[3] === 'true')
else await main()
