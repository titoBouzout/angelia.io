/** Remove the first occurrence of `item` from `arr` in place. */
export function remove<T>(arr: T[], item: T): void

export function ListenerTemplate(): {
	(...args: any[]): void
	fns: any[]
}

export const now: () => number
export const encode: (text: string) => Uint8Array
export const stringify: typeof JSON.stringify
export const parse: typeof JSON.parse
export const isArray: typeof Array.isArray
export const empty: <T = any>() => Record<string, T>

/** Parse the query string of a URL into a plain params object. */
export function params(url?: string): Record<string, string>
export const inspect: unique symbol
