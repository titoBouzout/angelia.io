/**
 * Reactive state. Every value here is a pota signal — components read
 * the accessor (`status`, `room`, …) reactively, and `connection.js`
 * is the only place that writes to them.
 */
import { signal } from 'pota'

import { name } from './identity.js'

export const [status, setStatus] = signal({
	cls: '',
	text: 'connecting…',
})
export const [rtt, setRtt] = signal(/** @type {number | null} */ (null))
export const [room, setRoom] = signal('')
export const [online, , updateOnline] = signal(new Set([name]))
export const [messages, setMessages, updateMessages] = signal(
	/** @type {{ id: number; kind: string; from?: string; text: string }[]} */ (
		[]
	),
)
export const [typers, , updateTypers] = signal(new Set())
export const [hardDisconnected, setHardDisconnected] = signal(false)
export const [stats, setStats] = signal(/** @type {any} */ (null))

let nextMsgId = 0

export const append = (kind, fields = {}) =>
	updateMessages(arr => [...arr, { id: nextMsgId++, kind, ...fields }])
