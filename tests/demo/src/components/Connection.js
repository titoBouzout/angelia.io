import { xml } from 'pota/xml'

import { hardDisconnected } from '../state.js'
import {
	softDisconnect,
	serverKick,
	hardDisconnect,
} from '../actions.js'

export const Connection = () => xml`
	<h2>connection</h2>
	<div class="actions">
		<button class="secondary" on:click="${softDisconnect}">
			disconnect (auto-reconnects)
		</button>
		<button class="secondary" on:click="${serverKick}">
			server-side disconnect
		</button>
		<button class="secondary" on:click="${hardDisconnect}">
			hard disconnect (no reconnect)
		</button>
		<Show when="${hardDisconnected}">
			<button
				class="secondary"
				on:click="${() => location.reload()}"
			>reload page</button>
		</Show>
	</div>
`
