import { xml } from 'pota/xml'

import { name, online } from '../state.js'

// Pin the local user to the front of the list so "you" is easy to spot.
const rosterText = () =>
	[...online()]
		.sort((a, b) => (a === name ? -1 : b === name ? 1 : 0))
		.join(', ')

export const Roster = () => xml`
	<div class="roster">in this room: <span>${rosterText}</span></div>
`
