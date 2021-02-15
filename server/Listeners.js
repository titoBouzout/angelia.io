const inspect = Symbol.for('nodejs.util.inspect.custom');

class Listeners {
	static add(listener) {
		let name = listener.name;
		listener = new listener();
		for (let m of Object.getOwnPropertyNames(listener.__proto__)) {
			if (m !== 'constructor') {
				Listeners.prototype[m] = listener[m];
				Listeners.prototype[m]._class = name;
			}
		}
		for (let m in listener) {
			if (m !== 'constructor') {
				Listeners.prototype[m] = listener[m];
				Listeners.prototype[m]._class = name;
			}
		}
	}
	[inspect]() {
		return this.inspect();
	}
	toJSON() {
		return this.inspect();
	}
	inspect() {
		let listeners = [];
		for (let m of Object.getOwnPropertyNames(this)) {
			if (this[m]._class) listeners.push(this[m]._class + '.' + m);
		}
		for (let m in this) {
			if (this[m]._class) listeners.push(this[m]._class + '.' + m);
		}
		return listeners;
	}
}

module.exports = Listeners;
