// Globals the browser test page (`PAGE` in client.browser.test.js) defines.
interface Window {
	Client: typeof import('../client/index.js').default
	client: import('../client/index.js').default
	make(url: string, options?: Partial<import('../client/index.js').ClientOptions>): void
	events: string[]
	mainThreadSockets: number
	busy(ms: number): void
}
