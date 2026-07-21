import assert from "node:assert";
import http2 from "node:http2";
import net from "node:net";
import { test } from "node:test";
import { cert, key } from "./fixtures/tls.js";
import { start } from "./helpers.js";

test("malformed Host header gets 400, not a crash", async () => {
	const server = await start(() => new Response("ok"));
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((r) => socket.once("connect", r));
		const chunks = [];
		socket.on("data", (c) => chunks.push(c));
		socket.write("GET / HTTP/1.1\r\nHost: a b c\r\n\r\n");
		await new Promise((r) => socket.once("close", r));
		assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 400 /);
		// server survived
		const res = await fetch(server.url);
		assert.strictEqual(res.status, 200);
	} finally {
		await server.close();
	}
});

test("ctx.signal aborts when the client disconnects mid-handler", async () => {
	const aborted = Promise.withResolvers();
	const release = Promise.withResolvers();
	const server = await start(async (ctx) => {
		ctx.signal.addEventListener("abort", () => aborted.resolve("aborted"));
		await release.promise;
		return new Response("too late");
	});
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((r) => socket.once("connect", r));
		socket.write("GET / HTTP/1.1\r\nHost: t\r\n\r\n");
		await new Promise((r) => setTimeout(r, 50));
		socket.destroy();
		assert.strictEqual(await aborted.promise, "aborted");
		release.resolve();
	} finally {
		await server.close();
	}
});

test("ctx.signal does not abort on a completed exchange", async () => {
	let signal;
	const server = await start((ctx) => {
		signal = ctx.signal;
		return new Response("done");
	});
	try {
		const res = await fetch(server.url, {
			headers: { connection: "close" },
		});
		await res.text();
		await new Promise((r) => setTimeout(r, 50));
		assert.strictEqual(signal.aborted, false);
	} finally {
		await server.close();
	}
});

test("ctx.signal aborts on h2 client cancel", async () => {
	const aborted = Promise.withResolvers();
	const release = Promise.withResolvers();
	const server = await start(
		async (ctx) => {
			ctx.signal.addEventListener("abort", () => aborted.resolve("aborted"));
			await release.promise;
			return new Response("too late");
		},
		{ tls: { key, cert } },
	);
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const req = client.request({ ":path": "/" });
		await new Promise((r) => setTimeout(r, 50));
		req.close(http2.constants.NGHTTP2_CANCEL);
		assert.strictEqual(await aborted.promise, "aborted");
		release.resolve();
		client.destroy();
	} finally {
		await server.close();
	}
});

test("idle keep-alive connection is closed after keepAliveTimeout", async () => {
	const server = await start(() => new Response("ok"), {
		keepAliveTimeout: 150,
	});
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((r) => socket.once("connect", r));
		socket.write("GET / HTTP/1.1\r\nHost: t\r\n\r\n");
		await new Promise((r) => socket.once("data", r)); // response received
		const start = Date.now();
		await new Promise((r) => socket.once("close", r)); // idle timeout fires
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 2_000, `closed after ${elapsed}ms`);
	} finally {
		await server.close();
	}
});

test("slow headers get 408 after headersTimeout", async () => {
	const server = await start(() => new Response("ok"), {
		keepAliveTimeout: 100,
		headersTimeout: 200,
	});
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((r) => socket.once("connect", r));
		const chunks = [];
		socket.on("data", (c) => chunks.push(c));
		// trickle a partial request line, never finish the headers
		socket.write("GET / HTT");
		const timer = setInterval(() => {
			if (!socket.destroyed) socket.write("P");
		}, 50);
		await new Promise((r) => socket.once("close", r));
		clearInterval(timer);
		assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 408 /);
	} finally {
		await server.close();
	}
});

test("stuck handler gets cut off after requestTimeout", async () => {
	const server = await start(() => new Promise(() => {}), {
		requestTimeout: 200,
	});
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((r) => socket.once("connect", r));
		const chunks = [];
		socket.on("data", (c) => chunks.push(c));
		socket.write("GET / HTTP/1.1\r\nHost: t\r\n\r\n");
		const start = Date.now();
		await new Promise((r) => socket.once("close", r));
		assert.ok(Date.now() - start < 2_000);
		assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 408 /);
	} finally {
		await server.close({ force: true });
	}
});

test("graceful close finishes the in-flight exchange", async () => {
	const release = Promise.withResolvers();
	const server = await start(async () => {
		await release.promise;
		return new Response("finished cleanly");
	});
	const resPromise = fetch(server.url).then((r) => r.text());
	await new Promise((r) => setTimeout(r, 50)); // request reaches the handler
	const closePromise = server.close();
	release.resolve();
	assert.strictEqual(await resPromise, "finished cleanly");
	await closePromise;
});

test("close({force: true}) destroys in-flight connections", async () => {
	const server = await start(() => new Promise(() => {}));
	const resPromise = fetch(server.url).catch((_e) => "rejected");
	await new Promise((r) => setTimeout(r, 50));
	await server.close({ force: true });
	assert.strictEqual(await resPromise, "rejected");
});

test("closed server refuses new connections", async () => {
	const server = await start(() => new Response("ok"));
	const { port, hostname } = server;
	await server.close();
	await assert.rejects(fetch(`http://${hostname}:${port}/`));
});

test("server.closed resolves after close()", async () => {
	const server = await start(() => new Response("ok"));
	let resolved = false;
	server.closed.then(() => {
		resolved = true;
	});
	await server.close();
	await server.closed;
	assert.strictEqual(resolved, true);
});

test("destroy() terminates in-flight requests and resolves closed", async () => {
	const server = await start(() => new Promise(() => {}));
	const resPromise = fetch(server.url).catch(() => "rejected");
	await new Promise((r) => setTimeout(r, 50));
	server.destroy();
	await server.closed;
	assert.strictEqual(await resPromise, "rejected");
});

test("signal option closes the server when aborted", async () => {
	const controller = new AbortController();
	const server = await start(() => new Response("ok"), {
		signal: controller.signal,
	});
	const { port, hostname } = server;
	const res = await fetch(server.url);
	assert.strictEqual(res.status, 200);
	controller.abort();
	await server.closed;
	await assert.rejects(fetch(`http://${hostname}:${port}/`));
});
