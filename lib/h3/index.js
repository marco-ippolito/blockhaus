import { createPrivateKey } from "node:crypto";
import { Duplex, Readable } from "node:stream";
import { getResponseTrailers, trailersToObject } from "../trailers.js";

/**
 * HTTP/3 backend: a thin adapter over the runtime's QUIC API.
 *
 * When the negotiated ALPN is 'h3', the runtime performs HTTP/3 framing and
 * header compression internally: requests surface as decoded header objects and
 * responses go out through `stream.sendHeaders()` and `stream.setBody()`. Raw
 * stream bytes are never exposed, so this backend ships no framing of its own.
 *
 * Behaviors this adapter relies on:
 *  - Request headers arrive via the `onheaders` callback after `onstream`
 *    fires; when the headers beat `onstream`, `stream.headers` is already
 *    populated. Both paths are handled.
 *  - `sendHeaders()` returns false before the request headers have been
 *    processed, so responding waits for them.
 *  - The stream async iterator yields Uint8Array batches, not single chunks.
 *
 * The QUIC API is experimental and present only on a build compiled and run
 * with QUIC support; `h3Available()` reflects that. Every QUIC-specific detail
 * stays inside this module.
 */
export function h3Available() {
	return process.features.quic === true;
}

/**
 * Start an HTTP/3 endpoint on UDP host:port.
 *
 * @param {(request: Request, meta: object) => Promise<Response>} dispatch
 * @param {{host: string, port: number, tls: {key: string|Buffer, cert: string|Buffer}}} opts
 * @returns {Promise<{close: () => Promise<void>}>}
 */
export async function createH3Endpoint(
	dispatch,
	{
		host,
		port,
		tls,
		connect,
		timeouts,
		limits,
		onError = () => {},
		onReject = () => {},
	},
) {
	const { listen } = await import("node:quic");
	const sessions = new Set();

	const endpoint = await listen(
		(session) => {
			sessions.add(session);
			session.closed.finally(() => sessions.delete(session)).catch(() => {});
			session.onerror = (error) =>
				onError(error, { phase: "session", protocol: "h3" });
			session.onstream = (stream) => {
				// Aborts when the stream dies before the response finished
				// (client reset, session teardown).
				const abort = new AbortController();
				const trailers = Promise.withResolvers();
				stream.onerror = (error) => {
					abort.abort(error);
					trailers.resolve(new Headers());
				};
				stream.onreset = (error) => {
					abort.abort(error);
					trailers.resolve(new Headers());
				};
				stream.ontrailers = (values) => trailers.resolve(toHeaders(values));
				const respond = (headers) => {
					handleStream(session, stream, headers, dispatch, abort, trailers, {
						connect,
						timeouts,
						limits,
						onReject,
					}).catch((error) => {
						onError(error, { phase: "stream", protocol: "h3" });
						if (!stream.destroyed) stream.destroy();
					});
				};
				if (stream.headers !== undefined) respond(stream.headers);
				else stream.onheaders = respond;
			};
		},
		{
			endpoint: {
				address: { address: host, port },
				maxConnectionsTotal: limits.maxConnections,
				maxConnectionsPerHost: limits.maxConnections,
			},
			alpn: "h3",
			enableEarlyData: false,
			transportParams: {
				initialMaxStreamsBidi: limits.maxConcurrentStreams,
			},
			application: {
				maxHeaderLength: limits.maxHeaderSize,
				maxFieldSectionSize: limits.maxHeaderSize,
				maxHeaderPairs: 128,
				enableConnectProtocol: connect !== null,
			},
			sni: {
				"*": {
					keys: createPrivateKey(tls.key),
					certs: Buffer.isBuffer(tls.cert) ? tls.cert : Buffer.from(tls.cert),
				},
			},
		},
	);

	return {
		async close({ force = false } = {}) {
			for (const session of sessions) {
				if (force) session.destroy();
				else session.close();
			}
			await endpoint.close();
			// endpoint.close() stops accepting datagrams but the experimental API
			// can leave an idle peer session open after its graceful close signal.
			for (const session of sessions) session.destroy();
		},
		destroy() {
			for (const session of sessions) session.destroy();
			endpoint.destroy();
		},
	};
}

