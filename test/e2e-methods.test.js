import assert from "node:assert";
import { test } from "node:test";
import { cert, key } from "./fixtures/tls.js";
import { h2connect, h2request, start } from "./helpers.js";

const app = (ctx) => {
	const url = new URL(ctx.request.url);
	const method = ctx.request.method;
	switch (url.pathname) {
		case "/method":
			return new Response(method);
		case "/echo":
			return new Response(ctx.request.body ?? "", {
				headers: { "x-echo": "1" },
			});
		case "/json":
			return Response.json({ ok: true, n: 42 });
		case "/bytes":
			return new Response(new Uint8Array([1, 2, 3, 4]));
		case "/blob":
			return new Response(new Blob(["blob-body"]));
		case "/empty":
			return new Response(null, { status: 204 });
		case "/notmodified":
			return new Response(null, { status: 304 });
		case "/redirect":
			return new Response(null, {
				status: 301,
				headers: { location: "/there" },
			});
		case "/teapot":
			return new Response("no coffee", { status: 418 });
		case "/created":
			return new Response("made", { status: 201 });
		default:
			return new Response("not found", { status: 404 });
	}
};

const tls = { key, cert };

// ---------------------------------------------------------------- HTTP/1.1 ---

for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
	test(`h1 ${method} reaches the handler`, async () => {
		const server = await start(app);
		try {
			const res = await fetch(`${server.url}method`, { method });
			assert.strictEqual(res.status, 200);
			assert.strictEqual(await res.text(), method);
		} finally {
			await server.close();
		}
	});
}

test("h1 POST body echoes back", async () => {
	const server = await start(app);
	try {
		const res = await fetch(`${server.url}echo`, {
			method: "POST",
			body: "hello",
		});
		assert.strictEqual(res.headers.get("x-echo"), "1");
		assert.strictEqual(await res.text(), "hello");
	} finally {
		await server.close();
	}
});

test("h1 response body types round-trip", async () => {
	const server = await start(app);
	try {
		const json = await (await fetch(`${server.url}json`)).json();
		assert.deepStrictEqual(json, { ok: true, n: 42 });

		const bytes = new Uint8Array(
			await (await fetch(`${server.url}bytes`)).arrayBuffer(),
		);
		assert.deepStrictEqual([...bytes], [1, 2, 3, 4]);

		assert.strictEqual(
			await (await fetch(`${server.url}blob`)).text(),
			"blob-body",
		);
	} finally {
		await server.close();
	}
});

for (const [path, status, body] of [
	["created", 201, "made"],
	["empty", 204, ""],
	["teapot", 418, "no coffee"],
	["missing", 404, "not found"],
]) {
	test(`h1 status ${status} at /${path}`, async () => {
		const server = await start(app);
		try {
			const res = await fetch(`${server.url}${path}`);
			assert.strictEqual(res.status, status);
			assert.strictEqual(await res.text(), body);
		} finally {
			await server.close();
		}
	});
}

test("h1 redirect status and Location pass through without following", async () => {
	const server = await start(app);
	try {
		const res = await fetch(`${server.url}redirect`, { redirect: "manual" });
		assert.strictEqual(res.status, 301);
		assert.match(res.headers.get("location"), /\/there$/);
	} finally {
		await server.close();
	}
});

test("h1 HEAD returns headers and no body", async () => {
	const server = await start(
		() => new Response("body-here", { headers: { "content-length": "9" } }),
	);
	try {
		const res = await fetch(server.url, { method: "HEAD" });
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get("content-length"), "9");
		assert.strictEqual(await res.text(), "");
	} finally {
		await server.close();
	}
});

// ------------------------------------------------------------------ HTTP/2 ---

for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
	test(`h2 ${method} reaches the handler`, async () => {
		const server = await start(app, { tls });
		const client = h2connect(server, cert);
		try {
			const res = await h2request(client, {
				":method": method,
				":path": "/method",
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.body, method);
		} finally {
			client.destroy();
			await server.close();
		}
	});
}

test("h2 POST body echoes back", async () => {
	const server = await start(app, { tls });
	const client = h2connect(server, cert);
	try {
		const res = await h2request(
			client,
			{ ":method": "POST", ":path": "/echo" },
			"payload",
		);
		assert.strictEqual(res.headers["x-echo"], "1");
		assert.strictEqual(res.body, "payload");
	} finally {
		client.destroy();
		await server.close();
	}
});

test("h2 status codes and body types", async () => {
	const server = await start(app, { tls });
	const client = h2connect(server, cert);
	try {
		const json = await h2request(client, { ":path": "/json" });
		assert.deepStrictEqual(JSON.parse(json.body), { ok: true, n: 42 });

		const created = await h2request(client, { ":path": "/created" });
		assert.strictEqual(created.status, 201);

		const empty = await h2request(client, { ":path": "/empty" });
		assert.strictEqual(empty.status, 204);
		assert.strictEqual(empty.body, "");

		const teapot = await h2request(client, { ":path": "/teapot" });
		assert.strictEqual(teapot.status, 418);
		assert.strictEqual(teapot.body, "no coffee");

		const missing = await h2request(client, { ":path": "/missing" });
		assert.strictEqual(missing.status, 404);
	} finally {
		client.destroy();
		await server.close();
	}
});
