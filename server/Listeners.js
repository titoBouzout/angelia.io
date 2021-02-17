'use strict';

const utilsInspect = Symbol.for('nodejs.util.inspect.custom');

const addClass = Symbol.for('Listeners.addClass');
const addObject = Symbol.for('Listeners.addObject');
const addFunction = Symbol.for('Listeners.addFunction');
const addProperties = Symbol.for('Listeners.addProperties');
const Classes = Symbol.for('Listeners.Classes');

const Template = Symbol.for('Listeners.Template');
const inspect = Symbol.for('Listeners.inspect');

const isClass = require('is-class');
const isObject = require('isobject');

const Listeners = {
	[Classes]: Object.create(null),
	add(listener, className) {
		if (isClass(listener)) {
			this[addClass](listener, className);
		} else if (isObject(listener)) {
			this[addObject](listener, className);
		} else if (listener && listener.bind) {
			this[addFunction](listener, className);
		} else if (Array.isArray(listener)) {
			for (let l of listener) {
				this.add(l);
			}
		} else {
			console.error(
				'angelia.io Error - Call to Listeners.add with unsupported type:',
				listener,
				className || '',
				'\n',
			);
			throw new Error();
		}

		if (this.server && this.server.ensureFastProperties) {
			this.server.ensureFastProperties();
		}
	},
	[addClass](listener, className) {
		className = className || listener.name || 'Class';

		let instance = new listener();
		this[addProperties](instance, className);
	},
	[addObject](listener, className) {
		className = className || listener.name || 'Object';

		function Listener(methods) {
			Object.assign(this, methods);
		}

		let instance = new Listener(listener);
		this[addProperties](instance, className);
	},
	[addFunction](listener, className) {
		className = className || listener.name.replace(/bound /g, '');

		this[addObject](
			{
				[className]: listener,
			},
			'Function',
		);
	},
	[addProperties](instance, className) {
		let methods = [
			...Object.getOwnPropertyNames(instance.__proto__),
			...Object.getOwnPropertyNames(instance),
		];

		for (let m of methods) {
			if (m !== 'constructor' && instance[m].bind) {
				if (m === 'add') {
					throw new Error(
						'angelia.io Error - Adding a listener named "add" is forbidden',
						typeof instance,
						instance,
						className,
					);
				} else {
					let method = instance[m].bind(instance);
					method.__className = className;

					this[m] = this[m] || this[Template]();
					this[m].fns.push(method);

					this[Classes][className] = this[Classes][className] || Object.create(null);
					this[Classes][className][m] = method;
				}
			}
		}

		Object.defineProperty(instance, 'server', {
			get: function() {
				return Listeners.server;
			},
			configurable: false,
			enumerable: false,
		});
		Object.defineProperty(instance, 'listeners', {
			get: function() {
				return Listeners[Classes];
			},
			configurable: false,
			enumerable: false,
		});
	},

	[Template]() {
		function Listener(...args) {
			for (let fn of this.fns) {
				// console.log('calling listener', fn.name);
				fn(...args);
			}
		}
		let fns = [];
		Listener.fns = fns;
		Listener = Listener.bind(Listener);
		Listener.fns = fns;

		Object.freeze(Listener);

		return Listener;
	},
	[utilsInspect]() {
		return this[inspect]();
	},
	toJSON() {
		return this[inspect]();
	},
	[inspect]() {
		let listeners = [];
		for (let m in this) {
			if (Array.isArray(this[m].fns)) {
				for (let fn of this[m].fns) {
					let className = fn.__className;
					let method = fn.name.replace('bound ', '');
					method = method != m ? method + '/' + m : method;
					listeners.push(className + '.' + method);
				}
			}
		}
		return listeners.sort();
	},
};

Listeners.__proto__ = Object.create(null);

Object.freeze(Listeners.add);
Object.freeze(Listeners[addClass]);
Object.freeze(Listeners[addObject]);
Object.freeze(Listeners[addFunction]);
Object.freeze(Listeners[addProperties]);
Object.freeze(Listeners[Template]);

Object.freeze(Listeners[utilsInspect]);
Object.freeze(Listeners.toJSON);
Object.freeze(Listeners[inspect]);

module.exports = Listeners;
