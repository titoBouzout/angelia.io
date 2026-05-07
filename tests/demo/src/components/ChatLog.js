import { effect } from 'pota'
import { xml } from 'pota/xml'

import { messages, typers } from '../state.js'

const Line = m => xml`
	<div class="line ${m.kind}">
		<Show when="${m.from}">
			<span class="from">${m.from}</span>
		</Show>
		${m.text}
	</div>
`

const typingText = () => {
	const t = typers()
	if (!t.size) return ''
	return `${[...t].join(', ')} ${t.size === 1 ? 'is' : 'are'} typing…`
}

export const ChatLog = () => {
	let logEl

	// Auto-scroll the log to the bottom whenever a new message arrives.
	// The effect re-runs every time `messages` changes; the `if (logEl)`
	// guard covers the very first run, before the ref has fired.
	effect(() => {
		messages()
		if (logEl) logEl.scrollTop = logEl.scrollHeight
	})

	return xml`
		<div class="log" use:ref="${el => (logEl = el)}">
			<For each="${messages}">${Line}</For>
		</div>
		<div class="typing">${typingText}</div>
	`
}
