const join = Symbol.for('Room.join')
const leave = Symbol.for('Room.leave')
const parent = Symbol.for('Room.parent')

module.exports = {
	join,
	leave,
	parent,
}
