import { Emitter } from './Emitter.js'
import type { Socket } from './Socket.js'

export class Room extends Emitter {
	sockets: Socket[]
	id: any
	persistent: boolean

	onCreate(socket: Socket): void
	onDelete(socket: Socket): void
	onJoin(socket: Socket): void
	onLeave(socket: Socket): void

	join(socket: Socket): void
	leave(socket: Socket): void
}
