import { STATUS_CODES } from "node:http";
import { getResponseTrailers } from "../trailers.js";

const NO_BODY_STATUS = new Set([204, 205, 304]);
const MAX_SAFE_DIV_10 = Math.floor(Number.MAX_SAFE_INTEGER / 10);
const MAX_SAFE_MOD_10 = Number.MAX_SAFE_INTEGER % 10;
let cachedDateSecond = -1;
let cachedDate = "";

function dateHeader() {
	const now = Date.now();
	const second = Math.floor(now / 1_000);
	if (second !== cachedDateSecond) {
		cachedDateSecond = second;
		cachedDate = new Date(now).toUTCString();
	}
	return cachedDate;
}

function parseContentLength(value) {
	if (value.length === 0 || (value.length > 1 && value.charCodeAt(0) === 48)) {
		throw new TypeError("invalid response content-length");
	}
	let length = 0;
	for (let i = 0; i < value.length; i++) {
		const digit = value.charCodeAt(i) - 48;
		if (digit < 0 || digit > 9) {
			throw new TypeError("invalid response content-length");
		}
		if (
			length > MAX_SAFE_DIV_10 ||
			(length === MAX_SAFE_DIV_10 && digit > MAX_SAFE_MOD_10)
		) {
			throw new RangeError("response content-length is too large");
		}
		length = length * 10 + digit;
	}
	return length;
}

function drain(socket) {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			socket.off("drain", onDrain);
			socket.off("error", onError);
			socket.off("close", onClose);
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
			reject(new Error("socket closed during response"));
		};
		socket.once("drain", onDrain);
		socket.once("error", onError);
		socket.once("close", onClose);
	});
}

function write(socket, data) {
	if (socket.destroyed) throw new Error("socket destroyed during response");
	return socket.write(data) ? null : drain(socket);
}

function chunkFrame(chunk) {
	const prefix = `${chunk.length.toString(16)}\r\n`;
	const frame = Buffer.allocUnsafe(
		Buffer.byteLength(prefix) + chunk.length + 2,
	);
	let offset = frame.write(prefix, 0, "ascii");
	offset += chunk.copy(frame, offset);
	frame.write("\r\n", offset, "ascii");
	return frame;
}

function coalesceImmediateWrites(socket) {
	if (
		typeof socket.cork !== "function" ||
		typeof socket.uncork !== "function"
	) {
		return () => {};
	}
	let corked = true;
	let scheduled;
	const release = () => {
		if (!corked) return;
		corked = false;
		clearImmediate(scheduled);
		socket.uncork();
	};
	socket.cork();
	scheduled = setImmediate(release);
	return release;
}

/**
 * Serialize a web Response onto an HTTP/1.1 socket.
 *
 * Framing: a content-length from the Response is trusted; bodies without one
 * use chunked transfer-encoding. HEAD/204/205/304 never carry a body.
 * HTTP/1.1 only: the parser rejects anything else before this runs.
 *
 * @param {import('node:net').Socket} socket
 * @param {Response} response
 * @param {object} opts
 * @param {boolean} opts.keepAlive keep the connection open after this response
 * @param {boolean} opts.isHead request method was HEAD
 * @param {string|null} opts.altSvc Alt-Svc header value advertising h3
 * @param {() => void} [opts.onCommit] called immediately before response headers
 * @returns {Promise<void>} resolves once the response is fully written
 */
export async function writeResponse(
	socket,
	response,
	{ keepAlive = true, isHead = false, altSvc = null, onCommit } = {},
) {
	const status = response.status;
	const trailerMeta = getResponseTrailers(response);
	const reason = response.statusText || STATUS_CODES[status] || "";
	const omitBody = isHead || NO_BODY_STATUS.has(status);

	const headers = [];
	let contentLength = null;
	response.headers.forEach((value, name) => {
		if (name === "content-length") {
			contentLength = value;
			return; // re-emitted below so framing stays consistent
		}
		if (name === "set-cookie") return; // handled below, needs splitting
		if (name === "transfer-encoding" || name === "connection") return;
		headers.push(`${name}: ${value}`);
	});
	for (const cookie of response.headers.getSetCookie()) {
		headers.push(`set-cookie: ${cookie}`);
	}
	if (altSvc !== null) headers.push(`alt-svc: ${altSvc}`);
	headers.push(`date: ${dateHeader()}`);

	let body = null;
	let chunked = false;
	let expectedLength = null;
	if (contentLength !== null) {
		expectedLength = parseContentLength(contentLength);
	}
	if (status === 204 || status === 304) {
		// no content-length at all
	} else if (response.body === null) {
		if (!isHead && expectedLength !== null && expectedLength !== 0) {
			throw new Error("response body is shorter than content-length");
		}
		headers.push(`content-length: ${contentLength ?? 0}`);
	} else if (contentLength !== null) {
		if (trailerMeta !== null) {
			throw new TypeError("HTTP/1.1 response trailers require chunked framing");
		}
		headers.push(`content-length: ${contentLength}`);
		body = response.body;
	} else {
		chunked = true;
		headers.push("transfer-encoding: chunked");
		body = response.body;
	}
	if (trailerMeta !== null) {
		headers.push(`trailer: ${trailerMeta.names.join(", ")}`);
	}
	headers.push(`connection: ${keepAlive ? "keep-alive" : "close"}`);

	const head = `HTTP/1.1 ${status} ${reason}\r\n${headers.join("\r\n")}\r\n\r\n`;
	onCommit?.();
	const releaseWrites = coalesceImmediateWrites(socket);
	try {
		const headDrain = write(socket, head);
		if (headDrain !== null) await headDrain;

		if (body === null) return;
		if (omitBody) {
			// A HEAD response advertises framing but must not send the payload.
			await response.body.cancel().catch(() => {});
			return;
		}
		let written = 0;
		const reader = body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
				if (buf.length === 0) continue;
				written += buf.length;
				if (expectedLength !== null && written > expectedLength) {
					throw new Error("response body is longer than content-length");
				}
				const pending = write(socket, chunked ? chunkFrame(buf) : buf);
				if (pending !== null) await pending;
			}
		} catch (error) {
			await reader.cancel(error).catch(() => {});
			throw error;
		} finally {
			reader.releaseLock();
		}
		if (expectedLength !== null && written !== expectedLength) {
			throw new Error("response body is shorter than content-length");
		}
		if (chunked) {
			if (trailerMeta === null) {
				const pending = write(socket, "0\r\n\r\n");
				if (pending !== null) await pending;
			} else {
				let tail = "0\r\n";
				const trailers = await trailerMeta.getValues();
				for (const [name, value] of trailers) {
					if (!trailerMeta.names.includes(name)) {
						throw new TypeError(`undeclared response trailer: ${name}`);
					}
					tail += `${name}: ${value}\r\n`;
				}
				tail += "\r\n";
				const pending = write(socket, tail);
				if (pending !== null) await pending;
			}
		}
	} finally {
		releaseWrites();
	}
}
