'use strict';

export default class Client {
	constructor(options) {
		if (!options || typeof options === 'string') {
			options = {
				url: options,
			};
		}

		let protocol = location.protocol === 'https:' ? 'wss' : 'ws';
		if (!options.url) {
			options.url = protocol + '://' + location.hostname + ':3001';
		} else if (options.url.indexOf('://') === -1) {
			options.url = protocol + '://' + options.url;
		}

		options.url = new URL(options.url);

		let params = options.params || {};

		for (let [k, v] of options.url.searchParams.entries()) {
			if (!params.hasOwnProperty(k)) {
				params[k] = v;
			}
		}

		options.url.search = Object.entries(params)
			.filter(([k, v]) => {
				return k !== undefined && k !== null && v !== undefined && v !== null;
			})
			.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
			.join('&');

		Object.assign(this, {
			debug: options.debug,
			url: options.url.toString(),

			reconnect: true,
			isReconnect: false,

			listeners: { '': [this.oncallback.bind(this)] },
			callbacks: [() => {}],
			messages: [],

			onopen: this.onopen.bind(this),
			onclose: this.onclose.bind(this),
			onerror: this.onerror.bind(this),
			onmessage: this.onmessage.bind(this),

			nextTick: this.nextTick.bind(this),
			disconnect: this.disconnect.bind(this),

			longLiveFlash: options.longLiveFlash,
		});

		if (this.debug) console.log('ws instantiated');

		window.addEventListener('unload', () => this.disconnect(true), true);

		// to send messages without waiting for the connection
		Promise.resolve().then(() => this.connect());
	}
	// public API
	connect() {
		if (
			!this.connected &&
			this.reconnect &&
			(!this.io || this.io.readyState === WebSocket.CLOSED)
		) {
			let url = this.url;
			if (this.messages.length) {
				url =
					(url.indexOf('?') === -1 ? url + '?' : url + '&') +
					'angelia.io=' +
					encodeURIComponent(JSON.stringify(this.messages));
				if (url.length <= 2048) {
					this.messages = [];
				} else {
					url = this.url;
				}
			}
			this.io = new WebSocket(url);
			Object.assign(this.io, {
				onopen: this.onopen,
				onclose: this.onclose,
				onerror: this.onerror,
				onmessage: this.onmessage,
			});
		}
	}
	get connected() {
		return this.io && this.io.readyState === WebSocket.OPEN;
	}

	disconnect(noReconnect) {
		if (noReconnect) this.reconnect = false;
		if (this.debug)
			console.log('ws manual disconnect ' + (!this.reconnect ? ' and disallow reconnect' : ''));
		if (
			this.io &&
			this.io.readyState !== WebSocket.CLOSING &&
			this.io.readyState !== WebSocket.CLOSED
		) {
			this.io.close();
		}
	}
	on(k, v) {
		if (k != '' && typeof v === 'function') {
			this.listeners[k] = this.listeners[k] || [];
			this.listeners[k].push(v);
			return () => this.off(k, v);
		} else {
			console.error('socket.on("' + k + '", callback) key and callback cannot be empty');
		}
	}
	off(k, v) {
		if (!this.listeners[k]) {
			console.error('socket.off("' + k + '", callback)', k, 'key not found');
		} else {
			let i = this.listeners[k].indexOf(v);
			if (i === -1) {
				console.error('socket.off("' + k + '", callback)', v, 'callback not found');
			} else {
				this.listeners[k].splice(i, 1);
			}
		}
	}
	emit(k, v, c) {
		if (!this.messages.length) {
			Promise.resolve().then(this.nextTick);
		}
		if (c) {
			this.messages.push([k, v, this.callback(c)]);
		} else if (typeof v === 'function') {
			this.messages.push([k, {}, this.callback(v)]);
		} else if (v !== null && v !== undefined) {
			this.messages.push([k, v]);
		} else {
			this.messages.push([k]);
		}
	}

	// private API
	onopen() {
		Promise.resolve().then(this.nextTick);
		if (this.isReconnect) {
			if (this.debug) console.log('ws reconnected');
			this.dispatch('reconnect');
		} else {
			this.isReconnect = true;
			if (this.debug) console.log('ws connected');
			this.dispatch('connect');
		}
	}
	onclose(event) {
		switch (event.code) {
			// normal close
			case 1000:
				if (this.debug) console.log('ws normal close', event);
				break;
			// closed by client
			case 1005:
				if (this.debug) console.log('ws we called socket.disconnect()', event);
				break;
			// closed by server
			case 1006: {
				if (this.debug)
					console.log(
						'ws, the server killed the connection, or we failed to connect to server',
						event,
					);
				break;
			}
			default: {
				if (this.debug) console.log('ws closed, code', event.code, event);
				break;
			}
		}
		this.dispatch('disconnect');
		this.connect();
	}
	// this happens when trying to connect while the server or the connection is down
	onerror() {
		this.dispatch('disconnect');
		this.connect();
	}
	onmessage(e) {
		if (e.data === '') {
			this.pong();
		} else {
			let messages = JSON.parse(e.data);
			for (let m of messages) {
				this.dispatch(m[0], m[1]);
			}
		}
	}
	oncallback(d) {
		this.callbacks[d[0]](...d[1]);
		this.callbacks[d[0]] = null;
	}
	callback(c) {
		let i = this.callbacks.length;
		this.callbacks[i] = c;
		return i;
	}
	dispatch(k, v) {
		if (this.longLiveFlash) {
			setTimeout(() => {
				if (this.listeners[k]) {
					for (let event of this.listeners[k]) {
						event(v);
					}
				}
			});
		} else {
			if (this.listeners[k]) {
				for (let event of this.listeners[k]) {
					event(v);
				}
			}
		}
	}
	nextTick() {
		if (this.io && this.io.readyState === WebSocket.OPEN && this.messages.length) {
			this.io.send(JSON.stringify(this.messages));
			this.messages = [];
		}
	}
	pong() {
		if (this.io && this.io.readyState === WebSocket.OPEN) {
			this.io.send('');
		}
	}
}
