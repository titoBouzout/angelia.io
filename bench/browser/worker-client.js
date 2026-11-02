// The pre-WebTransport worker design, for comparison: objects cross
// postMessage and the worker does the JSON.
import { BenchClient } from './bench-client.js'

export class WorkerClient extends BenchClient {
	#worker

	constructor(url) {
		const worker = new Worker(new URL('./worker.js', import.meta.url))
		super(batch => worker.postMessage(['send', batch]))
		this.#worker = worker
		const { promise, resolve } = Promise.withResolvers()
		this.ready = promise
		worker.onmessage = e => {
			const [type, payload] = e.data
			if (type === 'open') resolve(undefined)
			else this.receive(payload)
		}
		worker.postMessage(['connect', url])
	}

	close() {
		this.#worker.terminate()
	}
}
