
export function ListenerTemplate(): {
	(a?: any, b?: any, c?: any): void
	fns: any[]
}

export const now: () => number
/** A complete WebSocket text frame, ready to write to any socket. */
export const frame: (text: string) => Buffer[]
export const stringify: typeof JSON.stringify
export const parse: typeof JSON.parse
export const isArray: typeof Array.isArray
export const empty: <T = any>() => Record<string, T>

/** Query string as a plain object, minus `exclude`, whose value comes back too. */
export function params(
	url?: string,
	exclude?: string,
): [Record<string, string>, string | null]
export const inspect: unique symbol
