export type Protocol = "h1" | "h2" | "h3";

export declare const diagnosticChannels: Readonly<{
	serverListening: "blockhaus.server.listening";
	serverClose: "blockhaus.server.close";
	requestStart: "blockhaus.request.start";
	requestEnd: "blockhaus.request.end";
	requestReject: "blockhaus.request.reject";
	connectStart: "blockhaus.connect.start";
	connectEnd: "blockhaus.connect.end";
	error: "blockhaus.error";
}>;

/** ALPN identifiers offered on TLS. */
export type Alpn = "h2" | "h1";

export interface TlsOptions {
	key: string | Uint8Array;
	cert: string | Uint8Array;
	/** Restrict the offered server protocols (subset of ['h2', 'h1']). */
	alpn?: Alpn[];
}

export interface ServeOptions {
	port?: number;
	hostname?: string;
	tls?: TlsOptions;
	/** Enable HTTP/3. Requires `tls`; best-effort when the binary lacks QUIC. */
	quic?: boolean;
	/** Closes the server when aborted. */
	signal?: AbortSignal;
	/** Idle connection timeout in milliseconds. Set to 0 to disable. */
	keepAliveTimeout?: number;
	/** Time allowed to receive HTTP/1.1 headers, in milliseconds. Set to 0 to disable. */
	headersTimeout?: number;
	/** Time allowed for an HTTP/1.1 exchange, in milliseconds. Set to 0 to disable. */
	requestTimeout?: number;
	/** Time allowed to complete the TLS handshake, in milliseconds. Set to 0 to disable. */
	tlsHandshakeTimeout?: number;
	/** Grace period for graceful close before forcing, in milliseconds. Set to 0 to disable. */
	shutdownTimeout?: number;
	maxConnections?: number;
	maxConcurrentStreams?: number;
	maxHeaderSize?: number;
	maxRequestBodySize?: number;
	onError?: (error: unknown, metadata: Record<string, unknown>) => void;
}

export interface SocketAddress {
	address: string;
	port: number | null;
	family: string | null;
}

/**
 * Reason accepted by {@link ServerContext.deny}. Defaults to `'rejected'`,
 * which is retry-safe. Anything unrecognized falls back to `'rejected'`.
 */
export type DenyReason =
	| "rejected"
	| "cancelled"
	| "internal"
	| "connect"
	| "goaway";

/** The processing environment for one request, passed to `fetch()`. */
export interface ServerContext {
	/** The incoming request, a standard Fetch Request. */
	readonly request: Request;
	/** Request URL without constructing the Fetch Request. */
	readonly url: string;
	/** Request method without constructing the Fetch Request. */
	readonly method: string;
	/** Read a request header without constructing the Fetch Request. */
	header(name: string): string | null;
	/** The client's socket address. */
	readonly remoteAddress: SocketAddress;
	/** Convenience: the HTTP version that carried the request. */
	readonly httpVersion: "1.1" | "2" | "3";
	/** Negotiated ALPN id, or null on plaintext. */
	readonly alpnProtocol: string | null;
	/** Aborts if the client goes away before the response completes. */
	readonly signal: AbortSignal;
	/** Request trailers, available after the request body completes. */
	readonly trailers: Promise<Headers>;
	/** True once `deny()` has been called. */
	readonly denied: boolean;
	/** Send an interim 1xx response; discarded on protocols that lack support. */
	sendInformational(status: number, headers?: HeadersInit): void;
	/** Reject the request by resetting the stream (no response sent). */
	deny(reason?: DenyReason): void;
	/** Keep the server alive until `promise` settles; awaited on graceful close. */
	waitUntil(promise: Promise<unknown>): void;
}

/** Low-level metadata passed to a handler's optional `connect()` method. */
export interface ConnectContext {
	readonly authority: string;
	readonly headers: Headers;
	readonly remoteAddress: SocketAddress;
	readonly httpVersion: "1.1" | "2" | "3";
	readonly alpnProtocol: string | null;
	readonly signal: AbortSignal;
}

export type FetchHandler = (
	context: ServerContext,
) => Response | undefined | Promise<Response | undefined>;

export type ConnectHandler = (
	context: ConnectContext,
) =>
	| import("node:stream").Duplex
	| Response
	| null
	| Promise<import("node:stream").Duplex | Response | null>;

/**
 * A handler object. Optionally tag it `[Symbol.for('server.protocol')]: 1`
 * so a runtime can detect the version.
 */
export interface Handler {
	[key: symbol]: unknown;
	fetch: FetchHandler;
	connect?: ConnectHandler;
}

export class Context implements ServerContext {
	constructor(request: Request, metadata: Record<string, unknown>);
	readonly request: Request;
	readonly url: string;
	readonly method: string;
	header(name: string): string | null;
	readonly remoteAddress: SocketAddress;
	readonly httpVersion: "1.1" | "2" | "3";
	readonly alpnProtocol: string | null;
	readonly signal: AbortSignal;
	readonly trailers: Promise<Headers>;
	readonly denied: boolean;
	sendInformational(status: number, headers?: HeadersInit): void;
	deny(reason?: DenyReason): void;
	waitUntil(promise: Promise<unknown>): void;
}

export class Server implements AsyncDisposable {
	constructor(handler: Handler, options?: ServeOptions);
	readonly port: number | null;
	readonly hostname: string;
	readonly url: string;
	readonly protocols: Protocol[];
	address(): import("node:net").AddressInfo | string | null;
	/** Resolves once the server is fully closed. */
	readonly closed: Promise<void>;
	/** When true, new requests get a retryable 503; in-flight requests continue. */
	busy: boolean;
	/** Bind and start serving; idempotent. Resolves once bound. */
	listen(options?: ServeOptions): Promise<Server>;
	/** Graceful shutdown: finish in-flight exchanges, await waitUntil promises. */
	close(options?: { force?: boolean; timeout?: number }): Promise<void>;
	/** Immediate termination: abort in-flight requests, ignore waitUntil. */
	destroy(error?: unknown): void;
	[Symbol.asyncDispose](): Promise<void>;
}

/**
 * Create a server. Synchronous: returns the Server immediately. Passing
 * connection options starts listening at once (await `server.listen()` for
 * readiness); omit them and call `server.listen(options)` yourself.
 */
export function serve(handler: Handler, options?: ServeOptions): Server;

export function withTrailers(response: Response, values: HeadersInit): Response;
export function withTrailers(
	response: Response,
	names: string[],
	provider:
		| HeadersInit
		| Promise<HeadersInit>
		| (() => HeadersInit | Promise<HeadersInit>),
): Response;
