export { default, Server } from './Server.js'
export { Emitter } from './Emitter.js'
export { Message } from './Message.js'
export { Room } from './Room.js'
export { Rooms } from './Rooms.js'
export type { Socket } from './Socket.js'

/**
 * Event-map interfaces. Augment these from your app to get end-to-end
 * typing of `emit`, `on`, replies, and `Server.on(Class)` listeners.
 *
 * ```ts
 * declare module 'angelia.io/server' {
 *   interface ServerEvents { typing: boolean; theMessage: string }
 *   interface ClientEvents { gotIt: string }
 *   interface ServerReplies { theMessage: string }
 * }
 * ```
 *
 * Without augmentation everything stays `any` (non-breaking).
 */

/** Data shapes for messages the **client sends to the server**. */
export interface ServerEvents {}

/** Data shapes for messages the **server sends to the client**. */
export interface ClientEvents {}

/**
 * Reply shapes for `ServerEvents` — i.e. when the client emits `K`
 * with a callback, this is what the server's `reply(...)` passes back.
 */
export interface ServerReplies {}

/**
 * Reply shapes for `ClientEvents` — i.e. when the server emits `K`
 * with a callback, this is what the client's reply passes back.
 */
export interface ClientReplies {}

/**
 * Event key constraint: any string when the events interface is empty
 * (unaugmented — keeps the library loose by default), otherwise only
 * the declared keys.
 */
export type EventKey<E> = [keyof E] extends [never] ? string : keyof E

/**
 * Event value lookup: `E[K]` when declared, falling back to `any`.
 * Works together with `EventKey` so unaugmented usage is fully loose.
 */
export type EventValue<E, K> = K extends keyof E ? E[K] : any
