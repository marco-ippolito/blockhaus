import assert from "node:assert";
import { test } from "node:test";
import { cert, key } from "./fixtures/tls.js";
import { h2connect, h2request, rawRequest, start } from "./helpers.js";

const tls = { key, cert };

test("h1 duplicate request headers combine into one value", async () => {
	let seen;
	const server = await start((ctx) => {
		seen = ctx.request.headers.get("x-multi");
		return new Response("ok");
	});
	try {
		await rawRequest(
			server,
			"GET / HTTP/1.1\r\nHost: h\r\nX-Multi: a\r\nX-Multi: b\r\nConnection: close\r\n\r\n",
		);
		assert.strictEqual(seen, "a, b");
	} finally {
		await server.close();
	}
});

test("h1 header access is case-insensitive", async () => {
	let value;
	const server = await start((ctx) => {
		value = ctx.request.headers.get("X-CaSe");
		return new Response("ok");
	});
	try {
		await rawRequest(
			server,
			"GET / HTTP/1.1\r\nHost: h\r\nx-case: yes\r\nConnection: close\r\n\r\n",
		);
		assert.strictEqual(value, "yes");
	} finally {
		await server.close();
	}
});

test("h1 many request headers all arrive", async () => {
	let count;
	let picked;
	const server = await start((ctx) => {
		count = [...ctx.request.headers].length;
		picked = ctx.request.headers.get("x-h-25");
		return new Response("ok");
	});
	try {
		let head = "GET / HTTP/1.1\r\nHost: h\r\n";
		for (let i = 0; i < 50; i++) head += `X-H-${i}: v${i}\r\n`;
		head += "Connection: close\r\n\r\n";
		await rawRequest(server, head);
		assert.ok(count >= 50);
		assert.strictEqual(picked, "v25");
	} finally {
		await server.close();
	}
});

test("h1 request cookies are readable", async () => {
	let cookie;
	const server = await start((ctx) => {
		cookie = ctx.request.headers.get("cookie");
		return new Response("ok");
	});
	try {
		await rawRequest(
			server,
			"GET / HTTP/1.1\r\nHost: h\r\nCookie: a=1; b=2\r\nConnection: close\r\n\r\n",
		);
		assert.strictEqual(cookie, "a=1; b=2");
	} finally {
		await server.close();
	}
});

test("h1 response custom headers and content-type charset round-trip", async () => {
	const server = await start(
		() =>
			new Response("body", {
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"x-custom": "value",
				},
			}),
	);
	try {
		const res = await fetch(server.url);
		assert.strictEqual(
			res.headers.get("content-type"),
			"text/plain; charset=utf-8",
		);
		assert.strictEqual(res.headers.get("x-custom"), "value");
	} finally {
		await server.close();
	}
});

test("h1 multiple Set-Cookie response headers are preserved", async () => {
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

test("h2 duplicate request headers combine", async () => {
	let seen;
	const server = await start(
		(ctx) => {
			seen = ctx.request.headers.get("x-multi");
			return new Response("ok");
		},
		{ tls },
	);
	const client = h2connect(server, cert);
	try {
		await h2request(client, { ":path": "/", "x-multi": ["a", "b"] });
		assert.strictEqual(seen, "a, b");
	} finally {
		client.destroy();
		await server.close();
	}
});

test("h2 strips hop-by-hop response headers, keeps custom ones", async () => {
	const server = await start(
		() =>
			new Response("ok", {
				headers: { connection: "close", "x-keep": "yes" },
			}),
		{ tls },
	);
	const client = h2connect(server, cert);
	try {
		const res = await h2request(client, { ":path": "/" });
		assert.strictEqual(res.headers["x-keep"], "yes");
		assert.strictEqual(res.headers.connection, undefined);
	} finally {
		client.destroy();
		await server.close();
	}
});

test("h2 multiple Set-Cookie response headers are preserved", async () => {
	const server = await start(
		() => {
			const headers = new Headers();
			headers.append("set-cookie", "a=1; Path=/");
			headers.append("set-cookie", "b=2; HttpOnly");
			return new Response("ok", { headers });
		},
		{ tls },
	);
	const client = h2connect(server, cert);
	try {
		const res = await h2request(client, { ":path": "/" });
		assert.deepStrictEqual(res.headers["set-cookie"], [
			"a=1; Path=/",
			"b=2; HttpOnly",
		]);
	} finally {
		client.destroy();
		await server.close();
	}
});
