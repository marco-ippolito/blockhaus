import assert from "node:assert";
import net from "node:net";
import { test } from "node:test";
import { start } from "./helpers.js";

const echoHandler = (ctx) => {
	if (ctx.request.method === "POST") {
		return new Response(ctx.request.body, {
			headers: { "x-echo": "stream" },
		});
	}
	return Response.json({
		url: ctx.request.url,
		method: ctx.request.method,
		httpVersion: ctx.httpVersion,
		alpn: ctx.alpnProtocol,
		remoteAddress: ctx.remoteAddress,
	});
};

test("GET over plaintext h1", async () => {
	const server = await start(echoHandler);
	try {
		const res = await fetch(`${server.url}hello?x=1`);
		assert.strictEqual(res.status, 200);
		const body = await res.json();
		assert.strictEqual(body.method, "GET");
		assert.strictEqual(body.httpVersion, "1.1");
		assert.strictEqual(body.alpn, null);
		assert.strictEqual(body.remoteAddress.address, "127.0.0.1");
		assert.ok(body.url.endsWith("/hello?x=1"));
	} finally {
		await server.close();
	}
});

test("POST body is streamed through the handler", async () => {
	const server = await start(echoHandler);
	try {
		const payload = "x".repeat(256 * 1024);
		const res = await fetch(server.url, { method: "POST", body: payload });
		assert.strictEqual(res.status, 200);
		assert.strictEqual(await res.text(), payload);
	} finally {
		await server.close();
	}
});

test("streaming chunked response", async () => {
	const server = await start(() => {
		const body = new ReadableStream({
			async start(c) {
				c.enqueue(new TextEncoder().encode("first-"));
				await new Promise((r) => setTimeout(r, 10));
				c.enqueue(new TextEncoder().encode("second"));
				c.close();
			},
		});
		return new Response(body);
	});
	try {
		const res = await fetch(server.url);
		assert.strictEqual(await res.text(), "first-second");
	} finally {
		await server.close();
	}
});

test("handler throw becomes a 500", async () => {
	const server = await start(() => {
		throw new Error("boom");
	});
	try {
		const res = await fetch(server.url);
		assert.strictEqual(res.status, 500);
	} finally {
		await server.close();
	}
});

test("non-Response return becomes a 500", async () => {
	const server = await start(() => "not a response");
	try {
		const res = await fetch(server.url);
		assert.strictEqual(res.status, 500);
	} finally {
		await server.close();
	}
});

test("sequential keep-alive requests on one connection", async () => {
	let connections = 0;
	const server = await start((ctx) => {
		return new Response(new URL(ctx.request.url).pathname);
	});
	try {
		// raw socket so connection reuse is deterministic
		const socket = net.connect(server.port, server.hostname);
		await new Promise((r) => socket.once("connect", r));
		connections = 1;
		const collected = [];
		socket.on("data", (c) => collected.push(c));

		socket.write("GET /one HTTP/1.1\r\nHost: t\r\n\r\n");
		socket.write("GET /two HTTP/1.1\r\nHost: t\r\n\r\n");
		socket.write("GET /three HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n");

		await new Promise((r) => socket.once("close", r));
		const out = Buffer.concat(collected).toString();
		assert.strictEqual(connections, 1);
		assert.ok(out.includes("/one"));
		assert.ok(out.includes("/two"));
		assert.ok(out.includes("/three"));
		assert.strictEqual((out.match(/HTTP\/1\.1 200/g) ?? []).length, 3);
		// first two responses keep the connection alive, the last closes it
		assert.strictEqual((out.match(/connection: keep-alive/g) ?? []).length, 2);
		assert.strictEqual((out.match(/connection: close/g) ?? []).length, 1);
	} finally {
		await server.close();
	}
});

test("garbage bytes get a 400 and the connection closes", async () => {
	const server = await start(() => new Response("nope"));
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((r) => socket.once("connect", r));
		const collected = [];
		socket.on("data", (c) => collected.push(c));
		// starts with 'P' like the h2 preface? no -- diverges immediately, so h1
		socket.write("garbage garbage garbage\r\n\r\n");
		await new Promise((r) => socket.once("close", r));
		assert.match(Buffer.concat(collected).toString(), /^HTTP\/1\.1 400 /);
	} finally {
		await server.close();
	}
});

test("HEAD gets headers but no body", async () => {
	const server = await start(
		() => new Response("hello", { headers: { "content-length": "5" } }),
	);
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((r) => socket.once("connect", r));
		const collected = [];
		socket.on("data", (c) => collected.push(c));
		socket.write("HEAD / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n");
		await new Promise((r) => socket.once("close", r));
		const out = Buffer.concat(collected).toString();
		assert.match(out, /content-length: 5\r\n/);
		assert.ok(out.endsWith("\r\n\r\n"));
	} finally {
		await server.close();
	}
});

test("HTTP/1.0 is rejected: milo is a strict HTTP/1.1-only parser", async () => {
	const server = await start(() => new Response("ten"));
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((r) => socket.once("connect", r));
		const collected = [];
		socket.on("data", (c) => collected.push(c));
		socket.write("GET / HTTP/1.0\r\nHost: t\r\n\r\n");
		await new Promise((r) => socket.once("close", r));
		const out = Buffer.concat(collected).toString();
		assert.match(out, /^HTTP\/1\.1 400 /);
		assert.match(out, /connection: close\r\n/);
	} finally {
		await server.close();
	}
});
