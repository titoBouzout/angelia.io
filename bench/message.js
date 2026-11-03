/**
 * One-socket sends of the same payload, one tick each, as pages arriving
 * somewhere get a list: `socket.emit` per socket vs one `Message`. Server
 * runs in its own process; clients in another.
 *
 *   node bench/message.js
 */
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

import { WebSocket } from 'ws'

const SELF = fileURLToPath(import.meta.url)
const PORT = 17201
const SOCKETS = 1000
const RUNS = 5
const ROUNDS = 20

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

/** Child: the server. On `go`, sends to each socket in its own tick and reports its CPU time. */
async function serve(variant) {
	const { default: Server, Message } = await import('../server/index.js')
	await Server.listen({ port: PORT })
	process.on('message', async ({ payload }) => {
		const message = new Message('m', payload)
		const start = process.cpuUsage()
		for (let round = 0; round < ROUNDS; round++) {
			for (const socket of Server.sockets) {
				if (variant === 'message') socket.send(message)
				else socket.emit('m', payload)
				await new Promise(setImmediate)
			}
		}
		const used = process.cpuUsage(start)
		process.send?.({ cpuMs: (used.user + used.system) / 1000 })
	})
	process.send?.('ready')
}

/** Child: SOCKETS clients that report once every message arrived. */
async function clients() {
	let received = 0
	const opened = []
	for (let i = 0; i < SOCKETS; i++) {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/angelia`)
		ws.on('message', raw => {
			if (raw.length && ++received === SOCKETS * ROUNDS) process.send?.('done')
		})
		opened.push(once(ws, 'open'))
	}
	await Promise.all(opened)
	process.send?.('ready')
}

const spawn = (...args) => fork(SELF, args, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })

async function run(variant, payload) {
	const server = spawn('serve', variant)
	await once(server, 'message')
	const client = spawn('clients')
	await once(client, 'message')
	const delivered = once(client, 'message')
	server.send({ payload })
	const [{ cpuMs }] = await once(server, 'message')
	await delivered
	client.kill()
	server.kill()
	await Promise.all([once(client, 'exit'), once(server, 'exit')])
	return cpuMs
}

async function main() {
	const room = i => [`pool-${i}`, 'A room name', 'pool', [['someone', 'image.png', 0, ''], ['another', false, 1, '']], { u: 'someone', i: 'image.png' }, 0]
	const workloads = [
		['small: 3 sharers', [{ u: 'someone' }, { u: 'another' }, { u: 'third' }]],
		['rooms: 30 rooms', Array.from({ length: 30 }, (_, i) => room(i))],
		['rooms: 200 rooms', Array.from({ length: 200 }, (_, i) => room(i))],
	]
	console.log(`median of ${RUNS} runs; server CPU for ${SOCKETS * ROUNDS} one-socket sends\n`)
	for (const [name, payload] of workloads) {
		console.log(`${name}, ${JSON.stringify(payload).length} bytes`)
		for (const variant of ['emit', 'message']) {
			const cpu = []
			for (let r = 0; r < RUNS; r++) cpu.push(await run(variant, payload))
			console.log(`  ${variant.padEnd(8)} ${median(cpu).toFixed(0).padStart(6)} ms`)
		}
	}
}

if (process.argv[2] === 'serve') await serve(process.argv[3])
else if (process.argv[2] === 'clients') await clients()
else await main()
