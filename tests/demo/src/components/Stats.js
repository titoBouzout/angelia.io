import { xml } from 'pota/xml'

import { stats } from '../state.js'
import { fetchStats } from '../actions.js'

const formatBytes = n => {
	if (n < 1024) return `${n} B`
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
	return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const formatMs = n => {
	if (n < 1000) return `${n} ms`
	if (n < 60_000) return `${(n / 1000).toFixed(1)} s`
	return `${(n / 60_000).toFixed(1)} min`
}

const RoomLine = r => xml`
	<li>
		#${r.id} — ${r.sockets} ${r.sockets === 1 ? 'socket' : 'sockets'}
		<Show when="${r.persistent}">
			<span class="tag">persistent</span>
		</Show>
	</li>
`

export const Stats = () => xml`
	<h2>stats</h2>
	<div class="actions">
		<button class="secondary" on:click="${fetchStats}">
			refresh stats
		</button>
	</div>
	<Show when="${stats}">
		<div class="stats-grid">
			<section>
				<h3>server</h3>
				<dl>
					<dt>connected sockets</dt>
					<dd>${() => stats().server.sockets}</dd>
					<dt>served (since boot)</dt>
					<dd>${() => stats().server.served}</dd>
					<dt>uptime</dt>
					<dd>${() => formatMs(stats().server.uptimeMs)}</dd>
					<dt>bytes sent</dt>
					<dd>${() => formatBytes(stats().server.bytesSent)}</dd>
					<dt>bytes received</dt>
					<dd>${() => formatBytes(stats().server.bytesReceived)}</dd>
					<dt>messages sent</dt>
					<dd>${() => stats().server.messagesSent}</dd>
					<dt>messages received</dt>
					<dd>${() => stats().server.messagesReceived}</dd>
				</dl>
			</section>
			<section>
				<h3>your socket</h3>
				<dl>
					<dt>ip</dt>
					<dd>${() => stats().socket.ip}</dd>
					<dt>user agent</dt>
					<dd class="ua">${() => stats().socket.userAgent}</dd>
					<dt>bytes sent</dt>
					<dd>${() => formatBytes(stats().socket.bytesSent)}</dd>
					<dt>bytes received</dt>
					<dd>${() => formatBytes(stats().socket.bytesReceived)}</dd>
					<dt>messages sent</dt>
					<dd>${() => stats().socket.messagesSent}</dd>
					<dt>messages received</dt>
					<dd>${() => stats().socket.messagesReceived}</dd>
					<dt>rooms</dt>
					<dd>${() => stats().socket.rooms.join(', ')}</dd>
				</dl>
			</section>
			<section>
				<h3>active rooms</h3>
				<ul class="room-list">
					<For each="${() => stats().rooms}">${RoomLine}</For>
				</ul>
			</section>
		</div>
	</Show>
`
