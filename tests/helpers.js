import { createServer } from 'node:net'

import { Server } from '../server/Server.js'
import { DEFAULT_PATH } from '../shared/protocol.js'

export { Server }

/** Poll `predicate` (sync or async) every 25ms until it holds. */
export async function waitFor(predicate, tries = 80) {
	for (let i = 0; i < tries; i++) {
		if (await predicate()) return true
		await new Promise(r => setTimeout(r, 25))
	}
	return predicate()
}

/** A port nothing listens on, for tests that start a server later. */
export async function freePort() {
	const probe = createServer()
	await new Promise(resolve =>
		probe.listen(0, '127.0.0.1', () => resolve(undefined)),
	)
	const address = probe.address()
	await new Promise(resolve => probe.close(() => resolve(undefined)))
	if (!address || typeof address !== 'object') {
		throw new Error('no port assigned')
	}
	return address.port
}

/**
 * Listen a fresh Server on an OS-assigned port.
 *
 * @param {import('../server/Server.js').ServerListenOptions} [options]
 * @param {(server: Server) => void} [configure] What to set before it listens
 */
export async function bootServer(options = {}, configure = _server => {}) {
	const server = new Server()
	configure(server)
	await server.listen({ port: 0, ...options })
	const baseUrl = `ws://127.0.0.1:${server.port}`
	return {
		server,
		port: server.port,
		baseUrl,
		url: `${baseUrl}${DEFAULT_PATH}`,
		stop: () => server.stop(),
	}
}
