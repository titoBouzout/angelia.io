import { xml } from 'pota/xml'

import { client } from '../connection.js'
import { sendMessage, sendHttp, whisper } from '../actions.js'

export const ChatForm = () => {
	let input
	let typingTimeout

	const stopTyping = () => {
		clearTimeout(typingTimeout)
		client.emit('typing', false)
	}

	const onInput = () => {
		client.emit('typing', true)
		clearTimeout(typingTimeout)
		typingTimeout = setTimeout(() => client.emit('typing', false), 1500)
	}

	const consume = () => {
		const v = input.value.trim()
		input.value = ''
		stopTyping()
		return v
	}

	const onSend = e => {
		e.preventDefault()
		sendMessage(consume())
	}

	return xml`
		<form autocomplete="off" on:submit="${onSend}">
			<input
				use:ref="${el => ((input = el), el.focus())}"
				type="text"
				placeholder="say something…"
				on:input="${onInput}"
			/>
			<button type="submit">send</button>
			<button
				type="button"
				class="secondary"
				on:click="${() => sendHttp(consume())}"
			>via http</button>
			<button
				type="button"
				class="secondary"
				on:click="${() => whisper(consume())}"
			>whisper</button>
		</form>
	`
}
