import http2 from "node:http2";
import net from "node:net";
import { serve } from "../lib/index.js";

/**
 * Test convenience: accepts either a bare fetch function or a full handler
 * object, starts the server, and resolves once it is bound.
 *
 *   const server = await start(() => new Response("ok"));
 *   const server = await start({ fetch, connect }, { tls: { key, cert } });
 */
export async function start(handler, options = {}) {
	const normalized =
		typeof handler === "function" ? { fetch: handler } : handler;
	const server = serve(normalized, { port: 0, ...options });
	await server.listen();
	return server;
}

/**
 * Send one HTTP/2 request and collect the full response. `headers` uses pseudo
 * headers directly (`:method`, `:path`, ...); `body` is optional.
 */
export function h2request(client, headers, body) {
	return new Promise((resolve, reject) => {
		const req = client.request(headers);
		let status;
		let resHeaders;
		const chunks = [];
		req.on("response", (h) => {
			status = h[":status"];
			resHeaders = h;
		});
		req.on("data", (c) => chunks.push(c));
		req.on("end", () =>
			resolve({
				status,
				headers: resHeaders ?? {},
				body: Buffer.concat(chunks).toString(),
			}),
		);
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

/** Open a TLS HTTP/2 client against a server started with the test cert. */
export function h2connect(server, cert) {
	return http2.connect(`https://localhost:${server.port}`, { ca: cert });
}

/**
 * Send a raw request over a plaintext socket and return the full response text
 * once the connection closes.
 */
export function rawRequest(server, data) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(server.port, server.hostname);
		const chunks = [];
		socket.on("data", (c) => chunks.push(c));
		socket.on("error", reject);
		socket.once("connect", () => socket.write(data));
		socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
	});
}
