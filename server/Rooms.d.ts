import { Emitter } from './Emitter.js'
import type { Room } from './Room.js'
import type { Socket } from './Socket.js'

export class Rooms<R extends Room = Room> extends Emitter {
	constructor(RoomClass: new () => R)

	RoomClass: new () => R
	rooms: Map<any, R>

	get sockets(): Socket[]
	get list(): R[]

	get(id: any): R | undefined
	join(socket: Socket, id?: any): void
	leave(socket: Socket, id?: any): void

	toJSON(): R[]
}
