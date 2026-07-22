import assert from "node:assert";
import http2 from "node:http2";
import net from "node:net";
import { test } from "node:test";
import { Context, serve } from "../lib/index.js";
import { cert, key } from "./fixtures/tls.js";
import { start } from "./helpers.js";

test("handler object with a fetch() method serves requests", async () => {
	const server = await start({
		[Symbol.for("server.protocol")]: 1,
		fetch: () => new Response("marked"),
	});
	try {
		const res = await fetch(server.url);
		assert.strictEqual(await res.text(), "marked");
	} finally {
		await server.close();
	}
});

test("serve() returns synchronously; two-step listen() binds the port", async () => {
	const server = serve({ fetch: () => new Response("ok") });
	try {
		assert.strictEqual(server.port, null);
		const returned = await server.listen({ port: 0 });
		assert.strictEqual(returned, server);
		assert.ok(server.port > 0);
		const res = await fetch(server.url);
		assert.strictEqual(res.status, 200);
	} finally {
		await server.close();
	}
});

test("remoteAddress is a SocketAddress { address, port, family }", async () => {
	const server = await start((ctx) =>
		Response.json({ addr: ctx.remoteAddress }),
	);
	try {
		const { addr } = await (await fetch(server.url)).json();
		assert.strictEqual(addr.address, "127.0.0.1");
		assert.strictEqual(typeof addr.port, "number");
		assert.ok(addr.family === "IPv4" || addr.family === "IPv6");
	} finally {
		await server.close();
	}
});

test("ctx.sendInformational emits 103 Early Hints before the response over h1", async () => {
	const server = await start((ctx) => {
		ctx.sendInformational(103, { link: "</s.css>; rel=preload; as=style" });
		return new Response("done");
	});
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((r) => socket.once("connect", r));
		const chunks = [];
		socket.on("data", (c) => chunks.push(c));
		socket.write("GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n");
		await new Promise((r) => socket.once("close", r));
		const out = Buffer.concat(chunks).toString();
		assert.match(out, /HTTP\/1\.1 103 Early Hints\r\n/);
		assert.match(out, /link: <\/s.css>; rel=preload; as=style\r\n/);
		assert.ok(out.indexOf("103") < out.indexOf("200"), "103 precedes 200");
	} finally {
		await server.close();
	}
});

test("ctx.sendInformational emits an interim response over h2", async () => {
	const server = await start(
		(ctx) => {
			ctx.sendInformational(103, { link: "</s.css>; rel=preload" });
			return new Response("done");
		},
		{ tls: { key, cert } },
	);
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const info = [];
		const body = await new Promise((resolve, reject) => {
			const req = client.request({ ":path": "/" });
			req.on("headers", (h) => info.push(Number(h[":status"])));
			const buf = [];
			req.on("data", (c) => buf.push(c));
			req.on("end", () => resolve(Buffer.concat(buf).toString()));
			req.on("error", reject);
			req.end();
		});
		client.destroy();
		assert.strictEqual(body, "done");
		assert.ok(info.includes(103), `interim statuses seen: ${info}`);
	} finally {
		await server.close();
	}
});

test("ctx.sendInformational rejects out-of-range status codes", async () => {
	const server = await start((ctx) => {
		assert.throws(() => ctx.sendInformational(200), { name: "RangeError" });
		return new Response("ok");
	});
	try {
		assert.strictEqual((await fetch(server.url)).status, 200);
	} finally {
		await server.close();
	}
});

test("ctx.deny() drops the h1 connection (no response)", async () => {
	const server = await start((ctx) => ctx.deny());
	try {
		await assert.rejects(fetch(server.url));
	} finally {
		await server.close({ force: true });
	}
});

test("a handler returning nothing refuses the request", async () => {
	const server = await start(() => undefined);
	try {
		await assert.rejects(fetch(server.url));
	} finally {
		await server.close({ force: true });
	}
});

test("ctx.deny() resets the h2 stream with REFUSED_STREAM", async () => {
	const server = await start((ctx) => ctx.deny(), { tls: { key, cert } });
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		client.on("error", () => {});
		// Drive the stream to its 'close' so the RST is fully processed before
		// the test ends (otherwise it surfaces as a late uncaughtException).
		const rstCode = await new Promise((resolve) => {
			const req = client.request({ ":path": "/" });
			req.on("error", () => {}); // expected: reset, not a response
			req.on("close", () => resolve(req.rstCode));
			req.end();
		});
		assert.strictEqual(rstCode, http2.constants.NGHTTP2_REFUSED_STREAM);
		await new Promise((resolve) => client.close(resolve));
	} finally {
		await server.close({ force: true });
	}
});

test("ctx.waitUntil work is awaited during graceful close", async () => {
	let done = false;
	const server = await start((ctx) => {
		ctx.waitUntil(
			(async () => {
				await new Promise((r) => setTimeout(r, 100));
				done = true;
			})(),
		);
		return new Response("ok");
	});
	await (await fetch(server.url)).text();
	await server.close();
	assert.strictEqual(done, true);
});

test("Context preserves the public metadata.waitUntil hook", () => {
	const tracked = [];
	const promise = Promise.resolve();
	const ctx = new Context(new Request("https://example.com/"), {
		remoteAddress: { address: "127.0.0.1", port: 1234, family: "IPv4" },
		httpVersion: "1.1",
		waitUntil(value) {
			tracked.push(value);
		},
	});

	ctx.waitUntil(promise);
	assert.deepStrictEqual(tracked, [promise]);
});

test("server.busy returns a retryable 503 without dispatching", async () => {
	let dispatched = 0;
	const server = await start(() => {
		dispatched++;
		return new Response("ok");
	});
	try {
		server.busy = true;
		const busyRes = await fetch(server.url);
		assert.strictEqual(busyRes.status, 503);
		assert.ok(busyRes.headers.get("retry-after"));
		assert.strictEqual(dispatched, 0);

		server.busy = false;
		const okRes = await fetch(server.url);
		assert.strictEqual(okRes.status, 200);
		assert.strictEqual(dispatched, 1);
	} finally {
		await server.close();
	}
});

test("tls.alpn restricts the offered protocols to h1 only", async () => {
	const server = await start(
		(ctx) => Response.json({ alpn: ctx.alpnProtocol }),
		{ tls: { key, cert, alpn: ["h1"] } },
	);
	try {
		assert.deepStrictEqual(server.protocols, ["h1"]);
		const https = await import("node:https");
		const body = await new Promise((resolve, reject) => {
			https
				.get(
					`https://localhost:${server.port}/`,
					{ ca: cert, ALPNProtocols: ["http/1.1"] },
					(res) => {
						const chunks = [];
						res.on("data", (c) => chunks.push(c));
						res.on("end", () => resolve(Buffer.concat(chunks).toString()));
					},
				)
				.on("error", reject);
		});
		assert.strictEqual(JSON.parse(body).alpn, "http/1.1");
	} finally {
		await server.close();
	}
});
