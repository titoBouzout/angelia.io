import { xml } from 'pota/xml'

import { name } from '../identity.js'
import { status, rtt } from '../state.js'

export const Header = () => xml`
	<h1>angelia.io demo</h1>
	<div class="sub">
		<span class="status ${() => status().cls}">${() => status().text}</span>
		<Show when="${() => rtt() != null}">
			<span class="rtt">RTT ${rtt}ms</span>
		</Show>
		<span>•</span>
		<span>you are <strong>${name}</strong></span>
	</div>
`
