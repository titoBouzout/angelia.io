import Client from '/client.js'

const $ = id => document.getElementById(id)
const log = $('log')
const typing = $('typing')
const status = $('status')
const roster = $('roster')
const form = $('form')
const input = $('input')
const roomLabel = $('room-label')
const roomForm = $('room-form')
const roomInput = $('room-input')

// Pick a name once per tab so reload preserves identity.
let name = sessionStorage.getItem('demo-name')
if (!name) {
	name = 'guest-' + Math.random().toString(36).slice(2, 6)
	sessionStorage.setItem('demo-name', name)
}

// Room follows the URL hash so different tabs can be in different rooms
// just by editing the hash. Default 'main'.
const initialRoom = (location.hash.replace(/^#/, '') || 'main').toLowerCase()

const append = (cls, html) => {
	const el = document.createElement('div')
	el.className = 'line ' + cls
	el.innerHTML = html
	log.appendChild(el)
	log.scrollTop = log.scrollHeight
}
const escape = s =>
	String(s).replace(
		/[&<>"']/g,
		c =>
			({
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&#39;',
			})[c],
	)

const setStatus = (cls, text) => {
	status.className = cls
	status.textContent = text
}

// ---------- the actual angelia.io client ----------

// 127.0.0.1 (not `localhost`) — Chrome resolves localhost to IPv6 first
// and our server binds IPv4 (0.0.0.0), which yields ERR_CONNECTION_REFUSED.
// The cert covers 127.0.0.1 so pinning still works.
const client = new Client({
	url: 'https://127.0.0.1:3001',
	params: { name, room: initialRoom },
	serverCertificateHashes: [
		{ algorithm: 'sha-256', value: new Uint8Array(window.__CERT_HASH) },
	],
})

client.on('connect', () => setStatus('connected', 'connected'))
client.on('reconnect', () => setStatus('connected', 'reconnected'))
client.on('disconnect', () =>
	setStatus('offline', 'offline — reconnecting…'),
)

let currentRoom = initialRoom
const online = new Set()
const renderRoster = () =>
	(roster.textContent = online.size ? [...online].join(', ') : '—')

const setRoom = id => {
	currentRoom = id
	roomLabel.textContent = '#' + id
	location.hash = id
	log.innerHTML = ''
	online.clear()
	online.add(name)
	renderRoster()
}
setRoom(initialRoom)

// `roster` is the authoritative join-completion signal: it arrives both
// on first connect and on every successful `switch`.
client.on('roster', ({ room, names }) => {
	setRoom(room)
	for (const n of names) online.add(n)
	renderRoster()
	append('system', `joined #${room}`)
})
client.on('joined', n => {
	online.add(n)
	renderRoster()
	append('system', `${escape(n)} joined`)
})
client.on('left', n => {
	online.delete(n)
	renderRoster()
	append('system', `${escape(n)} left`)
})
client.on('msg', ({ from, text }) =>
	append('', `<span class="from">${escape(from)}:</span>${escape(text)}`),
)

let typingTimeout
const typers = new Set()
client.on('typing', ({ from, on }) => {
	if (on) typers.add(from)
	else typers.delete(from)
	typing.textContent = typers.size
		? `${[...typers].join(', ')} ${typers.size === 1 ? 'is' : 'are'} typing…`
		: ''
})

input.addEventListener('input', () => {
	client.emit('typing', true)
	clearTimeout(typingTimeout)
	typingTimeout = setTimeout(() => client.emit('typing', false), 1500)
})

form.addEventListener('submit', async e => {
	e.preventDefault()
	const v = input.value.trim()
	if (!v) return
	input.value = ''
	clearTimeout(typingTimeout)
	client.emit('typing', false)

	// Round-trip ack via reply callback.
	const t = await client.emit('msg', v, ts => ts)
	append('ack', `delivered ${new Date(t).toLocaleTimeString()}`)
})

roomForm.addEventListener('submit', async e => {
	e.preventDefault()
	const target = roomInput.value.trim().toLowerCase()
	if (!target || target === currentRoom) return
	roomInput.value = ''
	// Server replies with the room it actually joined; the `roster`
	// event also arrives independently and drives the UI update.
	await client.emit('switch', target, room => room)
})

// Manual hash edit also switches rooms (e.g. paste #other-room).
window.addEventListener('hashchange', () => {
	const target = location.hash.replace(/^#/, '').toLowerCase()
	if (target && target !== currentRoom) {
		client.emit('switch', target)
	}
})
