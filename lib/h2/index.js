import http2 from "node:http2";
import { Duplex } from "node:stream";
import { getResponseTrailers, trailersToObject } from "../trailers.js";

const { NGHTTP2_FLAG_END_STREAM } = http2.constants;

/** ctx.deny() reasons mapped to HTTP/2 stream-reset codes. */
const RESET_CODE = {
	rejected: http2.constants.NGHTTP2_REFUSED_STREAM,
	cancelled: http2.constants.NGHTTP2_CANCEL,
	internal: http2.constants.NGHTTP2_INTERNAL_ERROR,
	connect: http2.constants.NGHTTP2_CONNECT_ERROR,
};

/**
 * HTTP/2 backend: a cleartext HTTP/2 server that never listens on its own.
 * Sockets are injected via `server.emit('connection', socket)`:
 *
 *  - TLS + ALPN 'h2': the decrypted socket is injected as-is; the HTTP/2 layer
 *    only reads and writes the stream, so TLS termination stays in the shared
 *    listener.
 *  - h2c prior knowledge: plaintext sockets whose first bytes match the
 *    connection preface are routed here by the shared listener.
 *
 * @param {(request: Request, meta: object) => Promise<Response>} dispatch
 * @param {{altSvc: string|null}} shared mutable: the server sets altSvc once
 *   the h3 endpoint is live, so it is read per-stream, not captured here
 * @returns {import('node:http2').Http2Server}
 */
export function createH2Bridge(
	dispatch,
	shared = { altSvc: null },
	{
		connect = null,
		timeouts,
		limits,
		onError = () => {},
		onReject = () => {},
	} = {},
) {
	// The server passes null when the handler has no connect() method.
	const connectFn = typeof connect === "function" ? connect : async () => null;
	const server = http2.createServer({
		settings: {
			maxConcurrentStreams: limits.maxConcurrentStreams,
			maxHeaderListSize: limits.maxHeaderSize,
		},
		maxHeaderListPairs: 128,
	});

	server.on("stream", (stream, headers, flags) => {
		// Closing a stream with an error code (ctx.deny) or a peer reset can
		// surface as an 'error' event on the stream itself; without a listener
		// that would crash the process.
		stream.on("error", (error) =>
			onError(error, { phase: "stream", protocol: "h2" }),
		);
		handleStream(stream, headers, flags, dispatch, shared.altSvc, {
			connect: connectFn,
			timeouts,
			limits,
			onReject,
		}).catch((error) => {
			onError(error, { phase: "stream", protocol: "h2" });
			if (!stream.destroyed) stream.destroy();
		});
	});
	// Injected sockets can error before/after session setup; without these
	// handlers a client reset would crash the process.
	server.on("sessionError", (error) =>
		onError(error, { phase: "session", protocol: "h2" }),
	);
	server.on("clientError", (error, socket) => {
		onError(error, { phase: "client", protocol: "h2" });
		socket.destroy();
	});

	return server;
}

