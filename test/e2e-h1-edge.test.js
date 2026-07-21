import assert from "node:assert";
import net from "node:net";
import { test } from "node:test";
import { start } from "./helpers.js";

function rawRequest(server, data, { waitClose = true } = {}) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(server.port, server.hostname);
		const collected = [];
		socket.on("data", (c) => collected.push(c));
		socket.on("error", reject);
		socket.once("connect", () => socket.write(data));
		if (waitClose) {
			socket.on("close", () => resolve(Buffer.concat(collected).toString()));
		} else {
			socket.on("data", () =>
				setTimeout(() => {
					socket.destroy();
					resolve(Buffer.concat(collected).toString());
				}, 50),
			);
		}
	});
}

test("CONNECT is rejected with 501", async () => {
	const server = await start(() => new Response("no"));
	try {
		const out = await rawRequest(
			server,
			"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
		);
		assert.match(out, /^HTTP\/1\.1 501 /);
	} finally {
		await server.close();
	}
});

test("content-length + transfer-encoding is rejected (smuggling defense)", async () => {
	const server = await start(() => new Response("no"));
	try {
		const out = await rawRequest(
			server,
			"POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n",
		);
		assert.match(out, /^HTTP\/1\.1 400 /);
	} finally {
		await server.close();
	}
});

test("duplicate differing content-length is rejected", async () => {
	const server = await start(() => new Response("no"));
	try {
		const out = await rawRequest(
			server,
			"POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\nabc",
		);
		assert.match(out, /^HTTP\/1\.1 400 /);
	} finally {
		await server.close();
	}
});

test("chunked trailers are consumed and pipelining continues", async () => {
	const seen = [];
	const server = await start(async (ctx) => {
		seen.push(new URL(ctx.request.url).pathname);
		if (ctx.request.body) await ctx.request.text();
		return new Response("ok");
	});
	try {
		const out = await rawRequest(
			server,
			"POST /with-trailers HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n" +
				"3\r\nabc\r\n0\r\nX-Trailer: v\r\n\r\n" +
				"GET /after HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n",
		);
		assert.strictEqual((out.match(/HTTP\/1\.1 200/g) ?? []).length, 2);
		assert.deepStrictEqual(seen, ["/with-trailers", "/after"]);
	} finally {
		await server.close();
	}
});

test("client abort mid-request-body errors the body stream", async () => {
	const { promise, resolve } = Promise.withResolvers();
	const server = await start(async (ctx) => {
		try {
			await ctx.request.text();
			resolve("completed");
		} catch {
			resolve("errored");
		}
		return new Response("ok");
	});
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((r) => socket.once("connect", r));
		socket.write(
			"POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 1000\r\n\r\npartial",
		);
		await new Promise((r) => setTimeout(r, 50));
		socket.destroy();
		assert.strictEqual(await promise, "errored");
	} finally {
		await server.close();
	}
});

test("response stream that throws destroys the connection, server survives", async () => {
	let first = true;
	const server = await start(() => {
		if (first) {
			first = false;
			const body = new ReadableStream({
				start(c) {
					c.enqueue(new TextEncoder().encode("partial"));
				},
				pull(c) {
					c.error(new Error("stream blew up"));
				},
			});
			return new Response(body);
		}
		return new Response("healthy");
	});
	try {
		await assert.rejects(async () => {
			const res = await fetch(server.url);
			await res.text();
		});
		const res = await fetch(server.url);
		assert.strictEqual(await res.text(), "healthy");
	} finally {
		await server.close();
	}
});

test("asterisk-form OPTIONS normalizes to /", async () => {
	let url;
	const server = await start((ctx) => {
		url = ctx.request.url;
		return new Response(null, { status: 204 });
	});
	try {
		const out = await rawRequest(
			server,
			"OPTIONS * HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n",
		);
		assert.match(out, /^HTTP\/1\.1 204 /);
		assert.strictEqual(new URL(url).pathname, "/");
	} finally {
		await server.close();
	}
});

test("absolute-form request target is preserved", async () => {
	let url;
	const server = await start((ctx) => {
		url = ctx.request.url;
		return new Response("ok");
	});
	try {
		await rawRequest(
			server,
			"GET http://example.com/abs?q=1 HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n",
		);
		assert.strictEqual(url, "http://example.com/abs?q=1");
	} finally {
		await server.close();
	}
});

