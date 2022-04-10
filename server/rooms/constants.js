const join = Symbol.for('Room.join')
const leave = Symbol.for('Room.leave')
const parent = Symbol.for('Room.parent')

const add = Symbol.for('Rooms.add')
const remove = Symbol.for('Rooms.remove')

module.exports = {
	// Room
	join,
	leave,
	parent,

	// Rooms
	add,
	remove,
}
