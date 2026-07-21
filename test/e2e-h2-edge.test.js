import assert from "node:assert";
import http2 from "node:http2";
import { test } from "node:test";
import { cert, key } from "./fixtures/tls.js";
import { start } from "./helpers.js";

function h2Request(client, headers, payload) {
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
				headers: resHeaders,
				body: Buffer.concat(chunks).toString(),
			}),
		);
		req.on("error", reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

test("multiple set-cookie survive h2 round trip", async () => {
	const server = await start(
		() => {
			const headers = new Headers();
			headers.append("set-cookie", "a=1; Path=/");
			headers.append("set-cookie", "b=2; HttpOnly");
			return new Response("ok", { headers });
		},
		{ tls: { key, cert } },
	);
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const { headers } = await h2Request(client, { ":path": "/" });
		client.destroy();
		assert.deepStrictEqual(headers["set-cookie"], [
			"a=1; Path=/",
			"b=2; HttpOnly",
		]);
	} finally {
		await server.close();
	}
});

test("many concurrent streams on one session", async () => {
	const server = await start(
		async (ctx) => {
			const n = new URL(ctx.request.url).searchParams.get("n");
			await new Promise((r) => setTimeout(r, 10));
			return new Response(`answer-${n}`);
		},
		{ tls: { key, cert } },
	);
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				h2Request(client, { ":path": `/?n=${i}` }),
			),
		);
		client.destroy();
		results.forEach((r, i) => {
			assert.strictEqual(r.status, 200);
			assert.strictEqual(r.body, `answer-${i}`);
		});
	} finally {
		await server.close();
	}
});

test("client RST mid-response leaves the session healthy", async () => {
	const server = await start(
		(ctx) => {
			if (new URL(ctx.request.url).pathname === "/slow") {
				const body = new ReadableStream({
					async pull(c) {
						await new Promise((r) => setTimeout(r, 20));
						c.enqueue(new TextEncoder().encode("tick"));
					},
				});
				return new Response(body);
			}
			return new Response("fine");
		},
		{ tls: { key, cert } },
	);
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const slow = client.request({ ":path": "/slow" });
		await new Promise((r) => slow.once("response", r));
		slow.close(http2.constants.NGHTTP2_CANCEL);
		await new Promise((r) => setTimeout(r, 50));

		const { status, body } = await h2Request(client, { ":path": "/ok" });
		client.destroy();
		assert.strictEqual(status, 200);
		assert.strictEqual(body, "fine");
	} finally {
		await server.close();
	}
});

test("duplicate request headers are combined on h2", async () => {
	let combined;
	const server = await start(
		(ctx) => {
			combined = ctx.request.headers.get("x-multi");
			return new Response("ok");
		},
		{ tls: { key, cert } },
	);
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		// node:http2 joins repeated non-pseudo headers into an array
		await h2Request(client, { ":path": "/", "x-multi": ["a", "b"] });
		client.destroy();
		assert.strictEqual(combined, "a, b");
	} finally {
		await server.close();
	}
});

test("h2 request abort mid-body errors the handler body stream", async () => {
	const { promise, resolve } = Promise.withResolvers();
	const server = await start(
		async (ctx) => {
			try {
				await ctx.request.text();
				resolve("completed");
			} catch {
				resolve("errored");
			}
			return new Response("ok");
		},
		{ tls: { key, cert } },
	);
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const req = client.request({
			":path": "/",
			":method": "POST",
			"content-length": "1000",
		});
		req.write("partial");
		await new Promise((r) => setTimeout(r, 50));
		req.close(http2.constants.NGHTTP2_CANCEL);
		assert.strictEqual(await promise, "errored");
		client.destroy();
	} finally {
		await server.close();
	}
});

test("HEAD over h2 omits the body", async () => {
	const server = await start(
		() => new Response("hello", { headers: { "content-length": "5" } }),
		{ tls: { key, cert } },
	);
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const { status, headers, body } = await h2Request(client, {
			":path": "/",
			":method": "HEAD",
		});
		client.destroy();
		assert.strictEqual(status, 200);
		assert.strictEqual(headers["content-length"], "5");
		assert.strictEqual(body, "");
	} finally {
		await server.close();
	}
});
