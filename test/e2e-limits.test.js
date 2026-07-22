import assert from "node:assert";
import http2 from "node:http2";
import net from "node:net";
import { test } from "node:test";
import { cert, key } from "./fixtures/tls.js";
import { h2connect, rawRequest, start } from "./helpers.js";

const tls = { key, cert };

test("h1 rejects oversized header blocks with 431", async () => {
	const server = await start(() => new Response("ok"), { maxHeaderSize: 256 });
	try {
		const big = "x".repeat(2_000);
		const out = await rawRequest(
			server,
			`GET / HTTP/1.1\r\nHost: h\r\nX-Big: ${big}\r\nConnection: close\r\n\r\n`,
		);
		assert.match(out, /^HTTP\/1\.1 431 /);
	} finally {
		await server.close();
	}
});

test("h2 rejects oversized header blocks with 431", async () => {
	let dispatched = false;
	const server = await start(
		() => {
			dispatched = true;
			return new Response("ok");
		},
		{ tls, maxHeaderSize: 256 },
	);
	const client = h2connect(server, cert);
	try {
		const stream = client.request({
			":path": "/",
			"x-big": "x".repeat(2_000),
		});
		const headers = await new Promise((resolve, reject) => {
			stream.once("response", resolve);
			stream.once("error", reject);
		});
		assert.strictEqual(headers[":status"], 431);
		assert.strictEqual(dispatched, false);
		stream.close(http2.constants.NGHTTP2_NO_ERROR);
	} finally {
		client.destroy();
		await server.close();
	}
});

test("h1 rejects an over-limit Content-Length with 413", async () => {
	const server = await start(
		async (ctx) => new Response(await ctx.request.text()),
		{
			maxRequestBodySize: 8,
		},
	);
	try {
		const out = await rawRequest(
			server,
			`POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 100\r\nConnection: close\r\n\r\n${"x".repeat(100)}`,
		);
		assert.match(out, /^HTTP\/1\.1 413 /);
	} finally {
		await server.close();
	}
});

test("h2 rejects an over-limit Content-Length with 413", async () => {
	const server = await start(
		async (ctx) => new Response(await ctx.request.text()),
		{ tls, maxRequestBodySize: 8 },
	);
	const client = h2connect(server, cert);
	try {
		const stream = client.request({
			":method": "POST",
			":path": "/",
			"content-length": "100",
		});
		const headers = await new Promise((resolve, reject) => {
			stream.once("response", resolve);
			stream.once("error", reject);
		});
		assert.strictEqual(headers[":status"], 413);
		stream.close(http2.constants.NGHTTP2_NO_ERROR);
	} finally {
		client.destroy();
		await server.close();
	}
});

test("h2 enforces streamed body limits even when the handler ignores the body", async () => {
	const server = await start(() => new Response("early"), {
		tls,
		maxRequestBodySize: 8,
	});
	const client = h2connect(server, cert);
	try {
		const stream = client.request({ ":method": "POST", ":path": "/" });
		const response = new Promise((resolve, reject) => {
			stream.once("response", resolve);
			stream.once("error", reject);
		});
		stream.end("x".repeat(100));
		const headers = await response;
		assert.strictEqual(headers[":status"], 413);
		await new Promise((resolve) => stream.once("close", resolve));
	} finally {
		client.destroy();
		await server.close({ force: true });
	}
});

test("maxConnections drops connections past the limit", async () => {
	const server = await start(() => new Response("ok"), { maxConnections: 2 });
	const sockets = [];
	const open = (onClose) => {
		const s = net.connect(server.port, server.hostname);
		s.on("error", () => {});
		if (onClose) s.on("close", onClose);
		sockets.push(s);
		return new Promise((resolve) => s.once("connect", resolve));
	};
	try {
		await open();
		await open();
		await new Promise((r) => setTimeout(r, 50)); // let the server count them
		const dropped = Promise.withResolvers();
		await open(() => dropped.resolve("closed"));
		// the third connection is over the limit and gets dropped promptly
		const result = await Promise.race([
			dropped.promise,
			new Promise((r) => setTimeout(() => r("stayed-open"), 1_000)),
		]);
		assert.strictEqual(result, "closed");
	} finally {
		for (const s of sockets) s.destroy();
		await server.close({ force: true });
	}
});

test("keepAliveTimeout of 0 leaves an idle connection open", async () => {
	const server = await start(() => new Response("ok"), { keepAliveTimeout: 0 });
	try {
		const socket = net.connect(server.port, server.hostname);
		socket.on("error", () => {});
		await new Promise((r) => socket.once("connect", r));
		socket.write("GET / HTTP/1.1\r\nHost: h\r\n\r\n");
		await new Promise((r) => socket.once("data", r)); // got the response
		let closed = false;
		socket.on("close", () => {
			closed = true;
		});
		await new Promise((r) => setTimeout(r, 300));
		assert.strictEqual(closed, false, "idle connection should stay open");
		socket.destroy();
	} finally {
		await server.close({ force: true });
	}
});
