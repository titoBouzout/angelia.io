const inspect = Symbol.for('nodejs.util.inspect.custom')

class Listeners {
	constructor() {
		Object.assign(this, {
			classes: Object.create(null),
			events: Object.create(null),
		})
	}
	on(listener, asCallback) {
		// Listeners.on('connect', function(){ console.log('connected as callback')})
		if (asCallback !== undefined) {
			if (
				typeof listener === 'string' &&
				!this.isClass(asCallback) &&
				!this.isObject(asCallback) &&
				this.isFunction(asCallback)
			) {
				return this.addFunction(asCallback, listener)
			} else {
				throw new Error(
					`\nCall to Listeners.on(key, callback) with unsupported types. Named listeners only support strings as name, and functions as callbacks. \nExample: Listeners.on("connect", ()=>{console.log("connected")}) \nData you passed: \nName: "${listener}" ${
						typeof listener === 'string'
							? 'OK'
							: 'FAIL should be of the type "string" when a callback is passed'
					} \nCallback: "${asCallback}" ${
						typeof asCallback === 'function'
							? 'OK'
							: 'FAIL should be of the type "function"'
					}\n`,
				)
			}
		} else if (this.isClass(listener)) {
			return this.addClass(listener)
		} else if (this.isObject(listener)) {
			return this.addObject(listener)
		} else if (this.isFunction(listener)) {
			return this.addFunction(listener)
		} else {
			throw new Error(
				'angelia.io - Call to Listeners.on with unsupported type:',
				listener,
				className || '',
				'\n',
			)
		}
	}
	addClass(listener, className) {
		className = className || listener.name || 'Class'

		let instance = new listener()
		return this.addProperties(instance, className)
	}
	addObject(listener, className) {
		className = className || listener.name || 'Object'

		function Listener(methods) {
			Object.assign(this, methods)
		}

		let instance = new Listener(listener)
		return this.addProperties(instance, className)
	}
	addFunction(listener, className) {
		className = className || listener.name.replace(/bound /g, '')

		return this.addObject(
			{
				[className]: listener,
			},
			'Function',
		)
	}
	addProperties(instance, className) {
		let methods = [
			...Object.getOwnPropertyNames(instance.__proto__),
			...Object.getOwnPropertyNames(instance),
		]

		for (let m of methods) {
			// '' listener is reserved
			if (m !== 'constructor' && m !== '') {
				if (this.isFunction(instance[m])) {
					let method = instance[m].bind(instance)
					method.__className = className

					this.events[m] = this.events[m] || this.Template()
					this.events[m].fns.push(method)

					this.classes[className] =
						this.classes[className] || Object.create(null)
					this.classes[className][m] = method
				}
			}
		}

		Object.defineProperties(instance, {
			classes: {
				value: this.classes,
				writable: false,
				configurable: false,
				enumerable: false,
			},
			events: {
				value: this.events,
				writable: false,
				configurable: false,
				enumerable: false,
			},
		})

		return instance
	}

	Template() {
		function Listener(...args) {
			for (let fn of this.fns) {
				// console.log('calling listener', fn.name);
				fn(...args)
			}
		}
		let fns = []
		Listener.fns = fns
		Listener = Listener.bind(Listener)
		Listener.fns = fns

		return Listener
	}

	isFunction(o) {
		return o && o.bind
	}
	// isobject <https://github.com/jonschlinkert/isobject>
	// MIT license - Copyright (c) 2014-2017, Jon Schlinkert.
	isObject(o) {
		return (
			o != null && typeof o === 'object' && Array.isArray(o) === false
		)
	}
	// is-class <https://github.com/miguelmota/is-class>
	// MIT license - Copyright (C) 2014 Miguel Mota
	isClass() {
		;(function (root) {
			const toString = Function.prototype.toString

			function fnBody(fn) {
				return toString
					.call(fn)
					.replace(/^[^{]*{\s*/, '')
					.replace(/\s*}[^}]*$/, '')
			}

			root.isClass = function isClass(fn) {
				if (typeof fn !== 'function') {
					return false
				}

				if (/^class[\s{]/.test(toString.call(fn))) {
					return true
				}

				// babel.js classCallCheck() & inlined
				const body = fnBody(fn)
				return (
					/classCallCheck\(/.test(body) ||
					/TypeError\("Cannot call a class as a function"\)/.test(
						body,
					)
				)
			}
		})(Listeners.prototype)
	}
	[inspect]() {
		return this.inspect()
	}
	toJSON() {
		return this.inspect()
	}
	inspect() {
		let listeners = []
		for (let m in this.events) {
			if (Array.isArray(this.events[m].fns)) {
				for (let fn of this.events[m].fns) {
					let className = fn.__className
					let method = fn.name.replace('bound ', '')
					method = method != m ? method + ' as ' + m : method
					listeners.push(className + '.' + method)
				}
			}
		}
		return listeners.sort()
	}
}

Listeners.prototype.isClass()

const listeners = new Listeners()

export { listeners as Listeners }
