import { xml } from 'pota/xml'

import { room } from '../state.js'
import { switchRoom } from '../actions.js'

export const RoomBar = () => {
	let input

	const onSubmit = async e => {
		e.preventDefault()
		const target = input.value.trim().toLowerCase()
		if (!target || target === room()) return
		input.value = ''
		await switchRoom(target)
	}

	return xml`
		<form class="room-bar" autocomplete="off" on:submit="${onSubmit}">
			<span class="label">room:</span>
			<strong>#${room}</strong>
			<input
				use:ref="${el => (input = el)}"
				type="text"
				placeholder="switch room…"
			/>
			<button type="submit" class="secondary">switch</button>
		</form>
	`
}