/** Flatten the iterator's Uint8Array[] batches into byte chunks. */
async function* bodyChunks(stream, maxBytes, state, trailers, onExceeded) {
	try {
		for await (const batch of stream) {
			for (const chunk of batch) {
				state.bytes += chunk.byteLength;
				if (maxBytes > 0 && state.bytes > maxBytes) {
					state.tooLarge = true;
					onExceeded();
					throw new Error("request body too large");
				}
				yield chunk;
			}
		}
	} finally {
		// QUIC delivers trailing HEADERS immediately after the final DATA. Defer
		// the empty fallback one turn so ontrailers wins without waiting for the
		// bidirectional stream (including our response side) to close.
		setImmediate(() => trailers.resolve(new Headers()));
	}
}

async function handleStream(
	session,
	stream,
	h,
	dispatch,
	abort,
	trailers,
	{ connect, timeouts, limits, onReject },
) {
	const method = h[":method"] ?? "GET";
	const scheme = h[":scheme"] ?? "https";
	const authority = h[":authority"] ?? "localhost";
	const path = h[":path"] ?? "/";

	const headers = new Headers();
	let headerBytes = 0;
	for (const [name, value] of Object.entries(h)) {
		if (name.startsWith(":")) continue;
		if (Array.isArray(value)) {
			for (const v of value) {
				headers.append(name, v);
				headerBytes +=
					Buffer.byteLength(name) + Buffer.byteLength(String(v)) + 4;
			}
		} else if (value !== undefined) {
			headers.append(name, String(value));
			headerBytes +=
				Buffer.byteLength(name) + Buffer.byteLength(String(value)) + 4;
		}
	}
	if (limits.maxHeaderSize > 0 && headerBytes > limits.maxHeaderSize) {
		onReject({ protocol: "3", status: 431, reason: "headers too large" });
		stream.sendHeaders({ ":status": "431" }, { terminal: true });
		return;
	}

	if (method === "CONNECT") {
		if (connect === null) {
			stream.sendHeaders({ ":status": "501" }, { terminal: true });
			return;
		}
		await handleConnect(session, stream, h, headers, connect, abort, timeouts);
		return;
	}

	const bodyless = method === "GET" || method === "HEAD";
	const bodyState = { bytes: 0, tooLarge: false };
	const contentLength = Number(headers.get("content-length") ?? 0);
	if (
		limits.maxRequestBodySize > 0 &&
		Number.isFinite(contentLength) &&
		contentLength > limits.maxRequestBodySize
	) {
		onReject({ protocol: "3", status: 413, reason: "body too large" });
		stream.sendHeaders({ ":status": "413" }, { terminal: true });
		return;
	}
	const inboundBody = ReadableStream.from(
		bodyChunks(stream, limits.maxRequestBodySize, bodyState, trailers, () => {
			onReject({ protocol: "3", status: 413, reason: "body too large" });
			abort.abort(new Error("request body too large"));
			if (!stream.destroyed) {
				stream.sendHeaders({ ":status": "413" }, { terminal: true });
			}
		}),
	);
	const body = bodyless ? undefined : inboundBody;

	let request = null;
	let requestUrl = null;
	const getRequest = () => {
		requestUrl ??= `${scheme}://${authority}${path}`;
		request ??= new Request(requestUrl, {
			method,
			headers,
			body,
			...(body ? { duplex: "half" } : {}),
		});
		return request;
	};
	let committed = false;
	let timer = null;
	if (timeouts.requestTimeout > 0) {
		timer = setTimeout(() => {
			abort.abort(new Error("request timed out"));
			if (!stream.destroyed) {
				if (
					committed ||
					!stream.sendHeaders({ ":status": "408" }, { terminal: true })
				) {
					stream.destroy();
				}
			}
		}, timeouts.requestTimeout);
		timer.unref?.();
		stream.closed.finally(() => clearTimeout(timer)).catch(() => {});
	}

	// The QUIC backend exposes no interim-response or per-stream error-code
	// API, so sendInformational is omitted (silently discarded) and deny()
	// resets by destroying the stream.
	const deny = () => {
		if (!stream.destroyed) stream.destroy();
	};
	let response = dispatch(getRequest, {
		remoteAddress: session.remoteAddress,
		scheme,
		authority,
		path,
		method,
		requestHeaders: headers,
		httpVersion: "3",
		alpnProtocol: "h3",
		signal: abort.signal,
		trailers: trailers.promise,
		deny,
	});
	if (!(response instanceof Response)) response = await response;
	if (bodyless) {
		try {
			for await (const _chunk of inboundBody) {
				// GET/HEAD bodies are not exposed through Fetch, but still count
				// against limits and must be drained for QUIC flow control.
			}
		} catch {
			// bodyChunks already sent 413 and aborted the request.
		}
	}

	// deny() / no response: the stream was already reset via the deny callback.
	if (response === null) return;
	if (stream.destroyed || bodyState.tooLarge) return;

	// A handler is allowed to ignore the request body. Consume an unlocked body
	// before committing the response so streaming requests cannot bypass the
	// configured size limit and the peer is not left flow-control blocked.
	const requestBodyStream = request?.body ?? body;
	if (
		requestBodyStream &&
		response.body !== requestBodyStream &&
		!requestBodyStream.locked
	) {
		try {
			const reader = requestBodyStream.getReader();
			while (!(await reader.read()).done) {
				// bodyChunks performs accounting while this loop drains the stream.
			}
		} catch {
			// bodyChunks has already sent 413 and aborted when the limit was crossed.
		}
	}
	if (stream.destroyed || bodyState.tooLarge) return;

	const outHeaders = { ":status": String(response.status) };
	const trailerMeta = getResponseTrailers(response);
	response.headers.forEach((value, name) => {
		if (name === "set-cookie" || HOP_BY_HOP.has(name)) return;
		outHeaders[name] = value;
	});
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) outHeaders["set-cookie"] = cookies;

	const omitBody =
		method === "HEAD" ||
		response.body === null ||
		response.status === 204 ||
		response.status === 205 ||
		response.status === 304;

	if (!stream.sendHeaders(outHeaders, { terminal: omitBody })) {
		stream.destroy();
		return;
	}
	committed = true;
	if (omitBody) {
		if (timer !== null) clearTimeout(timer);
		if (response.body) await response.body.cancel().catch(() => {});
		return;
	}
	if (trailerMeta !== null) {
		try {
			// The QUIC API requires sendTrailers() to run synchronously inside
			// onwanttrailers, so resolve async providers before installing it.
			const values = trailersToObject(await trailerMeta.getValues());
			stream.onwanttrailers = () => stream.sendTrailers(values);
		} catch {
			if (!stream.destroyed) stream.destroy();
			return;
		}
	}
	// ReadableStream is an async iterable of Uint8Array: streams end-to-end.
	stream.setBody(response.body);
}

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"upgrade",
]);

