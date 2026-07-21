import { STATUS_CODES } from "node:http";
import { getResponseTrailers } from "../trailers.js";

const NO_BODY_STATUS = new Set([204, 205, 304]);

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

async function write(socket, data) {
	if (socket.destroyed) throw new Error("socket destroyed during response");
	if (!socket.write(data)) await drain(socket);
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
	for (const [name, value] of response.headers) {
		if (name === "content-length") {
			contentLength = value;
			continue; // re-emitted below so framing stays consistent
		}
		if (name === "set-cookie") continue; // handled below, needs splitting
		if (name === "transfer-encoding" || name === "connection") continue;
		headers.push(`${name}: ${value}`);
	}
	for (const cookie of response.headers.getSetCookie()) {
		headers.push(`set-cookie: ${cookie}`);
	}
	if (altSvc !== null) headers.push(`alt-svc: ${altSvc}`);
	headers.push(`date: ${new Date().toUTCString()}`);

	let body = null;
	let chunked = false;
	let expectedLength = null;
	if (contentLength !== null) {
		if (!/^(0|[1-9]\d*)$/.test(contentLength)) {
			throw new TypeError("invalid response content-length");
		}
		expectedLength = Number(contentLength);
		if (!Number.isSafeInteger(expectedLength)) {
			throw new RangeError("response content-length is too large");
		}
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
	await write(socket, head);

	if (body === null) return;
	if (omitBody) {
		// A HEAD response advertises framing but must not send the payload.
		await body.cancel().catch(() => {});
		return;
	}

	let written = 0;
	for await (const chunk of body) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (buf.length === 0) continue;
		written += buf.length;
		if (expectedLength !== null && written > expectedLength) {
			throw new Error("response body is longer than content-length");
		}
		if (chunked) {
			await write(socket, `${buf.length.toString(16)}\r\n`);
			await write(socket, buf);
			await write(socket, "\r\n");
		} else {
			await write(socket, buf);
		}
	}
	if (expectedLength !== null && written !== expectedLength) {
		throw new Error("response body is shorter than content-length");
	}
	if (chunked) {
		await write(socket, "0\r\n");
		if (trailerMeta !== null) {
			const trailers = await trailerMeta.getValues();
			for (const [name, value] of trailers) {
				if (!trailerMeta.names.includes(name)) {
					throw new TypeError(`undeclared response trailer: ${name}`);
				}
				await write(socket, `${name}: ${value}\r\n`);
			}
		}
		await write(socket, "\r\n");
	}
}
