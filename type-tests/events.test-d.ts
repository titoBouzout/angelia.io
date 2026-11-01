/**
 * Compile-only type test. Augments the event maps and exercises every
 * typed surface. `@ts-expect-error` marks lines that MUST fail — tsc
 * errors only if an expected error doesn't materialize.
 *
 * Run: `npx tsc -p type-tests/`
 */

import Server, { Room, Rooms } from '../server/index.js'
import type { Socket } from '../server/index.js'
import Client from '../client/index.js'

declare module '../server/index.js' {
	interface ServerEvents {
		typing: boolean
		theMessage: string
	}
	interface ClientEvents {
		gotIt: string
		bigState: { rows: string[] }
	}
	interface ServerReplies {
		theMessage: string
	}
	interface ClientReplies {}
}

// ---------------- Server.on(Class) ----------------

class GoodChat {
	typing(socket: Socket, data: boolean) {
		if (data) console.log(socket.ip)
	}
	theMessage(
		socket: Socket,
		data: string,
		reply?: (v: string) => void,
	) {
		reply?.(data.toUpperCase())
	}
	// extra helper — not in the map, still allowed
	helper() {}
	// predefined events are allowed too
	connect(socket: Socket, request: { headers: any; url: string }) {
		void socket.ip
		void request.headers
	}
	disconnect(socket: Socket) {
		void socket
	}
}
Server.on(GoodChat)

class UnannotatedChat {
	// unannotated params are `any` (noImplicitAny: false), still OK
	typing(socket: any, data: any) {
		void data
	}
}
Server.on(UnannotatedChat)

class WrongDataType {
	typing(socket: Socket, data: string) {
		void data
	}
}
// @ts-expect-error `typing.data` should be boolean, not string
Server.on(WrongDataType)

class WrongReply {
	theMessage(
		socket: Socket,
		data: string,
		reply?: (v: number) => void,
	) {
		void reply
		void data
	}
}
// @ts-expect-error `theMessage.reply` should take string, not number
Server.on(WrongReply)

// ---------------- Socket.emit ----------------

declare const socket: Socket

socket.emit('gotIt', 'yes')
socket.emit('bigState', { rows: ['a', 'b'] })
// @ts-expect-error 'gotIt' takes a string, not a number
socket.emit('gotIt', 42)
// @ts-expect-error 'bigState' takes { rows: string[] }
socket.emit('bigState', { rows: [42] })
// @ts-expect-error 'unknown' is not a ClientEvents key
socket.emit('unknown', 'x')

// ---------------- Server / Room broadcast ----------------

Server.emit('gotIt', 'hello')
Server.broadcast(socket, 'gotIt', 'hi')

const room = new Room()
room.emit('gotIt', 'hello')
// @ts-expect-error room.emit wrong value type
room.emit('gotIt', 123)
room.broadcast(socket, 'gotIt', 'hello')
// @ts-expect-error broadcast wrong value type
room.broadcast(socket, 'gotIt', 123)

// ---------------- Rooms<R> ----------------

class GameRoom extends Room {
	score = 0
}
const games = new Rooms(GameRoom)
games.emit('gotIt', 'hi')
games.broadcast(socket, 'gotIt', 'hi')
const got = games.get('r1') // GameRoom | undefined
if (got) got.score = 1
const list: GameRoom[] = games.list
void list
const all: Socket[] = games.sockets
void all
games.join(socket, 'r1')
games.leave(socket, 'r1')
// @ts-expect-error Rooms.emit wrong value type
games.emit('gotIt', 1)

// ---------------- Client.emit ----------------

const client = new Client({ url: 'ws://localhost:3001' })

client.emit('typing', true)
client.emit('theMessage', 'hi there')
// @ts-expect-error 'typing' takes boolean
client.emit('typing', 'yes')
// @ts-expect-error 'unknown' is not a ServerEvents key
client.emit('unknown', 1)

// callback form — promise resolves with callback's return value
const p: Promise<number> = client.emit(
	'theMessage',
	'q',
	reply => reply.length,
)
void p

// @ts-expect-error reply for theMessage is a string — .toFixed isn't there
client.emit('theMessage', 'q', reply => reply.toFixed())

// ---------------- Client.on ----------------

client.on('gotIt', msg => msg.toUpperCase())
client.on('bigState', state => state.rows.join(','))
// @ts-expect-error 'unknown' is not a ClientEvents key
client.on('unknown', () => {})
// @ts-expect-error msg is string, not number
client.on('gotIt', msg => msg.toFixed())

// predefined client events
client.on('connect', () => {})
client.on('reconnect', () => {})
client.on('disconnect', () => {})
