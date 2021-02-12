export default class WebSocketClient {

	constructor(url) {
		console.log('ws instantiated');

		this.url = url;

		this.listeners = {};
		this.messages = [];

		this.reconnect = true;
		this.isReconnect = false;

		this.nextTick = this.nextTick.bind(this)

		this.onopen = this.onopen.bind(this)
		this.onclose = this.onclose.bind(this)
		this.onerror = this.onerror.bind(this)
		this.onmessage = this.onmessage.bind(this)

		this.connect();
	}
	// public API
	connect() {
		if (
			!this.connected &&
			this.reconnect &&
			(!this.io || this.io.readyState === WebSocket.CLOSED)
		) {
			this.io = new WebSocket(this.url);
			this.io.onopen = this.onopen;
			this.io.onclose = this.onclose;
			this.io.onerror = this.onerror;
			this.io.onmessage = this.onmessage;
		}
	}
	get connected() {
		return this.io && this.io.readyState === WebSocket.OPEN;
	}
	disconnect() {
		console.log('ws manual disconnect');
		this.reconnect = false;
		if (this.io.readyState !== WebSocket.CLOSING && this.io.readyState !== WebSocket.CLOSED) {
			this.io.close();
		}
	}
	on(k, v) {
		this.listeners[k] = this.listeners[k] || [];
		this.listeners[k].push(v);
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
			console.log('ws reconnected');
			this.dispatch('reconnect');
		} else {
			this.isReconnect = true;
			console.log('ws connected');
			this.dispatch('connect');
		}
	};
	onclose(a, b) {
		switch (a.code) {
			// normal close
			case 1000:
				console.log('ws normal close');
				break;
			// closed by client
			case 1005:
				console.log('ws we called socket.disconnect()');
				break;
			// closed by server
			case 1006: {
				console.log('ws, the server killed the connection, or we failed to connect to server');
				break;
			}
			default: {
				console.log('ws closed, code', a.code, a, b);
				break;
			}
		}
		this.dispatch('disconnect');
		this.connect();
	};
	onerror(a, b) {
		this.dispatch('disconnect');
		this.connect();
	};
	onmessage(e) {
		if (e.data === '') {
			this.pong();
		} else {
			let messages = JSON.parse(e.data);
			for (let m of messages) {
				this.dispatch(m.k, m.v);
			}
		}
	};
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
	};
	pong() {
		if (this.io.readyState === WebSocket.OPEN) {
			this.io.send('');
		}
	}
}

