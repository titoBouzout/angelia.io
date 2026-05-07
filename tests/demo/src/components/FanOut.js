import { xml } from 'pota/xml'

import { measureRtt, shout, sendBig, askPushMe } from '../actions.js'

export const FanOut = () => xml`
	<h2>fan-out + transports</h2>
	<div class="actions">
		<button class="secondary" on:click="${measureRtt}">
			measure RTT (emit + reply)
		</button>
		<button class="secondary" on:click="${shout}">
			shout to everyone (Server.emit)
		</button>
		<button class="secondary" on:click="${sendBig}">
			send 64KB via http
		</button>
		<button class="secondary" on:click="${askPushMe}">
			ask server to push (socket.http)
		</button>
	</div>
`
