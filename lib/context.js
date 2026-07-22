/**
 * Per-request context passed to the handler's `fetch()` method.
 *
 * The same shape is produced by every protocol backend, so a handler is
 * written once and runs unchanged over HTTP/1.1, HTTP/2 and HTTP/3:
 *
 *   serve({
 *     fetch(ctx) {
 *       return new Response(`hello ${ctx.remoteAddress.address}`);
 *     },
 *   });
 *
 * The request is a plain Fetch `Request`; connection metadata and server
 * capabilities live on the context rather than being grafted onto the request.
 */
export class Context {
	#request = null;
	#createRequest;
	#signal = null;
	#createSignal;
	#trailers = null;
	#createTrailers;
	/**
	 * @type {{address: string, port: number|null, family: string|null}}
	 * client socket address, e.g. `{ address: '192.0.2.1', port: 52341,
	 * family: 'IPv4' }`
	 */
	remoteAddress;
	/** @type {'1.1'|'2'|'3'} convenience: the HTTP version that carried it */
	httpVersion;
	/** @type {string|null} negotiated ALPN id ('http/1.1'|'h2'|'h3'), null on plaintext */
	alpnProtocol;
	/**
	 * Aborts when the client goes away before the response completes
	 * (disconnect, stream reset). Pass it to downstream work (fetch, DB
	 * queries) to stop doing work nobody will receive.
	 * @type {AbortSignal}
	 */
	get signal() {
		this.#signal ??= this.#createSignal();
		return this.#signal;
	}
	/** Request trailers, available after the request body completes. */
	get trailers() {
		this.#trailers ??= this.#createTrailers();
		return this.#trailers;
	}

	#sendInformational;
	#deny;
	#waitUntil;
	#denied = false;

	constructor(
		request,
		{
			remoteAddress,
			httpVersion,
			alpnProtocol = null,
			signal,
			trailers,
			sendInformational = null,
			deny = null,
			waitUntil = null,
		},
	) {
		this.#createRequest =
			typeof request === "function" ? request : () => request;
		this.remoteAddress = normalizeAddress(remoteAddress);
		this.httpVersion = httpVersion;
		this.alpnProtocol = alpnProtocol;
		this.#createSignal = typeof signal === "function" ? signal : () => signal;
		this.#createTrailers =
			typeof trailers === "function"
				? trailers
				: () => trailers ?? Promise.resolve(new Headers());
		this.#sendInformational = sendInformational;
		this.#deny = deny;
		this.#waitUntil = waitUntil;
	}

	/** The incoming request. Constructed on first access. */
	get request() {
		this.#request ??= this.#createRequest();
		return this.#request;
	}

	/** True once `deny()` has been called (read-only). */
	get denied() {
		return this.#denied;
	}

	/**
	 * Send an interim 1xx response (e.g. `103` Early Hints) before the final
	 * response. Valid on protocols that support it; silently discarded on the
	 * rest (per the draft spec). Throws if `status` is outside 100-199 or if a
	 * final response has already been committed is handled downstream (no-op).
	 */
	sendInformational(status, headers) {
		if (!Number.isInteger(status) || status < 100 || status > 199) {
			throw new RangeError(
				"informational status code must be an integer in the range 100-199",
			);
		}
		if (status === 101) {
			throw new RangeError(
				"101 Switching Protocols requires an upgrade handler",
			);
		}
		if (this.#denied) return;
		this.#sendInformational?.(status, headers);
	}

	/**
	 * Reject the request without a response by resetting the stream. The reason
	 * selects the reset semantics; the default `'rejected'` is retry-safe, so
	 * the client may resend even a non-idempotent request.
	 *
	 * Reasons: `'rejected'`, `'cancelled'`, `'internal'`, `'connect'`,
	 * `'goaway'`. On HTTP/1.1, which has no per-request reset, the connection is
	 * dropped instead.
	 */
	deny(reason = "rejected") {
		if (this.#denied) return;
		this.#denied = true;
		this.#deny?.(resetReason(reason));
	}

	/**
	 * Extend the request's lifetime past the handler's return: the server keeps
	 * running until `promise` settles, and awaits it during graceful shutdown.
	 * Rejections are routed to the server's error hook, never thrown at the
	 * client.
	 */
	waitUntil(promise) {
		this.#waitUntil?.(promise);
	}
}

/** Normalize a backend-supplied address into a stable SocketAddress shape. */
function normalizeAddress(addr) {
	if (addr !== null && typeof addr === "object") {
		return {
			address: addr.address ?? "",
			port: addr.port ?? null,
			family: addr.family ?? null,
		};
	}
	return { address: addr ?? "", port: null, family: null };
}

const RESET_REASONS = new Set([
	"rejected",
	"cancelled",
	"internal",
	"connect",
	"goaway",
]);

/** Validate a deny reason; anything unknown falls back to the retry-safe reset. */
function resetReason(reason) {
	return RESET_REASONS.has(reason) ? reason : "rejected";
}
