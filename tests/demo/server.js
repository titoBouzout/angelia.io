/**
 * angelia.io demo — boots a real WebTransport server and a tiny HTTP
 * server that hosts the demo page. Run with:
 *
 *   node tests/demo/server.js
 *
 * Then open http://localhost:8000 in a WebTransport-capable browser
 * (Chrome/Edge). The page talks to the WebTransport server on
 * https://localhost:3001 using the self-signed cert pinned by SHA-256.
 *
 * Requires `certs/cert.pem` + `certs/key.pem` (run `npm run gen-cert`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Server, { Room, Rooms } from '../../server/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

const CERT_PATH = join(root, 'certs/cert.pem')
const KEY_PATH = join(root, 'certs/key.pem')
if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
	console.error(
		`Missing ${CERT_PATH} / ${KEY_PATH}. Run \`npm run gen-cert\` first.`,
	)
	process.exit(1)
}

const cert = readFileSync(CERT_PATH, 'utf8')
const privKey = readFileSync(KEY_PATH, 'utf8')

const certHash = [
	...createHash('sha256')
		.update(
			Buffer.from(
				cert.replace(/-----[^-]+-----|\s+/g, ''),
				'base64',
			),
		)
		.digest(),
]

// ---------- WebTransport (angelia.io) server ----------

const rooms = new Rooms(Room)

const enter = (socket, roomId) => {
	rooms.join(socket, roomId)
	socket.room = roomId
	const room = rooms.get(roomId)
	socket.emit('roster', {
		room: roomId,
		names: room.sockets.map(s => s.name),
	})
	room.broadcast(socket, 'joined', socket.name)
	console.log(`+ ${socket.name} → #${roomId} (${room.sockets.length})`)
}

const exit = socket => {
	const room = rooms.get(socket.room)
	if (room) {
		room.broadcast(socket, 'left', socket.name)
		rooms.leave(socket, socket.room)
	}
}

class Demo {
	connect(socket) {
		socket.name = socket.params.name || `anon-${socket.ip}`
		enter(socket, socket.params.room || 'main')
	}

	disconnect(socket) {
		console.log(`- ${socket.name} (#${socket.room})`)
		// Room cleanup is automatic via socket.onclose; we only need to
		// notify the remaining members.
		const room = rooms.get(socket.room)
		if (room) room.broadcast(socket, 'left', socket.name)
	}

	msg(socket, text, reply) {
		const room = rooms.get(socket.room)
		if (!room) return reply && reply(0)
		console.log(`  #${socket.room} ${socket.name}: ${text}`)
		room.emit('msg', { from: socket.name, text })
		reply && reply(Date.now())
	}

	typing(socket, on) {
		const room = rooms.get(socket.room)
		if (room)
			room.broadcast(socket, 'typing', { from: socket.name, on })
	}

	switch(socket, newRoom, reply) {
		newRoom = String(newRoom || '')
			.trim()
			.toLowerCase()
		if (!newRoom || newRoom === socket.room)
			return reply && reply(socket.room)
		exit(socket)
		enter(socket, newRoom)
		reply && reply(newRoom)
	}
}
Server.on(Demo)

await Server.listen({ port: 3001, cert, privKey })

// ---------- Static page server ----------

const PAGE = readFileSync(join(here, 'index.html'), 'utf8')
const DEMO_JS = readFileSync(join(here, 'demo.js'), 'utf8')
const CLIENT_JS = readFileSync(join(root, 'client/index.js'), 'utf8')

const STATIC_PORT = 8000
createServer((req, res) => {
	const url = req.url || '/'
	if (url === '/' || url === '/index.html') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end(PAGE.replace('__CERT_HASH__', JSON.stringify(certHash)))
		return
	}
	if (url === '/demo.js') {
		res.writeHead(200, {
			'content-type': 'application/javascript; charset=utf-8',
		})
		res.end(DEMO_JS)
		return
	}
	if (url === '/client.js') {
		res.writeHead(200, {
			'content-type': 'application/javascript; charset=utf-8',
		})
		res.end(CLIENT_JS)
		return
	}
	res.writeHead(404, { 'content-type': 'text/plain' })
	res.end('not found')
}).listen(STATIC_PORT, () => {
	console.log(`\nDemo page: http://localhost:${STATIC_PORT}\n`)
})
