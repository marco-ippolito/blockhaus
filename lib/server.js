import net from "node:net";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { Context } from "./context.js";
import {
	diagnosticChannels,
	hasDiagnosticSubscribers,
	publishDiagnostic,
} from "./diagnostics.js";
import { H1Connection } from "./h1/connection.js";
import { createH2Bridge } from "./h2/index.js";
import { createH3Endpoint, h3Available } from "./h3/index.js";

const H2_PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1");
const DEFAULT_ALPN = ["h2", "h1"];
/** Version marker recognized on handler objects. */
const kServerProtocol = Symbol.for("server.protocol");
let nextServerId = 0;

/**
 * Start a server.
 *
 *   // one-step: pass options, the server binds immediately
 *   const server = serve(handler, { port: 3000 });
 *   await server.listen();            // resolves once bound; server.port is set
 *
 *   // two-step: create, then listen
 *   const server = serve(handler);
 *   await server.listen({ port: 8080 });
 *
 * `handler` is an object with a `fetch(ctx)` method (and optionally a
 * `connect(ctx)` method), optionally tagged `[Symbol.for('server.protocol')]: 1`.
 * `serve()` is synchronous and returns the `Server`; awaiting `server.listen()`
 * waits for the port to be bound.
 *
 * Options:
 *  - port (default 3000), hostname (default '127.0.0.1')
 *  - tls: { key, cert, alpn? } PEM; enables https (h1+h2 via ALPN).
 *    `alpn` restricts the offered protocols (subset of ['h2','h1']).
 *  - quic: true; enables HTTP/3 (requires tls; best-effort when the binary
 *    lacks QUIC support).
 *  - signal: an AbortSignal that closes the server when aborted.
 *
 * One TCP port serves h1 and h2 (ALPN on TLS, preface sniff on plaintext);
 * the same port number on UDP serves h3. Alt-Svc is advertised on h1/h2
 * responses whenever h3 is live.
 */
export function serve(handler, options = {}) {
	const server = new Server(handler, options);
	if (
		options !== null &&
		typeof options === "object" &&
		!Array.isArray(options) &&
		Object.keys(options).length > 0
	) {
		server.listen();
	}
	return server;
}

export class Server {
	#handler;
	#serverId = ++nextServerId;
	#nextRequestId = 0;
	#baseOptions;
	#connect;
	#tls = null;
	#alpn = DEFAULT_ALPN;
	#quic = false;
	#requestedPort = 3000;
	#tcp = null;
	#h2 = null;
	#h3 = null;
	#signal = null;
	#abortListener = null;
	#sockets = new Set();
	#connections = new Set();
	#sessions = new Set();
	#pending = new Set();
	#timeouts;
	#limits;
	#onError = null;
	#busy = false;
	#listening = null;
	#binding = false;
	#closePromise = null;
	#destroyed = false;
	#state = "created";
	#closedResolve;
	#closed;
	#port = null;
	#hostname = "127.0.0.1";
	#protocols = Object.freeze([]);
	/** Shared with the h2 bridge and each h1 connection; set once h3 is up. */
	#shared = { altSvc: null };

	constructor(handler, options = {}) {
		validateHandler(handler);
		validateOptions(options);
		this.#handler = handler;
		this.#baseOptions = options;
		this.#connect =
			typeof handler.connect === "function" ? this.#dispatchConnect : null;
		this.#hostname = options.hostname ?? "127.0.0.1";
		this.#applyBehavior(options);
		const { promise, resolve } = Promise.withResolvers();
		this.#closed = promise;
		this.#closedResolve = resolve;
	}

	/** Resolves once the server is fully closed (graceful or destroyed). */
	get closed() {
		return this.#closed;
	}

	get port() {
		return this.#port;
	}

	get hostname() {
		return this.#hostname;
	}

	/** @returns {readonly string[]} protocols actually being served */
	get protocols() {
		return this.#protocols;
	}

