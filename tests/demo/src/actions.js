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

/** `client.emit` + reply on the control stream. */
export const sendMessage = async text => {
	if (!text) return
	const at = await client.emit('msg', text, t => t)
	append('ack', { text: `delivered (control) ${ts(at)}` })
}

/** `client.http` + reply on a fresh unidi stream. */
export const sendHttp = async text => {
	if (!text) return
	const at = await client.http('msg', text, t => t)
	append('ack', { text: `delivered (http) ${ts(at)}` })
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

// ---------- fan-out + transports ----------

/** `client.emit` + reply — measure round-trip from click to reply. */
export const measureRtt = async () => {
	const sent = Date.now()
	await client.emit('rtt', null, t => t)
	setRtt(Date.now() - sent)
}

/** `client.emit` → server uses `Server.emit` so every socket sees it. */
export const shout = () => {
	client.emit('shout', `hello from ${name}`)
}

/** `client.http` with a 64KB payload; server replies with byte count. */
export const sendBig = async () => {
	const payload = 'X'.repeat(64 * 1024)
	const len = await client.http('big', payload, n => n)
	append('ack', {
		text: `server confirmed ${len.toLocaleString()} bytes via http`,
	})
}

/** `client.emit` → server replies via `socket.http` on a fresh stream. */
export const askPushMe = () => client.emit('pushme')

// ---------- rooms ----------

/**
 * Server replies with the room it actually joined; the `roster`
 * event arrives independently and drives the UI update.
 */
export const switchRoom = async target => {
	if (!target) return
	await client.emit('switch', target, r => r)
}

// ---------- introspection ----------

/**
 * `client.emit` + reply — server returns a snapshot of its own stats,
 * the requesting socket's stats, and the active room list.
 */
export const fetchStats = async () => {
	const data = await client.emit('stats', null, s => s)
	setStats(data)
}

// ---------- connection control ----------

/** Soft client-side disconnect — auto-reconnect kicks in after 2-4s. */
export const softDisconnect = () => {
	client.disconnect()
	append('system', { text: 'disconnected — auto-reconnect in ~3s' })
}

/** Server-initiated soft disconnect — client auto-reconnects. */
export const serverKick = () => {
	client.emit('kick')
	append('system', { text: 'asked server to close our session' })
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
