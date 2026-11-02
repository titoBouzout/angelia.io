/**
 * User-triggered actions. Each function captures the wire-protocol
 * pattern for one demo button — the components just call these.
 */
import { client } from './connection.js'
import { name } from './identity.js'
import {
	append,
	setRtt,
	setHardDisconnected,
	setStats,
} from './state.js'

const ts = t => new Date(t).toLocaleTimeString()

// ---------- chat ----------

/** `client.request` — emit and await the reply. */
export const sendMessage = async text => {
	if (!text) return
	const at = await client.request('msg', text)
	append('ack', { text: `delivered ${ts(at)}` })
}

/**
 * `client.emit` → server uses `room.broadcast` so others see it but
 * the sender doesn't. We render the local echo line ourselves.
 */
export const whisper = text => {
	if (!text) return
	client.emit('whisper', text)
	append('whisper', { from: 'you whisper:', text })
}

// ---------- fan-out ----------

/** `client.request` — measure round-trip from click to reply. */
export const measureRtt = async () => {
	const sent = Date.now()
	await client.request('rtt')
	setRtt(Date.now() - sent)
}

/** `client.emit` → server uses `Server.emit` so every socket sees it. */
export const shout = () => {
	client.emit('shout', `hello from ${name}`)
}

/** `client.request` with a 64KB payload; server replies with byte count. */
export const sendBig = async () => {
	const payload = 'X'.repeat(64 * 1024)
	const len = await client.request('big', payload)
	append('ack', {
		text: `server confirmed ${len.toLocaleString()} bytes`,
	})
}

/** `client.emit` → server pushes a large payload via `socket.emit`. */
export const askPushMe = () => client.emit('pushme')

// ---------- rooms ----------

/**
 * Server replies with the room it actually joined; the `roster`
 * event arrives independently and drives the UI update.
 */
export const switchRoom = async target => {
	if (!target) return
	await client.request('switch', target)
}

// ---------- introspection ----------

/**
 * `client.request` — server returns a snapshot of its own stats,
 * the requesting socket's stats, and the active room list.
 */
export const fetchStats = async () => {
	const data = await client.request('stats')
	setStats(data)
}

// ---------- connection control ----------

/** Soft client-side disconnect — the client reconnects on its own. */
export const softDisconnect = () => {
	client.disconnect()
	append('system', { text: 'disconnected — reconnecting' })
}

/** Server-initiated soft disconnect — client auto-reconnects. */
export const serverKick = () => {
	client.emit('kick')
	append('system', { text: 'asked server to close our connection' })
}

/**
 * Hard disconnect — disables auto-reconnect. The page exposes a
 * "reload" button to recreate the Client.
 */
export const hardDisconnect = () => {
	client.disconnect(true, 'goodbye')
	setHardDisconnected(true)
	append('system', {
		text: 'hard-disconnected — reload the page to reconnect',
	})
}