function toHeaders(values) {
	const headers = new Headers();
	for (const [name, value] of Object.entries(values)) {
		if (name.startsWith(":")) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, String(item));
		} else if (value !== undefined) {
			headers.append(name, String(value));
		}
	}
	return headers;
}

async function handleConnect(
	session,
	stream,
	h,
	headers,
	connect,
	abort,
	timeouts,
) {
	let timer = null;
	if (timeouts.requestTimeout > 0) {
		timer = setTimeout(
			() => abort.abort(new Error("CONNECT timed out")),
			timeouts.requestTimeout,
		);
		timer.unref?.();
	}
	const result = await connect({
		authority: h[":authority"] ?? "",
		headers,
		remoteAddress: session.remoteAddress,
		httpVersion: "3",
		alpnProtocol: "h3",
		signal: abort.signal,
	});
	if (timer !== null) clearTimeout(timer);
	if (stream.destroyed) {
		if (result instanceof Duplex) result.destroy();
		return;
	}
	if (result === null) {
		stream.sendHeaders({ ":status": "501" }, { terminal: true });
		return;
	}
	if (result instanceof Response) {
		const responseHeaders = { ":status": String(result.status) };
		for (const [name, value] of result.headers) {
			if (name === "set-cookie" || HOP_BY_HOP.has(name)) continue;
			responseHeaders[name] = value;
		}
		const cookies = result.headers.getSetCookie();
		if (cookies.length > 0) responseHeaders["set-cookie"] = cookies;
		const terminal =
			result.body === null ||
			result.status === 204 ||
			result.status === 205 ||
			result.status === 304;
		if (!stream.sendHeaders(responseHeaders, { terminal })) {
			stream.destroy();
			return;
		}
		if (terminal) {
			if (result.body) await result.body.cancel().catch(() => {});
			return;
		}
		stream.setBody(result.body);
		return;
	}
	if (!(result instanceof Duplex)) {
		stream.sendHeaders({ ":status": "502" }, { terminal: true });
		return;
	}
	stream.sendHeaders({ ":status": "200" });
	stream.setBody(Readable.toWeb(result));
	try {
		for await (const batch of stream) {
			for (const chunk of batch) {
				if (!result.write(chunk)) await onceDrain(result);
			}
		}
		result.end();
	} catch (error) {
		result.destroy(error);
		throw error;
	}
}

function onceDrain(stream) {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			stream.off("drain", onDrain);
			stream.off("error", onError);
		};
		const onDrain = () => {
			cleanup();
			resolve();
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		stream.once("drain", onDrain);
		stream.once("error", onError);
	});
}
