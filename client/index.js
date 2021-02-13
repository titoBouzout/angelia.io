export default class WebSocketClient {
	constructor(options) {
		Object.assign(this, {
			debug: typeof options == 'string' ? false : options.debug,
			url: typeof options == 'string' ? options : options.url,

			reconnect: true,
			isReconnect: false,

			listeners: {},
			messages: [],

			onopen: this.onopen.bind(this),
			onclose: this.onclose.bind(this),
			onerror: this.onerror.bind(this),
			onmessage: this.onmessage.bind(this),

			nextTick: this.nextTick.bind(this),
			disconnect: this.disconnect.bind(this),
		});

		if (this.debug) console.log('ws instantiated');

		this.connect();
		window.addEventListener('unload', this.disconnect, true);
	}
	// public API
	connect() {
		if (
			!this.connected &&
			this.reconnect &&
			(!this.io || this.io.readyState === WebSocket.CLOSED)
		) {
			this.io = new WebSocket(this.url);
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
		if (this.debug) console.log('ws manual disconnect');
		if (this.io.readyState !== WebSocket.CLOSING && this.io.readyState !== WebSocket.CLOSED) {
			this.io.close();
		}
	}
	on(k, v) {
		this.listeners[k] = this.listeners[k] || [];
		this.listeners[k].push(v);
		return () => this.off(k, v);
	}
	off(k, v) {
		if (v) {
			if (!this.listeners[k]) {
				console.warn(k + ' doesnt exists on socket.listeners');
			} else {
				let index = this.listeners[k].indexOf(v);
				if (index === -1) {
					console.warn(
						'socket.off("' + k + '", not found)',
						v,
						'not found on socket.listeners[' + k + ']',
					);
				} else {
					this.listeners[k].splice(index, 1);
				}
			}
		} else {
			delete this.listeners[k];
		}
	}
	emit(k, v) {
		if (!this.messages.length) {
			Promise.resolve().then(this.nextTick);
		}
		this.messages.push({
			k,
			v,
		});
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
	onerror(a, b) {
		this.dispatch('disconnect');
		this.connect();
	}
	onmessage(e) {
		if (e.data === '') {
			this.pong();
		} else {
			let messages = JSON.parse(e.data);
			for (let m of messages) {
				this.dispatch(m.k, m.v);
			}
		}
	}
	dispatch(k, v) {
		if (this.listeners[k]) {
			for (let event of this.listeners[k]) {
				event(v);
			}
		}
	}
	nextTick() {
		if (this.io.readyState === WebSocket.OPEN && this.messages.length) {
			this.io.send(JSON.stringify(this.messages));
			this.messages = [];
		}
	}
	pong() {
		if (this.io.readyState === WebSocket.OPEN) {
			this.io.send('');
		}
	}
}