async function handleStream(
	stream,
	headers,
	flags,
	dispatch,
	altSvc,
	{ connect, timeouts, limits, onReject },
) {
	const method = headers[":method"] ?? "GET";
	const scheme = headers[":scheme"] ?? "https";
	const authority = headers[":authority"] ?? headers.host ?? "localhost";
	const path = headers[":path"] ?? "/";

	const plain = new Headers();
	let headerBytes = 0;
	for (const [name, value] of Object.entries(headers)) {
		if (name.startsWith(":")) continue;
		if (Array.isArray(value)) {
			for (const v of value) {
				plain.append(name, v);
				headerBytes += Buffer.byteLength(name) + Buffer.byteLength(v) + 4;
			}
		} else if (value !== undefined) {
			plain.append(name, value);
			headerBytes +=
				Buffer.byteLength(name) + Buffer.byteLength(String(value)) + 4;
		}
	}
	if (limits.maxHeaderSize > 0 && headerBytes > limits.maxHeaderSize) {
		onReject({ protocol: "2", status: 431, reason: "headers too large" });
		stream.respond({ ":status": 431 }, { endStream: true });
		return;
	}

	if (method === "CONNECT") {
		await handleConnect(stream, headers, plain, connect, timeouts);
		return;
	}

	const endStream = (flags & NGHTTP2_FLAG_END_STREAM) !== 0;
	const bodyless = method === "GET" || method === "HEAD";
	const abort = new AbortController();
	const trailers = Promise.withResolvers();
	if (endStream) trailers.resolve(new Headers());
	stream.on("trailers", (values) => trailers.resolve(toHeaders(values)));
	let bodyTooLarge = false;
	let body;
	const contentLength = Number(headers["content-length"] ?? 0);
	if (
		limits.maxRequestBodySize > 0 &&
		Number.isFinite(contentLength) &&
		contentLength > limits.maxRequestBodySize
	) {
		onReject({ protocol: "2", status: 413, reason: "body too large" });
		stream.respond({ ":status": 413 }, { endStream: true });
		return;
	}
	if (!endStream && !bodyless) {
		body = requestBody(stream, limits.maxRequestBodySize, trailers, () => {
			onReject({ protocol: "2", status: 413, reason: "body too large" });
			bodyTooLarge = true;
			abort.abort(new Error("request body too large"));
			if (!stream.destroyed && !stream.headersSent) {
				stream.respond({ ":status": 413 }, { endStream: true });
			} else if (!stream.destroyed) {
				stream.close(http2.constants.NGHTTP2_CANCEL);
			}
		});
	} else if (!endStream) {
		// GET/HEAD bodies are not exposed through Fetch, but must still be read so
		// they cannot consume the session flow-control window indefinitely.
		requestBody(stream, limits.maxRequestBodySize, trailers, () => {
			onReject({ protocol: "2", status: 413, reason: "body too large" });
			bodyTooLarge = true;
			abort.abort(new Error("request body too large"));
			if (!stream.destroyed && !stream.headersSent) {
				stream.respond({ ":status": 413 }, { endStream: true });
			} else if (!stream.destroyed) {
				stream.close(http2.constants.NGHTTP2_CANCEL);
			}
		})
			.cancel()
			.catch(() => {});
	}

	const request = new Request(`${scheme}://${authority}${path}`, {
		method,
		headers: plain,
		body,
		...(body ? { duplex: "half" } : {}),
	});

	// Aborts when the stream dies before the response finished: client RST,
	// session teardown, network error. rstCode 0 (NO_ERROR) still means the
	// client walked away if we had not finished responding.
	let responded = false;
	stream.on("close", () => {
		if (!responded) abort.abort();
	});
	let timer = null;
	if (timeouts.requestTimeout > 0) {
		timer = setTimeout(() => {
			abort.abort(new Error("request timed out"));
			if (!stream.destroyed && !stream.headersSent) {
				stream.respond({ ":status": 408 }, { endStream: true });
			} else if (!stream.destroyed) {
				stream.close(http2.constants.NGHTTP2_CANCEL);
			}
		}, timeouts.requestTimeout);
		timer.unref?.();
	}
	stream.once("close", () => {
		if (timer !== null) clearTimeout(timer);
	});

	const socket = stream.session?.socket;
	const sendInformational = (status, headers) => {
		if (stream.destroyed || stream.headersSent) return;
		const info = { ":status": status };
		if (headers) {
			for (const [name, value] of new Headers(headers)) info[name] = value;
		}
		try {
			stream.additionalHeaders(info);
		} catch {
			// interim frames are best-effort
		}
	};
	const deny = (reason) => {
		if (stream.destroyed) return;
		if (reason === "goaway") {
			stream.session?.goaway?.(http2.constants.NGHTTP2_NO_ERROR);
		}
		stream.close(RESET_CODE[reason] ?? http2.constants.NGHTTP2_REFUSED_STREAM);
	};
	const response = await dispatch(request, {
		remoteAddress: {
			address: socket?.remoteAddress ?? "",
			port: socket?.remotePort ?? null,
			family: socket?.remoteFamily ?? null,
		},
		httpVersion: "2",
		alpnProtocol: socket?.alpnProtocol || null,
		signal: abort.signal,
		trailers: trailers.promise,
		sendInformational,
		deny,
	});
	if (request.body && response?.body !== request.body && !request.body.locked) {
		request.body.cancel().catch(() => {});
		await trailers.promise;
	}

	// deny() / no response: the stream was already reset via the deny callback.
	if (response === null) {
		if (request.body && !request.body.locked) {
			await request.body.cancel().catch(() => {});
		}
		return;
	}
	if (stream.destroyed || stream.headersSent || bodyTooLarge) return;

	const outHeaders = { ":status": response.status };
	const trailerMeta = getResponseTrailers(response);
	for (const [name, value] of response.headers) {
		if (name === "set-cookie") continue;
		if (HOP_BY_HOP.has(name)) continue;
		outHeaders[name] = value;
	}
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) outHeaders["set-cookie"] = cookies;
	if (altSvc !== null) outHeaders["alt-svc"] = altSvc;

	const omitBody =
		method === "HEAD" ||
		response.body === null ||
		response.status === 204 ||
		response.status === 205 ||
		response.status === 304;
	if (trailerMeta !== null && !omitBody) {
		stream.once("wantTrailers", async () => {
			try {
				stream.sendTrailers(trailersToObject(await trailerMeta.getValues()));
			} catch {
				if (!stream.destroyed) stream.destroy();
			}
		});
	}
	stream.respond(outHeaders, {
		endStream: omitBody,
		waitForTrailers: trailerMeta !== null && !omitBody,
	});
	if (omitBody) {
		responded = true;
		if (timer !== null) clearTimeout(timer);
		if (response.body) await response.body.cancel().catch(() => {});
		return;
	}

	for await (const chunk of response.body) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (buf.length === 0) continue;
		if (!stream.write(buf)) await drained(stream);
	}
	if (request.body) await trailers.promise;
	if (request.body && !request.body.locked) {
		await request.body.cancel().catch(() => {});
	}
	responded = true;
	if (timer !== null) clearTimeout(timer);
	stream.end();
}

