
export function ListenerTemplate(): {
	(...args: any[]): void
	fns: any[]
}

export const now: () => number
/** A complete WebSocket text frame, ready to write to any socket. */
export const frame: (text: string) => Buffer[]
export const stringify: typeof JSON.stringify
export const parse: typeof JSON.parse
export const isArray: typeof Array.isArray
export const empty: <T = any>() => Record<string, T>

/** Parse the query string of a URL into a plain params object. */
export function params(url?: string): Record<string, string>
export const inspect: unique symbol
