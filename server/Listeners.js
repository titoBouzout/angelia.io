const inspect = Symbol.for('nodejs.util.inspect.custom');

const Listeners = new (class {
	add(listener) {
		this.addClass(listener);
	}
	addClass(listener) {
		let className = listener.name;
		let instance = new listener();
		let methods = [
			...Object.getOwnPropertyNames(instance.__proto__),
			...Object.getOwnPropertyNames(instance),
		];
		for (let m of methods) {
			if (m !== 'constructor') {
				instance[m] = instance[m].bind(instance);
				instance[m].__class = className;

				Listeners[m] = Listeners[m] || this.template();
				Listeners[m].fns.push(instance[m]);
			}
		}
		Object.defineProperty(instance, 'server', {
			get: function() {
				return Listeners.server;
			},
		});
	}
	addFunction(fn) {
		let m = fn.name.replace('bound ', '');

		Object.defineProperty(fn, 'server', {
			get: function() {
				return Listeners.server;
			},
		});
		fn = fn.bind(fn);
		fn.__class = 'Function';
		Listeners[m] = Listeners[m] || this.template();
		Listeners[m].fns.push(fn);
	}
	template() {
		return {
			fns: [],
			run: function(...args) {
				for (let fn of this.fns) fn(...args);
			},
		};
	}
	[inspect]() {
		return this.inspect();
	}
	toJSON() {
		return this.inspect();
	}
	inspect() {
		let listeners = [];
		for (let m in Listeners) {
			if (Array.isArray(Listeners[m].fns)) {
				for (let fn of Listeners[m].fns) {
					let className = fn.__class || 'Function';
					let method = fn.name.replace('bound ', '');
					method = method != m ? method + '/' + m : method;
					listeners.push(className + '.' + method);
				}
			}
		}
		return listeners.sort();
	}
})();

module.exports = Listeners;
