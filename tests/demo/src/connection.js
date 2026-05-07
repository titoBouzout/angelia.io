/**
 * Owns the angelia.io Client instance and wires every server-side
 * event into the reactive state in `state.js`. The rest of the app
 * never touches event listeners directly — components read state,
 * actions call `client.*`.
 */
import Client from '/client.js'

import { name, initialRoom } from './identity.js'
import {
	room,
	setRoom,
	setStatus,
	setMessages,
	updateOnline,
	updateTypers,
	append,
} from './state.js'

// 127.0.0.1 (not `localhost`) — Chrome resolves localhost to IPv6 first
// and our server binds IPv4 (0.0.0.0), which yields ERR_CONNECTION_REFUSED.
// The cert covers 127.0.0.1 so pinning still works.
export const client = new Client({
	url: 'https://127.0.0.1:3001',
	params: { name, room: initialRoom },
	serverCertificateHashes: [
		{ algorithm: 'sha-256', value: new Uint8Array(window.__CERT_HASH) },
	],
})

/**
 * Switch the local view to room `id`: update the URL hash, clear the
 * log, and reset the roster to just the local user. Called from the
 * `roster` event below — the server replies with a `roster` whenever
 * a join/switch completes, so the UI follows the server, not the
 * other way around.
 */
const enterRoom = id => {
	setRoom(id)
	location.hash = id
	setMessages([])
	updateOnline(() => new Set([name]))
}

// ---------- connection lifecycle ----------

client.on('connect', () =>
	setStatus({ cls: 'connected', text: 'connected' }),
)
client.on('reconnect', () => {
	setStatus({ cls: 'connected', text: 'reconnected' })
	append('system', { text: '— reconnected —' })
})
client.on('disconnect', () =>
	setStatus({ cls: 'offline', text: 'offline' }),
)

// ---------- room + roster ----------

// `roster` is the authoritative join-completion signal: it arrives both
// on first connect and on every successful `switch`.
client.on('roster', ({ room: r, names }) => {
	enterRoom(r)
	updateOnline(() => new Set([...names, name]))
	append('system', { text: `joined #${r}` })
})
client.on('joined', n => {
	updateOnline(prev => new Set([...prev, n]))
	append('system', { text: `${n} joined` })
})
client.on('left', n => {
	updateOnline(prev => {
		const next = new Set(prev)
		next.delete(n)
		return next
	})
	append('system', { text: `${n} left` })
})

// ---------- chat events ----------

client.on('msg', ({ from, text }) =>
	append('msg', { from: `${from}:`, text }),
)
client.on('whisper', ({ from, text }) =>
	append('whisper', { from: `${from} whispers:`, text }),
)
client.on('shout', ({ from, text }) =>
	append('shout', { from: `${from} shouts:`, text }),
)

// `socket.http` from the server lands here — a payload pushed on a
// fresh unidi stream (separate from the heartbeat / control stream).
client.on('push', ({ ts, bytes }) =>
	append('system', {
		text: `server pushed ${bytes.toLocaleString()} bytes via http (lag ${Date.now() - ts}ms)`,
	}),
)

client.on('typing', ({ from, on }) =>
	updateTypers(prev => {
		const next = new Set(prev)
		on ? next.add(from) : next.delete(from)
		return next
	}),
)

// ---------- url <-> room sync ----------

window.addEventListener('hashchange', () => {
	const target = location.hash.replace(/^#/, '').toLowerCase()
	if (target && target !== room()) client.emit('switch', target)
})