	/**
	 * When true, new requests are not dispatched to the handler (they get a
	 * retryable 503); in-flight requests keep running. For brief back-pressure.
	 */
	get busy() {
		return this.#busy;
	}
	set busy(value) {
		this.#busy = Boolean(value);
	}

	get url() {
		const scheme = this.#tls ? "https" : "http";
		const host = this.hostname.includes(":")
			? `[${this.hostname}]`
			: this.hostname;
		return `${scheme}://${host}:${this.port}/`;
	}

	address() {
		return this.#tcp?.address() ?? null;
	}

	/**
	 * Bind and start serving. Idempotent: the first call starts the listen and
	 * every later call returns the same promise (single listener). Resolves to
	 * this Server once bound.
	 */
	listen(listenOptions = {}) {
		if (this.#state !== "created") {
			if (
				this.#listening !== null &&
				(this.#state === "binding" || this.#state === "listening")
			) {
				return this.#listening;
			}
			return Promise.reject(
				new Error(`cannot listen while server is ${this.#state}`),
			);
		}
		if (this.#listening !== null) return this.#listening;
		this.#state = "binding";
		this.#listening = this.#doListen(listenOptions);
		// A one-step `serve(handler, opts)` starts listening without anyone
		// awaiting it; swallow the rejection here so it is not unhandled. The
		// real error still surfaces to whoever awaits listen()/closed.
		this.#listening.catch(() => {});
		return this.#listening;
	}

	#applyBehavior(options) {
		// Absolute deadlines (ms); 0 disables the individual timeout.
		this.#timeouts = {
			keepAliveTimeout: options.keepAliveTimeout ?? 5_000,
			headersTimeout: options.headersTimeout ?? 60_000,
			requestTimeout: options.requestTimeout ?? 300_000,
			tlsHandshakeTimeout: options.tlsHandshakeTimeout ?? 10_000,
			shutdownTimeout: options.shutdownTimeout ?? 30_000,
		};
		this.#limits = {
			maxConnections: options.maxConnections ?? 1_024,
			maxConcurrentStreams: options.maxConcurrentStreams ?? 100,
			maxHeaderSize: options.maxHeaderSize ?? 16 * 1_024,
			maxRequestBodySize: options.maxRequestBodySize ?? 10 * 1_024 * 1_024,
		};
		this.#onError = options.onError ?? null;
	}

	#dispatch = (request, meta) => {
		const getRequest = typeof request === "function" ? request : () => request;
		const requestId = ++this.#nextRequestId;
		const audit = hasDiagnosticSubscribers(
			diagnosticChannels.requestStart,
			diagnosticChannels.requestEnd,
		)
			? {
					server: this,
					serverId: this.#serverId,
					requestId,
					get request() {
						return getRequest();
					},
					protocol: meta.httpVersion,
					remoteAddress: meta.remoteAddress,
					startedAt: Date.now(),
				}
			: null;
		if (audit !== null) {
			publishDiagnostic(diagnosticChannels.requestStart, audit);
		}
		if (this.#busy) {
			const response = new Response("Service Unavailable", {
				status: 503,
				headers: { "retry-after": "1" },
			});
			this.#publishRequestEnd(audit, response, "busy");
			return response;
		}
		const ctx = new Context(getRequest, {
			...meta,
			waitUntil: (promise) =>
				this.#trackWaitUntil(promise, {
					get request() {
						return getRequest();
					},
					requestId,
				}),
		});
		let response;
		try {
			response = this.#handler.fetch(ctx);
		} catch (error) {
			return this.#handlerFailure(error, ctx, getRequest, requestId, audit);
		}
		if (
			response instanceof Response ||
			response === null ||
			response === undefined
		) {
			return this.#finishDispatch(response, ctx, meta, audit);
		}
		let then;
		try {
			then = response?.then;
		} catch (error) {
			return this.#handlerFailure(error, ctx, getRequest, requestId, audit);
		}
		if (typeof then === "function") {
			return Promise.resolve(response).then(
				(value) => this.#finishDispatch(value, ctx, meta, audit),
				(error) =>
					this.#handlerFailure(error, ctx, getRequest, requestId, audit),
			);
		}
		return this.#finishDispatch(response, ctx, meta, audit);
	};

	#handlerFailure(error, ctx, getRequest, requestId, audit) {
		this.#report(error, {
			phase: "handler",
			get request() {
				return getRequest();
			},
			requestId,
		});
		if (ctx.denied) {
			this.#publishRequestEnd(audit, null, "denied");
			return null;
		}
		const failure = new Response("Internal Server Error", { status: 500 });
		this.#publishRequestEnd(audit, failure, "handler-error");
		return failure;
	}

	#finishDispatch(response, ctx, meta, audit) {
		// deny() already reset the stream through the backend; tell it to stop.
		if (ctx.denied) {
			this.#publishRequestEnd(audit, null, "denied");
			return null;
		}
		// A handler that returns nothing refuses the request (retry-safe reset).
		if (response === undefined || response === null) {
			meta.deny?.("rejected");
			this.#publishRequestEnd(audit, null, "rejected");
			return null;
		}
		if (!(response instanceof Response)) {
			const failure = new Response("Internal Server Error", { status: 500 });
			this.#publishRequestEnd(audit, failure, "invalid-response");
			return failure;
		}
		this.#publishRequestEnd(audit, response, "response");
		return response;
	}

	#publishRequestEnd(audit, response, outcome) {
		if (audit === null) return;
		publishDiagnostic(diagnosticChannels.requestEnd, {
			server: audit.server,
			serverId: audit.serverId,
			requestId: audit.requestId,
			get request() {
				return audit.request;
			},
			protocol: audit.protocol,
			remoteAddress: audit.remoteAddress,
			startedAt: audit.startedAt,
			response,
			status: response?.status ?? null,
			outcome,
			duration: Date.now() - audit.startedAt,
		});
	}

	#auditReject = (metadata) => {
		publishDiagnostic(diagnosticChannels.requestReject, {
			server: this,
			serverId: this.#serverId,
			...metadata,
			timestamp: Date.now(),
		});
	};

	#trackWaitUntil(promise, audit = {}) {
		const tracked = Promise.resolve(promise).then(
			() => {},
			(error) => this.#report(error, { phase: "waitUntil", ...audit }),
		);
		this.#pending.add(tracked);
		tracked.finally(() => this.#pending.delete(tracked));
	}

	#dispatchConnect = async (meta) => {
		const requestId = ++this.#nextRequestId;
		const audit = hasDiagnosticSubscribers(
			diagnosticChannels.connectStart,
			diagnosticChannels.connectEnd,
		)
			? {
					server: this,
					serverId: this.#serverId,
					requestId,
					...meta,
					startedAt: Date.now(),
				}
			: null;
		if (audit !== null) {
			publishDiagnostic(diagnosticChannels.connectStart, audit);
		}
		if (this.#busy || this.#state === "closing" || this.#state === "closed") {
			const response = new Response("Service Unavailable", {
				status: 503,
				headers: { "retry-after": "1" },
			});
			this.#publishConnectEnd(audit, response, "busy");
			return response;
		}
		if (typeof this.#handler.connect !== "function") {
			this.#publishConnectEnd(audit, null, "unsupported");
			return null;
		}
		try {
			const result = await this.#handler.connect(meta);
			this.#publishConnectEnd(audit, result, "result");
			return result;
		} catch (error) {
			this.#report(error, { phase: "connect", requestId, ...meta });
			const response = new Response("Bad Gateway", { status: 502 });
			this.#publishConnectEnd(audit, response, "handler-error");
			return response;
		}
	};

	#publishConnectEnd(audit, result, outcome) {
		if (audit === null) return;
		publishDiagnostic(diagnosticChannels.connectEnd, {
			...audit,
			result,
			status: result instanceof Response ? result.status : null,
			outcome,
			duration: Date.now() - audit.startedAt,
		});
	}

	#report(error, metadata) {
		publishDiagnostic(diagnosticChannels.error, {
			server: this,
			serverId: this.#serverId,
			error,
			metadata,
			timestamp: Date.now(),
		});
		if (this.#onError === null) return;
		try {
			this.#onError(error, metadata);
		} catch {
			// Error hooks must never crash the server.
		}
	}

	async #doListen(listenOptions) {
		this.#binding = true;
		try {
			const server = await this.#bind(listenOptions);
			if (this.#state === "binding") this.#state = "listening";
			return server;
		} catch (error) {
			if (this.#state === "binding") {
				this.#report(error, { phase: "startup" });
				this.#state = "closed";
				this.#removeAbortListener();
				publishDiagnostic(diagnosticChannels.serverClose, {
					server: this,
					serverId: this.#serverId,
					force: true,
					error,
					timestamp: Date.now(),
				});
				this.#closedResolve();
			}
			throw error;
		} finally {
			this.#binding = false;
		}
	}

	async #bind(listenOptions) {
		const merged = { ...this.#baseOptions, ...listenOptions };
		validateOptions(merged);
		this.#hostname = merged.hostname ?? "127.0.0.1";
		this.#requestedPort = merged.port ?? 3000;
		this.#tls = merged.tls ?? null;
		this.#quic = merged.quic ?? false;
		this.#alpn = merged.tls?.alpn ?? DEFAULT_ALPN;
		this.#applyBehavior(merged);
		this.#signal = merged.signal ?? null;
		if (this.#signal !== null) {
			this.#abortListener = () => this.close();
			this.#signal.addEventListener("abort", this.#abortListener, {
				once: true,
			});
		}

		const h1 = this.#tls ? this.#alpn.includes("h1") : true;
		const h2 = this.#tls ? this.#alpn.includes("h2") : true;
		const h3 = Boolean(this.#quic) && this.#tls !== null && h3Available();
		if (!h1 && !h2) {
			throw new Error("at least one of h1/h2 must be enabled");
		}

		if (h2) {
			this.#h2 = createH2Bridge(this.#dispatch, this.#shared, {
				connect: this.#connect,
				timeouts: this.#timeouts,
				limits: this.#limits,
				onError: (error, metadata) => this.#report(error, metadata),
				onReject: this.#auditReject,
			});
			this.#h2.on("session", (session) => {
				this.#sessions.add(session);
				session.on("close", () => this.#sessions.delete(session));
				// Inactivity timeout: an idle h2 session (no frames either way)
				// is closed gracefully; active streams reset the timer.
				if (this.#timeouts.keepAliveTimeout > 0) {
					session.setTimeout(this.#timeouts.keepAliveTimeout, () =>
						session.close(),
					);
				}
			});
		}

		if (this.#tls) {
			this.#tcp = tls.createServer({
				key: this.#tls.key,
				cert: this.#tls.cert,
				ALPNProtocols: this.#alpn.map((protocol) =>
					protocol === "h1" ? "http/1.1" : protocol,
				),
				handshakeTimeout: this.#timeouts.tlsHandshakeTimeout || undefined,
			});
			this.#tcp.on("secureConnection", (socket) => {
				this.#onTlsSocket(socket, h1);
			});
			// Track raw sockets too so close() can drop mid-handshake clients.
			this.#tcp.on("connection", (socket) => {
				this.#track(socket);
			});
			// TLS handshake failures (bad ALPN, cert rejects) must not crash.
			this.#tcp.on("tlsClientError", (error, socket) => {
				this.#report(error, { phase: "tls-handshake" });
				socket.destroy();
			});
		} else {
			this.#tcp = net.createServer((socket) =>
				this.#onPlainSocket(socket, h1, h2),
			);
		}
		if (this.#limits.maxConnections > 0) {
			this.#tcp.maxConnections = this.#limits.maxConnections;
			this.#tcp.dropMaxConnection = true;
		}

		await new Promise((resolve, reject) => {
			this.#tcp.once("error", reject);
			this.#tcp.listen(this.#requestedPort, this.hostname, resolve);
		});
		this.#port = this.#tcp.address().port;

		const activeProtocols = [];
		if (h1) activeProtocols.push("h1");
		if (h2) activeProtocols.push("h2");

		if (h3) {
			try {
				this.#h3 = await createH3Endpoint(this.#dispatch, {
					host: this.hostname,
					port: this.port,
					tls: this.#tls,
					connect: this.#connect,
					timeouts: this.#timeouts,
					limits: this.#limits,
					onError: (error, metadata) => this.#report(error, metadata),
					onReject: this.#auditReject,
				});
				this.#shared.altSvc = `h3=":${this.port}"; ma=86400`;
				activeProtocols.push("h3");
			} catch (error) {
				this.#report(error, { phase: "startup", protocol: "h3" });
				await this.close({ force: true, timeout: 0 });
				throw error;
			}
		}
		this.#protocols = Object.freeze(activeProtocols);
		publishDiagnostic(diagnosticChannels.serverListening, {
			server: this,
			serverId: this.#serverId,
			address: this.address(),
			protocols: this.#protocols,
			timestamp: Date.now(),
		});
		// If the signal fired while we were binding, honor it now.
		if (this.#signal?.aborted) await this.close();
		return this;
	}

	#track(socket) {
		this.#sockets.add(socket);
		socket.on("close", () => this.#sockets.delete(socket));
		// Routed backends attach their own error handling; this stops
		// pre-route errors (e.g. immediate resets) from crashing.
		socket.on("error", () => {});
	}

	#onTlsSocket(socket, h1) {
		this.#track(socket);
		if (socket.alpnProtocol === "h2") {
			this.#h2.emit("connection", socket);
		} else if (h1) {
			this.#h1Connection(socket, "https");
		} else {
			socket.destroy();
		}
	}

	#onPlainSocket(socket, h1, h2) {
		this.#track(socket);
		if (!h2) {
			this.#h1Connection(socket);
			return;
		}
		// h2c prior knowledge: sniff the 24-byte connection preface. Anything
		// that diverges from it is routed to h1 immediately.
		let buf = null;
		const detectionTimer =
			this.#timeouts.headersTimeout > 0
				? setTimeout(() => socket.destroy(), this.#timeouts.headersTimeout)
				: null;
		detectionTimer?.unref?.();
		const route = (isH2) => {
			if (detectionTimer !== null) clearTimeout(detectionTimer);
			socket.pause();
			socket.off("data", onData);
			socket.off("end", onEnd);
			if (isH2) {
				// The HTTP/2 backend reads from the socket's underlying handle
				// directly, so bytes already consumed by the sniff (unshift
				// included) would never reach it ("bad client magic"). A Duplex
				// wrapper replays the buffered bytes and relays the rest.
				this.#h2.emit("connection", replayStream(socket, buf));
				socket.resume();
			} else if (h1) {
				if (buf !== null && buf.length > 0) socket.unshift(buf);
				this.#h1Connection(socket);
				socket.resume();
			} else {
				socket.destroy();
			}
		};
		const onData = (chunk) => {
			buf = buf === null ? chunk : Buffer.concat([buf, chunk]);
			const n = Math.min(buf.length, H2_PREFACE.length);
			if (!H2_PREFACE.subarray(0, n).equals(buf.subarray(0, n))) {
				route(false);
			} else if (buf.length >= H2_PREFACE.length) {
				route(true);
			}
		};
		const onEnd = () => socket.destroy();
		socket.on("data", onData);
		socket.once("end", onEnd);
	}

	#h1Connection(socket, scheme = "http") {
		const connection = new H1Connection(socket, this.#dispatch, {
			scheme,
			altSvc: this.#shared.altSvc,
			timeouts: this.#timeouts,
			limits: this.#limits,
			connect: this.#connect,
			onReject: this.#auditReject,
			onFinished: () => this.#connections.delete(connection),
		});
		this.#connections.add(connection);
	}

	/**
	 * Stop accepting connections and shut down gracefully: idle connections
	 * close immediately, in-flight exchanges finish first (h1 pipelines drain
	 * their current entry, h2 sessions close after their active streams end),
	 * and `waitUntil()` promises are awaited. `{force: true}` destroys
	 * everything on the spot.
	 */
	async close({
		force = false,
		timeout = this.#timeouts.shutdownTimeout,
	} = {}) {
		if (this.#state === "created") this.#state = "closing";
		else if (this.#state !== "closed") this.#state = "closing";
		if (force) this.#forceClose();
		if (this.#closePromise !== null) return this.#closePromise;
		this.#closePromise = this.#close({ force, timeout });
		return this.#closePromise;
	}

	/**
	 * Terminate immediately: no GOAWAY, in-flight requests aborted,
	 * `waitUntil()` promises ignored. Returns synchronously; `closed` resolves
	 * once teardown finishes.
	 */
	destroy(error) {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#state = "closing";
		if (error !== undefined) this.#report(error, { phase: "destroy" });
		if (this.#closePromise === null) {
			this.#closePromise = this.#close({ force: true, timeout: 0 });
		} else {
			this.#forceClose();
		}
		this.#closePromise.catch(() => {});
	}

	async #close({ force, timeout }) {
		// A listen may still be in flight (one-step serve); let it settle so we
		// tear down a fully-built server, not a half-built one. Skip while we are
		// mid-bind (close() called from within listen on h3 rollback / abort),
		// where awaiting our own listen promise would deadlock.
		if (this.#listening !== null && !this.#binding) {
			await this.#listening.catch(() => {});
		}
		const pending = [];
		if (this.#tcp) {
			pending.push(new Promise((resolve) => this.#tcp.close(() => resolve())));
		}
		if (this.#h2) this.#h2.close();
		if (this.#h3) pending.push(this.#h3.close({ force }));
		if (force) {
			this.#forceClose();
		} else {
			for (const connection of this.#connections) connection.initiateClose();
			for (const session of this.#sessions) session.close();
			pending.push(this.#drainBackends());
		}
		if (!force && timeout > 0) {
			let timer;
			const deadline = new Promise((resolve) => {
				timer = setTimeout(() => {
					this.#forceClose();
					resolve();
				}, timeout);
				timer.unref?.();
			});
			await Promise.race([Promise.all(pending), deadline]);
			clearTimeout(timer);
		}
		await Promise.all(pending);
		this.#removeAbortListener();
		this.#state = "closed";
		publishDiagnostic(diagnosticChannels.serverClose, {
			server: this,
			serverId: this.#serverId,
			force,
			timestamp: Date.now(),
		});
		this.#closedResolve();
	}

	#removeAbortListener() {
		if (this.#signal !== null && this.#abortListener !== null) {
			this.#signal.removeEventListener("abort", this.#abortListener);
		}
		this.#abortListener = null;
		this.#signal = null;
	}

	#forceClose() {
		for (const socket of this.#sockets) socket.destroy();
		for (const session of this.#sessions) session.destroy();
		this.#h3?.destroy();
	}

	/**
	 * Wait until every h1 connection and h2 session has finished (both sets
	 * self-clean on close) and every waitUntil() promise settles, then drop
	 * sockets that never reached a backend (mid-sniff plaintext, TLS
	 * mid-handshake). Like node's server.close(), this waits indefinitely for a
	 * stuck handler; close({force: true}) is the escape hatch.
	 */
	async #drainBackends() {
		while (this.#connections.size > 0 || this.#sessions.size > 0) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		if (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
		for (const socket of this.#sockets) socket.destroy();
	}

	async [Symbol.asyncDispose]() {
		await this.close();
	}
}

function validateHandler(handler) {
	if (handler === null || typeof handler !== "object") {
		throw new TypeError("handler must be an object with a fetch() method");
	}
	const version = handler[kServerProtocol];
	if (version !== undefined && version !== 1) {
		throw new TypeError(
			`unsupported server.protocol version: ${String(version)}`,
		);
	}
	if (typeof handler.fetch !== "function") {
		throw new TypeError("handler.fetch must be a function");
	}
	if (handler.connect !== undefined && typeof handler.connect !== "function") {
		throw new TypeError("handler.connect must be a function");
	}
}

function validateOptions(options) {
	if (
		options === null ||
		typeof options !== "object" ||
		Array.isArray(options)
	) {
		throw new TypeError("options must be an object");
	}
	if (
		options.port !== undefined &&
		(!Number.isInteger(options.port) ||
			options.port < 0 ||
			options.port > 65_535)
	) {
		throw new RangeError("port must be an integer between 0 and 65535");
	}
	if (
		options.hostname !== undefined &&
		(typeof options.hostname !== "string" || options.hostname.length === 0)
	) {
		throw new TypeError("hostname must be a non-empty string");
	}
	if (options.tls !== undefined) {
		if (
			options.tls === null ||
			typeof options.tls !== "object" ||
			options.tls.key === undefined ||
			options.tls.cert === undefined
		) {
			throw new TypeError("tls must contain key and cert");
		}
		if (options.tls.alpn !== undefined) {
			if (!Array.isArray(options.tls.alpn) || options.tls.alpn.length === 0) {
				throw new TypeError("tls.alpn must be a non-empty array");
			}
			for (const protocol of options.tls.alpn) {
				if (protocol !== "h2" && protocol !== "h1") {
					throw new RangeError(`unsupported ALPN protocol: ${protocol}`);
				}
			}
		}
	}
	if (options.quic !== undefined && typeof options.quic !== "boolean") {
		throw new TypeError("quic must be a boolean");
	}
	if (options.quic && options.tls === undefined) {
		throw new TypeError("HTTP/3 (quic) requires TLS");
	}
	if (options.signal !== undefined) {
		const signal = options.signal;
		if (
			signal === null ||
			typeof signal !== "object" ||
			typeof signal.addEventListener !== "function" ||
			typeof signal.aborted !== "boolean"
		) {
			throw new TypeError("signal must be an AbortSignal");
		}
	}
	for (const name of [
		"keepAliveTimeout",
		"headersTimeout",
		"requestTimeout",
		"tlsHandshakeTimeout",
		"shutdownTimeout",
		"maxHeaderSize",
		"maxRequestBodySize",
	]) {
		const value = options[name];
		if (
			value !== undefined &&
			(typeof value !== "number" || !Number.isFinite(value) || value < 0)
		) {
			throw new RangeError(`${name} must be a non-negative finite number`);
		}
	}
	for (const name of ["maxConnections", "maxConcurrentStreams"]) {
		const value = options[name];
		if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
			throw new RangeError(`${name} must be a positive integer`);
		}
	}
	if (options.onError !== undefined && typeof options.onError !== "function") {
		throw new TypeError("onError must be a function");
	}
}

/**
 * Duplex facade over a socket whose first bytes were already consumed by the
 * h2c sniff: replays the buffered bytes, then relays live socket data.
 * Connection metadata is mirrored so the HTTP/2 session exposes it.
 */
function replayStream(socket, buffered) {
	const wrapper = new Duplex({
		read() {
			socket.resume();
		},
		write(chunk, encoding, callback) {
			socket.write(chunk, encoding, callback);
		},
		final(callback) {
			socket.end(callback);
		},
		destroy(err, callback) {
			socket.destroy();
			callback(err);
		},
	});
	wrapper.remoteAddress = socket.remoteAddress;
	wrapper.remotePort = socket.remotePort;
	wrapper.remoteFamily = socket.remoteFamily;
	wrapper.localAddress = socket.localAddress;
	wrapper.localPort = socket.localPort;
	if (buffered !== null && buffered.length > 0) wrapper.push(buffered);
	socket.on("data", (chunk) => {
		if (!wrapper.push(chunk)) socket.pause();
	});
	socket.on("end", () => wrapper.push(null));
	socket.on("error", (err) => wrapper.destroy(err));
	socket.on("close", () => wrapper.destroy());
	return wrapper;
}
