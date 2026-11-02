// A client that keeps its WebSocket on the main thread, for comparison
// with the library's worker client.
import { BenchClient } from './bench-client.js'

export class MainClient extends BenchClient {
	#ws

	constructor(url) {
		const ws = new WebSocket(url)
		super(batch => ws.send(JSON.stringify(batch)))
		this.#ws = ws
		const { promise, resolve } = Promise.withResolvers()
		this.ready = promise
		ws.onopen = () => resolve(undefined)
		ws.onmessage = e =>
			e.data === '' ? ws.send('') : this.receive(JSON.parse(e.data))
	}

	close() {
		this.#ws.close()
	}
}
