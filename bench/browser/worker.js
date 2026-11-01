// Worker side of the old design: owns the WebSocket and does the JSON.
let ws

onmessage = ({ data: [type, payload] }) => {
	if (type === 'connect') {
		ws = new WebSocket(payload)
		ws.onopen = () => postMessage(['open'])
		ws.onmessage = e => {
			if (e.data === '') ws.send('')
			else postMessage(['messages', JSON.parse(e.data)])
		}
	} else if (type === 'send') {
		ws.send(JSON.stringify(payload))
	}
}
