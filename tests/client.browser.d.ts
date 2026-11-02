// Globals the browser test page (`PAGE` in client.browser.test.js) and
// the tests themselves define on `window`.
type TestClient = import('../client/index.js').default

interface Window {
	Client: typeof import('../client/index.js').default
	client: TestClient
	make(url: string, options?: Partial<import('../client/index.js').ClientOptions>): void
	log: string[]
	mainThreadSockets: number
	busy(ms: number): void
	// Set by individual tests.
	restored: boolean
	talking: ReturnType<typeof setInterval>
	workerPrelude: string
	off: (() => void) | undefined
	controller: AbortController
	pending: Promise<string>
	replied: Promise<unknown>
	calls: number
	second: TestClient
	a: TestClient
	b: TestClient
}