test("percent-encoding and query are preserved verbatim", async () => {
	let url;
	const server = await start((ctx) => {
		url = ctx.request.url;
		return new Response("ok");
	});
	try {
		const res = await fetch(`${server.url}a%20b/%E2%82%AC?x=1&y=%25`);
		assert.strictEqual(res.status, 200);
		const u = new URL(url);
		assert.strictEqual(u.pathname, "/a%20b/%E2%82%AC");
		assert.strictEqual(u.search, "?x=1&y=%25");
	} finally {
		await server.close();
	}
});

test("duplicate request headers are combined", async () => {
	let combined;
	const server = await start((ctx) => {
		combined = ctx.request.headers.get("x-multi");
		return new Response("ok");
	});
	try {
		await rawRequest(
			server,
			"GET / HTTP/1.1\r\nHost: h\r\nX-Multi: a\r\nX-Multi: b\r\nConnection: close\r\n\r\n",
		);
		assert.strictEqual(combined, "a, b");
	} finally {
		await server.close();
	}
});

test("Expect: 100-continue receives an interim response before the body", async () => {
	const server = await start(async (ctx) => {
		return new Response(await ctx.request.text());
	});
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((r) => socket.once("connect", r));
		socket.write(
			"POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n",
		);
		const interim = await new Promise((r) => socket.once("data", r));
		assert.match(interim.toString(), /^HTTP\/1\.1 100 Continue\r\n\r\n/);
		socket.write("hello");
		const rest = [];
		socket.on("data", (c) => rest.push(c));
		await new Promise((r) => socket.once("close", r));
		const out = Buffer.concat(rest).toString();
		assert.match(out, /200/);
		assert.ok(out.includes("hello"));
	} finally {
		await server.close();
	}
});

test("custom status text and unknown status codes pass through", async () => {
	const server = await start(
		() => new Response("x", { status: 599, statusText: "Custom Reason" }),
	);
	try {
		const out = await rawRequest(
			server,
			"GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n",
		);
		assert.match(out, /^HTTP\/1\.1 599 Custom Reason\r\n/);
	} finally {
		await server.close();
	}
});

test("multiple set-cookie survive h1 round trip", async () => {
	const server = await start(() => {
		const headers = new Headers();
		headers.append("set-cookie", "a=1; Path=/");
		headers.append("set-cookie", "b=2; HttpOnly");
		return new Response("ok", { headers });
	});
	try {
		const res = await fetch(server.url);
		assert.deepStrictEqual(res.headers.getSetCookie(), [
			"a=1; Path=/",
			"b=2; HttpOnly",
		]);
	} finally {
		await server.close();
	}
});

test("content-length: 0 POST has a null body", async () => {
	let body;
	const server = await start((ctx) => {
		body = ctx.request.body;
		return new Response("ok");
	});
	try {
		await rawRequest(
			server,
			"POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
		);
		assert.strictEqual(body, null);
	} finally {
		await server.close();
	}
});

test("deep pipelining answers in order", async () => {
	const server = await start((ctx) => {
		return new Response(new URL(ctx.request.url).pathname.slice(1));
	});
	try {
		const n = 10;
		let data = "";
		for (let i = 0; i < n; i++) {
			const last = i === n - 1;
			data += `GET /req-${i} HTTP/1.1\r\nHost: h\r\n${last ? "Connection: close\r\n" : ""}\r\n`;
		}
		const out = await rawRequest(server, data);
		const order = [...out.matchAll(/req-(\d+)/g)].map((m) => Number(m[1]));
		assert.deepStrictEqual(
			order,
			Array.from({ length: n }, (_, i) => i),
		);
	} finally {
		await server.close();
	}
});

test("handler sees requests from two connections concurrently", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const server = await start(async () => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((r) => setTimeout(r, 30));
		inFlight--;
		return new Response("ok");
	});
	try {
		await Promise.all([fetch(server.url), fetch(server.url)]);
		assert.strictEqual(maxInFlight, 2);
	} finally {
		await server.close();
	}
});