function requestBody(stream, maxBytes, trailers, onExceeded) {
	let controller;
	let bytes = 0;
	let discarded = false;
	let ended = false;
	const onData = (chunk) => {
		bytes += chunk.byteLength;
		if (maxBytes > 0 && bytes > maxBytes) {
			onExceeded();
			discarded = true;
			try {
				controller?.error(new Error("request body too large"));
			} catch {}
			stream.resume();
			return;
		}
		if (!discarded) {
			controller.enqueue(new Uint8Array(chunk));
			if (controller.desiredSize <= 0) stream.pause();
		}
	};
	const onEnd = () => {
		ended = true;
		if (!discarded) {
			try {
				controller.close();
			} catch {}
		}
		// Node emits `trailers` before `end`; defer the empty fallback so a
		// trailing HEADERS callback queued in the same turn wins.
		setImmediate(() => trailers.resolve(new Headers()));
	};
	const onAborted = () => {
		if (ended || discarded) return;
		discarded = true;
		try {
			controller?.error(new Error("request body aborted"));
		} catch {}
		trailers.resolve(new Headers());
	};
	stream.on("data", onData);
	stream.once("end", onEnd);
	stream.once("aborted", onAborted);
	stream.once("close", onAborted);
	return new ReadableStream({
		start(value) {
			controller = value;
			if (!ended) stream.pause();
		},
		pull() {
			stream.resume();
		},
		cancel() {
			discarded = true;
			stream.resume();
		},
	});
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
			for (const item of value) headers.append(name, item);
		} else if (value !== undefined) {
			headers.append(name, String(value));
		}
	}
	return headers;
}

async function handleConnect(stream, headers, plain, connect, timeouts) {
	const abort = new AbortController();
	stream.once("close", () => abort.abort());
	let timer = null;
	if (timeouts.requestTimeout > 0) {
		timer = setTimeout(
			() => abort.abort(new Error("CONNECT timed out")),
			timeouts.requestTimeout,
		);
		timer.unref?.();
	}
	const socket = stream.session?.socket;
	const result = await connect({
		authority: headers[":authority"] ?? "",
		headers: plain,
		remoteAddress: {
			address: socket?.remoteAddress ?? "",
			port: socket?.remotePort ?? null,
			family: socket?.remoteFamily ?? null,
		},
		httpVersion: "2",
		alpnProtocol: socket?.alpnProtocol || null,
		signal: abort.signal,
	});
	if (timer !== null) clearTimeout(timer);
	if (stream.destroyed) {
		if (result instanceof Duplex) result.destroy();
		return;
	}
	if (result === null) {
		stream.respond({ ":status": 501 }, { endStream: true });
		return;
	}
	if (result instanceof Response) {
		const responseHeaders = { ":status": result.status };
		for (const [name, value] of result.headers) {
			if (name === "set-cookie" || HOP_BY_HOP.has(name)) continue;
			responseHeaders[name] = value;
		}
		const cookies = result.headers.getSetCookie();
		if (cookies.length > 0) responseHeaders["set-cookie"] = cookies;
		const endStream =
			result.body === null ||
			result.status === 204 ||
			result.status === 205 ||
			result.status === 304;
		stream.respond(responseHeaders, { endStream });
		if (endStream) {
			if (result.body) await result.body.cancel().catch(() => {});
			return;
		}
		for await (const chunk of result.body) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (buf.length > 0 && !stream.write(buf)) await drained(stream);
		}
		stream.end();
		return;
	}
	if (!(result instanceof Duplex)) {
		stream.respond({ ":status": 502 }, { endStream: true });
		return;
	}
	stream.respond({ ":status": 200 });
	stream.pipe(result).pipe(stream);
	const teardown = () => {
		if (!stream.destroyed) stream.destroy();
		if (!result.destroyed) result.destroy();
	};
	stream.once("error", teardown);
	result.once("error", teardown);
}

function drained(stream) {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			stream.off("drain", onDrain);
			stream.off("error", onError);
			stream.off("close", onClose);
		};
		const onDrain = () => {
			cleanup();
			resolve();
		};
		const onError = (err) => {
			cleanup();
			reject(err);
		};
		const onClose = () => {
			cleanup();
			reject(new Error("stream closed during response"));
		};
		stream.once("drain", onDrain);
		stream.once("error", onError);
		stream.once("close", onClose);
	});
}
