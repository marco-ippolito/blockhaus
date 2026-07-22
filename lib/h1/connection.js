import { H1Parser } from "./parser.js";
import { writeResponse } from "./serializer.js";

const MAX_PIPELINE = 32;
const FORBIDDEN_TRAILER_FIELDS = new Set([
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

const REASON_PHRASE = {
	100: "Continue",
	101: "Switching Protocols",
	102: "Processing",
	103: "Early Hints",
};

function reasonPhrase(status) {
	return REASON_PHRASE[status] ?? "Informational";
}

// Connection timer states. One absolute deadline is armed per state,
// deliberately NOT reset by socket activity, so byte-trickling clients
// (slowloris) cannot hold a connection open indefinitely.
const IDLE = 0; // between requests: keepAliveTimeout
const HEADERS = 1; // bytes seen, headers not done: headersTimeout
const ACTIVE = 2; // request/response in flight: requestTimeout

/**
 * HTTP/1.x connection. Socket bytes feed the parser, which produces queued
 * messages; each is dispatched sequentially and its response serialized back.
 *
 * The parser parses ahead (pipelined requests can surface in one feed), so
 * parsed messages are queued and answered strictly in order. The socket is
 * paused when the pipeline queue or the in-flight request body stream backs up.
 */
export class H1Connection {
	#socket;
	#dispatch;
	#parser;
	#queue = [];
	#running = false;
	#scheme;
	#altSvc;
	#closed = false;
	#closing = false;
	#timeouts;
	#timer = null;
	#timerState = -1;
	#onFinished;
	#limits;
	#connect;
	#tunnel = null;
	#onSocketData;
	#pendingConnect = null;
	#onReject;
	#parsing = false;
	#deferredFailure = null;
	#validatedHost = null;
	#hostValid = false;
	#remoteAddressValue;

	/**
	 * @param {import('node:net').Socket} socket
	 * @param {(request: Request, meta: object) => Promise<Response>} dispatch
	 * @param {object} opts
	 * @param {'http'|'https'} opts.scheme
	 * @param {string|null} opts.altSvc
	 * @param {{keepAliveTimeout: number, headersTimeout: number, requestTimeout: number}} opts.timeouts
	 * @param {() => void} [opts.onFinished] called once the connection is gone
	 */
	constructor(
		socket,
		dispatch,
		{ scheme, altSvc = null, timeouts, limits, connect, onFinished, onReject },
	) {
		this.#socket = socket;
		this.#remoteAddressValue = {
			address: socket.remoteAddress ?? "",
			port: socket.remotePort ?? null,
			family: socket.remoteFamily ?? null,
		};
		this.#dispatch = dispatch;
		this.#scheme = scheme;
		this.#altSvc = altSvc;
		this.#timeouts = timeouts;
		this.#limits = limits;
		this.#connect = connect;
		this.#onFinished = onFinished;
		this.#onReject = onReject ?? (() => {});
		this.#parser = new H1Parser({
			// A throw from inside a parser callback would otherwise propagate
			// through the wasm boundary up to the socket 'data' listener and
			// crash the process (e.g. a Host header that fails URL parsing).
			onHeaders: (m) => {
				try {
					this.#onHeaders(m);
				} catch {
					this.#onParseError();
				}
			},
			onData: (chunk) => this.#onData(chunk),
			onTrailers: (trailers) => this.#onTrailers(trailers),
			onMessageComplete: () => this.#onMessageComplete(),
			onError: () => this.#onParseError(),
		});

		this.#onSocketData = (chunk) => {
			if (this.#tunnel !== null) {
				this.#forwardTunnelData(chunk);
				return;
			}
			if (this.#timerState === IDLE) this.#setTimer(HEADERS);
			try {
				this.#parsing = true;
				this.#parser.feed(chunk);
				this.#parsing = false;
				if (this.#deferredFailure !== null) {
					const failure = this.#deferredFailure;
					this.#deferredFailure = null;
					if (failure.parse) this.#onParseError();
					else this.#reject(failure.status, failure.reason);
					return;
				}
				if (this.#pendingConnect !== null && !this.#closed) {
					const { authority, headers } = this.#pendingConnect;
					this.#pendingConnect = null;
					const pending = this.#parser.takePending();
					this.#beginConnect(authority, headers, pending).catch(() =>
						this.#teardown(new Error("CONNECT failed")),
					);
				}
			} catch {
				this.#parsing = false;
				this.#teardown(new Error("parser failure"));
			}
		};
		socket.on("data", this.#onSocketData);
		socket.on("error", () => this.#teardown(new Error("socket error")));
		socket.on("close", () => this.#teardown(new Error("socket closed")));
		this.#setTimer(IDLE);
	}

	/**
	 * Graceful shutdown: idle connections close now, busy ones finish the
	 * in-flight exchange first (the pump checks #closing after each entry).
	 */
	initiateClose() {
		this.#closing = true;
		if (this.#queue.length === 0 && !this.#running) {
			this.#socket.end();
			this.#teardown();
		}
	}

	#setTimer(state) {
		if (this.#timerState === state) return;
		this.#timerState = state;
		if (this.#timer !== null) clearTimeout(this.#timer);
		const ms =
			state === IDLE
				? this.#timeouts.keepAliveTimeout
				: state === HEADERS
					? this.#timeouts.headersTimeout
					: this.#timeouts.requestTimeout;
		if (!ms || ms <= 0) {
			this.#timer = null;
			return;
		}
		this.#timer = setTimeout(() => this.#onTimeout(state), ms);
		this.#timer.unref?.();
	}

	#onTimeout(state) {
		if (this.#closed) return;
		const committed = this.#queue[0]?.committed === true;
		if (
			state !== IDLE &&
			!committed &&
			!this.#socket.destroyed &&
			this.#socket.writable
		) {
			this.#socket.end(
				"HTTP/1.1 408 Request Timeout\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
			);
		} else if (!committed) {
			this.#socket.end();
		} else {
			this.#socket.destroy();
		}
		this.#teardown(new Error("connection timed out"));
	}

	#onHeaders(m) {
		if (this.#deferredFailure !== null || this.#closed) return;
		this.#setTimer(ACTIVE);
		if (
			m.hostCount !== 1 ||
			m.host.trim() === "" ||
			m.invalidContentLength ||
			m.conflictingContentLength ||
			(m.contentLengthCount > 0 && m.transferEncodingCount > 0) ||
			(m.transferEncodingCount > 0 &&
				(m.transferEncodingCount !== 1 || m.invalidTransferEncoding)) ||
			m.forbiddenTrailer ||
			m.connectionNominatesFraming
		) {
			this.#onParseError();
			return;
		}
		if (
			this.#limits.maxHeaderSize > 0 &&
			m.headerBytes > this.#limits.maxHeaderSize
		) {
			this.#reject(431, "Request Header Fields Too Large");
			return;
		}
		if (
			this.#limits.maxRequestBodySize > 0 &&
			m.contentLength > this.#limits.maxRequestBodySize
		) {
			this.#reject(413, "Content Too Large");
			return;
		}
		if (m.method === "CONNECT") {
			if (m.url.toLowerCase() !== m.host.trim().toLowerCase()) {
				this.#onParseError();
				return;
			}
			this.#socket.pause();
			this.#pendingConnect = {
				authority: m.url,
				headers: new Headers(m.headers),
			};
			return;
		}

		const host = m.host.trim();
		let url;
		if (m.url.startsWith("/")) {
			if (!this.#validHost(host)) {
				this.#onParseError();
				return;
			}
			url = `${this.#scheme}://${host}${m.url}`;
		} else if (m.url === "*") {
			if (!this.#validHost(host)) {
				this.#onParseError();
				return;
			}
			url = `${this.#scheme}://${host}/`;
		} else {
			const absolute = new URL(m.url);
			if (
				!["http:", "https:"].includes(absolute.protocol) ||
				absolute.host.toLowerCase() !== m.host.trim().toLowerCase()
			) {
				this.#onParseError();
				return;
			}
			url = m.url; // absolute-form
		}
		const method = m.method.toUpperCase();
		const expect = m.expect;
		if (expect !== "" && expect !== "100-continue") {
			this.#reject(417, "Expectation Failed");
			return;
		}
		const bodyless = method === "GET" || method === "HEAD";
		if (bodyless && m.hasBody) {
			this.#onParseError();
			return;
		}
		const entry = {
			url,
			method,
			requestHeaders: m.headers,
			isHead: method === "HEAD",
			keepAlive: !m.connectionClose && !m.upgrade,
			controller: null,
			discardBody: bodyless,
			complete: false,
			responded: false,
			committed: false,
			abort: null,
			aborted: false,
			abortReason: undefined,
			receivedBytes: 0,
			trailers: Promise.withResolvers(),
			...Promise.withResolvers(),
		};
		this.#queue.push(entry);

		let body;
		if (m.hasBody && !bodyless) {
			const socket = this.#socket;
			body = new ReadableStream({
				start(controller) {
					entry.controller = controller;
				},
				pull() {
					socket.resume();
				},
				cancel() {
					entry.discardBody = true;
					socket.resume();
				},
			});
		}

		entry.getRequest = () => {
			entry.request ??= new Request(url, {
				method,
				headers: m.headers,
				body,
				...(body ? { duplex: "half" } : {}),
			});
			return entry.request;
		};

		if (expect === "100-continue") {
			this.#socket.write("HTTP/1.1 100 Continue\r\n\r\n");
		}
		if (this.#queue.length >= MAX_PIPELINE) this.#socket.pause();
		this.#pump();
	}

	#validHost(host) {
		if (host !== this.#validatedHost) {
			this.#validatedHost = host;
			this.#hostValid = URL.canParse(`${this.#scheme}://${host}/`);
		}
		return this.#hostValid;
	}

	#current() {
		// Body/data events always belong to the newest parsed message.
		return this.#queue[this.#queue.length - 1];
	}

	#onData(chunk) {
		if (this.#deferredFailure !== null || this.#closed) return;
		if (this.#tunnel !== null) {
			this.#forwardTunnelData(chunk);
			return;
		}
		const entry = this.#current();
		if (!entry) return;
		entry.receivedBytes += chunk.length;
		if (
			this.#limits.maxRequestBodySize > 0 &&
			entry.receivedBytes > this.#limits.maxRequestBodySize
		) {
			entry.aborted = true;
			entry.abortReason = new Error("request body too large");
			entry.abort?.abort(entry.abortReason);
			this.#reject(413, "Content Too Large");
			return;
		}
		if (entry.discardBody || !entry.controller) return;
		entry.controller.enqueue(new Uint8Array(chunk));
		if (entry.controller.desiredSize <= 0) this.#socket.pause();
	}

	#forwardTunnelData(chunk) {
		if (this.#tunnel.upstream === null) {
			this.#tunnel.pending.push(chunk);
		} else if (!this.#tunnel.upstream.write(chunk)) {
			this.#socket.pause();
			this.#tunnel.upstream.once("drain", () => this.#socket.resume());
		}
	}

	async #beginConnect(authority, headers, initialData = null) {
		if (this.#connect === null) {
			this.#reject(501, "Not Implemented");
			return;
		}
		const abort = new AbortController();
		this.#tunnel = {
			abort,
			upstream: null,
			pending: initialData?.length ? [initialData] : [],
		};
		this.#socket.pause();
		let result;
		try {
			result = await this.#connect({
				authority,
				headers,
				remoteAddress: this.#remoteAddress(),
				httpVersion: "1.1",
				alpnProtocol: this.#socket.alpnProtocol || null,
				signal: abort.signal,
			});
		} catch {
			result = new Response("Bad Gateway", { status: 502 });
		}
		if (this.#closed) {
			result?.destroy?.();
			return;
		}
		if (result === null) {
			this.#reject(501, "Not Implemented");
			return;
		}
		if (result instanceof Response) {
			await writeResponse(this.#socket, result, { keepAlive: false });
			this.#socket.end();
			this.#teardown();
			return;
		}
		if (
			result === undefined ||
			typeof result.write !== "function" ||
			typeof result.on !== "function"
		) {
			this.#reject(502, "Bad Gateway");
			return;
		}
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.#running = true;
		this.#tunnel.upstream = result;
		this.#socket.write(
			"HTTP/1.1 200 Connection Established\r\nconnection: keep-alive\r\n\r\n",
		);
		result.on("data", (chunk) => {
			if (!this.#socket.write(chunk)) {
				result.pause?.();
				this.#socket.once("drain", () => result.resume?.());
			}
		});
		result.once("end", () => {
			this.#socket.end();
			this.#teardown();
		});
		result.once("error", () => this.#teardown(new Error("tunnel error")));
		for (const chunk of this.#tunnel.pending) result.write(chunk);
		this.#tunnel.pending.length = 0;
		this.#socket.resume();
	}

	#onMessageComplete() {
		if (this.#deferredFailure !== null || this.#closed) return;
		const entry = this.#current();
		if (!entry) return;
		entry.complete = true;
		if (entry.controller && !entry.discardBody) {
			try {
				entry.controller.close();
			} catch {
				// already errored/cancelled
			}
		}
		entry.resolve();
		entry.trailers.resolve(new Headers());
	}

	#onTrailers(values) {
		if (this.#deferredFailure !== null || this.#closed) return;
		const entry = this.#current();
		if (!entry) return;
		if (
			values.some(([name]) => FORBIDDEN_TRAILER_FIELDS.has(name.toLowerCase()))
		) {
			this.#onParseError();
			return;
		}
		const trailers = new Headers();
		for (const [name, value] of values) trailers.append(name, value);
		entry.trailers.resolve(trailers);
	}

	#remoteAddress() {
		return this.#remoteAddressValue;
	}

	/** Write an interim 1xx response ahead of the final one (ctx.sendInformational). */
	#sendInformational(entry, status, headers) {
		if (
			entry.committed ||
			this.#closed ||
			this.#socket.destroyed ||
			!this.#socket.writable
		) {
			return;
		}
		let head = `HTTP/1.1 ${status} ${reasonPhrase(status)}\r\n`;
		if (headers) {
			const parsed =
				headers instanceof Headers ? headers : new Headers(headers);
			for (const [name, value] of parsed) head += `${name}: ${value}\r\n`;
		}
		head += "\r\n";
		this.#socket.write(head);
	}

	#reject(status, reason) {
		if (this.#parsing) {
			this.#deferredFailure = { status, reason, parse: false };
			return;
		}
		this.#onReject({
			protocol: "1.1",
			remoteAddress: this.#remoteAddress(),
			status,
			reason,
		});
		if (this.#queue[0]?.committed === true) {
			this.#teardown(new Error(reason));
			return;
		}
		if (!this.#socket.destroyed && this.#socket.writable) {
			this.#socket.end(
				`HTTP/1.1 ${status} ${reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`,
			);
		}
		this.#teardown(new Error(reason));
	}

	#onParseError() {
		if (this.#parsing) {
			this.#deferredFailure = { parse: true };
			return;
		}
		this.#onReject({
			protocol: "1.1",
			remoteAddress: this.#remoteAddress(),
			status: 400,
			reason: "Bad Request",
		});
		if (this.#queue[0]?.committed === true) {
			this.#teardown(new Error("parse error"));
			return;
		}
		const head =
			"HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
		if (!this.#socket.destroyed && this.#socket.writable) {
			this.#socket.end(head);
		}
		this.#teardown(new Error("parse error"));
	}

	async #pump() {
		if (this.#running) return;
		this.#running = true;
		try {
			while (this.#queue.length > 0 && !this.#closed) {
				const entry = this.#queue[0];
				// force a fresh per-request deadline even if already ACTIVE
				this.#timerState = -1;
				this.#setTimer(ACTIVE);
				let response = this.#dispatch(entry.getRequest, {
					remoteAddress: this.#remoteAddress(),
					url: entry.url,
					method: entry.method,
					requestHeaders: entry.requestHeaders,
					httpVersion: "1.1",
					alpnProtocol: this.#socket.alpnProtocol || null,
					signal: () => {
						entry.abort ??= new AbortController();
						if (entry.aborted && !entry.abort.signal.aborted) {
							entry.abort.abort(entry.abortReason);
						}
						return entry.abort.signal;
					},
					trailers: entry.trailers.promise,
					sendInformational: (status, headers) =>
						this.#sendInformational(entry, status, headers),
				});
				if (!(response instanceof Response)) response = await response;
				if (response === null) {
					// ctx.deny() / no response: refuse without a reply. h1 has no
					// per-request reset, so the connection is dropped; the client
					// sees no response and can safely retry.
					this.#teardown(new Error("request denied"));
					return;
				}
				await writeResponse(this.#socket, response, {
					keepAlive: entry.keepAlive && !this.#closing,
					isHead: entry.isHead,
					altSvc: this.#altSvc,
					onCommit: () => {
						entry.committed = true;
					},
				});
				entry.responded = true;
				if (!entry.complete) {
					// Response finished before the request body was fully read:
					// drain and discard the rest so the framing stays aligned.
					entry.discardBody = true;
					this.#socket.resume();
					await entry.promise;
				}
				this.#queue.shift();
				if (!entry.keepAlive || this.#closing) {
					this.#socket.end();
					this.#teardown();
					return;
				}
				if (this.#queue.length < MAX_PIPELINE) this.#socket.resume();
			}
			if (!this.#closed) this.#setTimer(IDLE);
		} catch {
			this.#teardown(new Error("response write failed"));
		} finally {
			this.#running = false;
		}
	}

	#teardown(err) {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#timer !== null) clearTimeout(this.#timer);
		for (const entry of this.#queue) {
			if (!entry.responded) {
				entry.aborted = true;
				entry.abort?.abort();
			}
			if (entry.controller && !entry.complete && !entry.discardBody) {
				try {
					entry.controller.error(err ?? new Error("connection closed"));
				} catch {
					// stream already closed
				}
			}
			entry.resolve();
			entry.trailers?.resolve(new Headers());
		}
		this.#queue.length = 0;
		this.#socket.off("data", this.#onSocketData);
		this.#tunnel?.abort.abort(err);
		if (this.#tunnel?.upstream && !this.#tunnel.upstream.destroyed) {
			this.#tunnel.upstream.destroy();
		}
		this.#parser.destroy();
		// A socket that was end()ed (400/501 replies) is left to flush its FIN;
		// anything else erroring gets torn down immediately.
		if (err && !this.#socket.destroyed && !this.#socket.writableEnded) {
			this.#socket.destroy();
		}
		this.#onFinished?.();
	}
}
