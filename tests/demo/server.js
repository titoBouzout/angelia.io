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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { dirname, join, normalize, sep } from 'node:path'
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

// PEM read only to compute the SHA-256 hash injected into the page —
// `Server.listen` itself takes the paths and re-reads from disk.
const cert = readFileSync(CERT_PATH, 'utf8')

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

/**
 * `Room` subclass — demonstrates extension and the lifecycle hooks
 * (`onCreate`, `onJoin`, `onLeave`, `onDelete`). Rooms named "lobby"
 * are flagged persistent so they stick around when empty.
 */
class DemoRoom extends Room {
	onCreate(socket) {
		if (this.id === 'lobby') this.persistent = true
		console.log(`  room created #${this.id}${this.persistent ? ' (persistent)' : ''}`)
	}
	onDelete() {
		console.log(`  room deleted #${this.id}`)
	}
}

const rooms = new Rooms(DemoRoom)

const enter = (socket, roomId) => {
	rooms.join(socket, roomId)
	socket.room = roomId
	const room = rooms.get(roomId)
	// `socket.emit` — server-initiated send to one socket.
	socket.emit('roster', {
		room: roomId,
		names: room.sockets.map(s => s.name),
	})
	// `room.broadcast` — fan-out to room members minus the sender.
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

/**
 * Chat: the connect/disconnect lifecycle plus everything that fans
 * out within a single room. Uses `room.emit` (everyone), `room.broadcast`
 * (everyone except sender), and the `reply` callback for delivery
 * acks.
 */
class Chat {
	connect(socket) {
		socket.name = socket.params.name || `anon-${socket.ip}`
		enter(socket, socket.params.room || 'main')
	}

	disconnect(socket) {
		console.log(`- ${socket.name} (#${socket.room})`)
		const room = rooms.get(socket.room)
		if (room) room.broadcast(socket, 'left', socket.name)
	}

	msg(socket, text, reply) {
		const room = rooms.get(socket.room)
		if (!room) return reply?.(0)
		room.emit('msg', { from: socket.name, text })
		reply?.(Date.now())
	}

	whisper(socket, text) {
		const room = rooms.get(socket.room)
		if (room)
			room.broadcast(socket, 'whisper', { from: socket.name, text })
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
			return reply?.(socket.room)
		exit(socket)
		enter(socket, newRoom)
		reply?.(newRoom)
	}
}

/**
 * Probes: smaller demos for transports and fan-out scope. `shout`
 * uses `Server.emit` (every socket on the server, regardless of
 * room); `big` and `pushme` exercise the http transport in both
 * directions.
 */
class Probes {
	shout(socket, text) {
		Server.emit('shout', { from: socket.name, text })
	}

	rtt(_socket, _data, reply) {
		reply?.(Date.now())
	}

	big(_socket, payload, reply) {
		reply?.(typeof payload === 'string' ? payload.length : 0)
	}

	pushme(socket) {
		const payload = 'X'.repeat(8 * 1024)
		socket.http('push', {
			ts: Date.now(),
			bytes: payload.length,
			payload,
		})
	}
}

/**
 * Admin: server-initiated disconnect plus an introspection endpoint.
 * `stats` snapshots `Server.*`, the requesting `socket.*`, and the
 * `Rooms` list (so the persistent `lobby` shows up there).
 */
class Admin {
	kick(socket) {
		socket.disconnect(false, 'kicked on request — auto-reconnecting')
	}

	stats(socket, _data, reply) {
		reply?.({
			server: {
				sockets: Server.sockets.length,
				served: Server.served,
				uptimeMs: Server.now - Server.since,
				bytesSent: Server.bytesSent,
				bytesReceived: Server.bytesReceived,
				messagesSent: Server.messagesSent,
				messagesReceived: Server.messagesReceived,
			},
			socket: {
				ip: socket.ip,
				userAgent: socket.userAgent,
				pingMs: socket.ping,
				bytesSent: socket.bytesSent,
				bytesReceived: socket.bytesReceived,
				messagesSent: socket.messagesSent,
				messagesReceived: socket.messagesReceived,
				rooms: socket.rooms.map(r => r.id),
			},
			rooms: rooms.list.map(r => ({
				id: r.id,
				sockets: r.sockets.length,
				persistent: r.persistent,
			})),
		})
	}
}

// `Server.on()` can be called multiple times — each registration adds
// its methods as event handlers. Splitting by concern keeps each
// listener class small and lets the file read top-to-bottom.
Server.on(Chat)
Server.on(Probes)
Server.on(Admin)

await Server.listen({
	port: 3001,
	cert: CERT_PATH,
	privKey: KEY_PATH,
	watch: true,
})

// ---------- Static page server ----------

const SRC_DIR = join(here, 'src')
const POTA_ROOT = join(root, 'node_modules/pota')
const CLIENT_PATH = join(root, 'client/index.js')
const HTML_PATH = join(here, 'index.html')

/**
 * Map a request URL to a file path under `roots`, refusing anything
 * that escapes the root via `..`. Returns null if no candidate exists.
 */
const resolveUnder = (root, urlPath) => {
	const resolved = normalize(join(root, urlPath))
	if (!resolved.startsWith(root + sep) && resolved !== root) return null
	return existsSync(resolved) && statSync(resolved).isFile()
		? resolved
		: null
}

const sendFile = (res, filePath, contentType) => {
	res.writeHead(200, { 'content-type': `${contentType}; charset=utf-8` })
	res.end(readFileSync(filePath))
}

const send404 = res => {
	res.writeHead(404, { 'content-type': 'text/plain' })
	res.end('not found')
}

const STATIC_PORT = 8000
createServer((req, res) => {
	const url = (req.url || '/').split('?')[0]

	// Page entry — re-read from disk each request so dev edits show up
	// without a server restart.
	if (url === '/' || url === '/index.html') {
		const html = readFileSync(HTML_PATH, 'utf8')
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end(html.replace('__CERT_HASH__', JSON.stringify(certHash)))
		return
	}

	// The angelia.io client lives at the repo root, not under tests/demo.
	if (url === '/client.js') {
		sendFile(res, CLIENT_PATH, 'application/javascript')
		return
	}

	// Pota's source tree, served straight out of node_modules so the
	// importmap can resolve `pota` and its many internal `./lib/...`
	// imports without a CDN or bundler.
	if (url.startsWith('/pota/')) {
		const path = resolveUnder(POTA_ROOT, url.slice('/pota/'.length))
		if (path) return sendFile(res, path, 'application/javascript')
		return send404(res)
	}

	// Everything else is browser source under tests/demo/src — modules,
	// components, etc.
	const path = resolveUnder(SRC_DIR, url)
	if (path) return sendFile(res, path, 'application/javascript')
	send404(res)
}).listen(STATIC_PORT, () => {
	console.log(`\nDemo page: http://localhost:${STATIC_PORT}\n`)
})
