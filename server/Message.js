import { encoded } from './constants.js'
import { stringify } from './utils.js'

/** @import { ClientEvents, EventKey, EventValue } from './index.js' */

/**
 * A message encoded once, here, to send to any socket at any time with
 * `send` / `sendExcept`. Later changes to `v` don't reach the wire.
 *
 * @template {EventKey<ClientEvents>} K
 */
export class Message {
	/**
	 * @param {K} k
	 * @param {EventValue<ClientEvents, K>} v
	 */
	constructor(k, v) {
		/**
		 * @internal The wire tuple every send queues.
		 * @type {any[]}
		 */
		this.tuple = [k, v]
		/** The encoded text; equal text means an equal message. */
		this.json = stringify(this.tuple)
		this.tuple[encoded] = this.json
	}
}
