import assert from "node:assert";
import http2 from "node:http2";
import https from "node:https";
import { test } from "node:test";
import tls from "node:tls";
import { cert, key } from "./fixtures/tls.js";
import { start } from "./helpers.js";

const infoHandler = (ctx) =>
	Response.json({
		httpVersion: ctx.httpVersion,
		alpn: ctx.alpnProtocol,
		url: ctx.request.url,
	});

function httpsGet(url, options) {
	return new Promise((resolve, reject) => {
		https
			.get(url, options, (res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () =>
					resolve({
						status: res.statusCode,
						headers: res.headers,
						body: Buffer.concat(chunks).toString(),
					}),
				);
			})
			.on("error", reject);
	});
}

test("h1 over TLS (no ALPN)", async () => {
	const server = await start(infoHandler, { tls: { key, cert } });
	try {
		const res = await httpsGet(`https://localhost:${server.port}/tls`, {
			ca: cert,
		});
		assert.strictEqual(res.status, 200);
		const body = JSON.parse(res.body);
		assert.strictEqual(body.httpVersion, "1.1");
		assert.ok(body.url.startsWith("https://"));
	} finally {
		await server.close();
	}
});

test("h1 over TLS with ALPN http/1.1", async () => {
	const server = await start(infoHandler, { tls: { key, cert } });
	try {
		const res = await httpsGet(`https://localhost:${server.port}/`, {
			ca: cert,
			ALPNProtocols: ["http/1.1"],
		});
		const body = JSON.parse(res.body);
		assert.strictEqual(body.httpVersion, "1.1");
		assert.strictEqual(body.alpn, "http/1.1");
	} finally {
		await server.close();
	}
});

test("h2 negotiated via ALPN on the shared TLS port", async () => {
	const server = await start(infoHandler, { tls: { key, cert } });
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const { status, body } = await h2Request(client, "/h2");
		client.destroy();
		assert.strictEqual(status, 200);
		const parsed = JSON.parse(body);
		assert.strictEqual(parsed.httpVersion, "2");
		assert.strictEqual(parsed.alpn, "h2");
		assert.ok(parsed.url.startsWith("https://"));
	} finally {
		await server.close();
	}
});

test("h2 POST body round-trips", async () => {
	const server = await start(
		(ctx) =>
			ctx.request.method === "POST"
				? new Response(ctx.request.body)
				: new Response("nope", { status: 405 }),
		{ tls: { key, cert } },
	);
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const payload = "y".repeat(64 * 1024);
		const { status, body } = await h2Request(client, "/echo", payload);
		client.destroy();
		assert.strictEqual(status, 200);
		assert.strictEqual(body, payload);
	} finally {
		await server.close();
	}
});

test("an established TLS connection survives the handshake timeout", async () => {
	const server = await start(() => new Response("still-alive"), {
		tls: { key, cert, alpn: ["h1"] },
		tlsHandshakeTimeout: 50,
		keepAliveTimeout: 1_000,
	});
	const socket = tls.connect({
		host: "localhost",
		port: server.port,
		ca: cert,
		ALPNProtocols: ["http/1.1"],
	});
	try {
		await new Promise((resolve, reject) => {
			socket.once("secureConnect", resolve);
			socket.once("error", reject);
		});
		await new Promise((resolve) => setTimeout(resolve, 120));
		const chunks = [];
		socket.on("data", (chunk) => chunks.push(chunk));
		socket.write(
			"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
		);
		await new Promise((resolve) => socket.once("close", resolve));
		assert.match(Buffer.concat(chunks).toString(), /still-alive/);
	} finally {
		socket.destroy();
		await server.close({ force: true });
	}
});

function h2Request(client, path, payload) {
	return new Promise((resolve, reject) => {
		const req = client.request({
			":path": path,
			":method": payload === undefined ? "GET" : "POST",
		});
		let status;
		const chunks = [];
		req.on("response", (headers) => {
			status = headers[":status"];
		});
		req.on("data", (c) => chunks.push(c));
		req.on("end", () =>
			resolve({ status, body: Buffer.concat(chunks).toString() }),
		);
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}
