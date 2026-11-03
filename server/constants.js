export const parent = Symbol('parent')
// A wire tuple's JSON, and its frame as a batch of one.
export const encoded = Symbol('encoded')
export const framed = Symbol('framed')

// Server events fired by the library itself; clients can't trigger them.
export const LIFECYCLE_EVENTS = new Set([
	'listen',
	'connect',
	'disconnect',
	'timeout',
	'garbage',
	'incoming',
	'outgoing',
])

// Server defaults
export const DEFAULT_PORT = 3001
export const DEFAULT_MAX_MESSAGE_SIZE_MB = 5

// Server bounds
export const MAX_PORT = 65535
