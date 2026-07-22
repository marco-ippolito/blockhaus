import assert from "node:assert";
import http2 from "node:http2";
import net from "node:net";
import { test } from "node:test";
import { cert, key } from "./fixtures/tls.js";
import { h2connect, start } from "./helpers.js";

const tls = { key, cert };
const {
	NGHTTP2_REFUSED_STREAM,
	NGHTTP2_CANCEL,
	NGHTTP2_INTERNAL_ERROR,
	NGHTTP2_CONNECT_ERROR,
} = http2.constants;

// ---------------------------------------------------------------- deny() -----

for (const [reason, code] of [
	["rejected", NGHTTP2_REFUSED_STREAM],
	["cancelled", NGHTTP2_CANCEL],
	["internal", NGHTTP2_INTERNAL_ERROR],
	["connect", NGHTTP2_CONNECT_ERROR],
]) {
	test(`h2 deny('${reason}') resets the stream with the matching code`, async () => {
		const server = await start((ctx) => ctx.deny(reason), { tls });
		const client = h2connect(server, cert);
		client.on("error", () => {});
		try {
			const rst = await new Promise((resolve) => {
				const req = client.request({ ":path": "/" });
				req.on("error", () => {});
				req.on("close", () => resolve(req.rstCode));
				req.end();
			});
			assert.strictEqual(rst, code);
			await new Promise((resolve) => client.close(resolve));
		} finally {
			await server.close({ force: true });
		}
	});
}

test("h2 deny('goaway') sends a GOAWAY to the client", async () => {
	const server = await start((ctx) => ctx.deny("goaway"), { tls });
	const client = h2connect(server, cert);
	client.on("error", () => {});
	const goaway = Promise.withResolvers();
	client.on("goaway", () => goaway.resolve("goaway"));
	try {
		const req = client.request({ ":path": "/" });
		req.on("error", () => {});
		req.end();
		const result = await Promise.race([
			goaway.promise,
			new Promise((r) => setTimeout(() => r("none"), 1_000)),
		]);
		assert.strictEqual(result, "goaway");
	} finally {
		await server.close({ force: true });
	}
});

test("an unknown deny reason falls back to a retry-safe reset", async () => {
	const server = await start((ctx) => ctx.deny("nonsense"), { tls });
	const client = h2connect(server, cert);
	client.on("error", () => {});
	try {
		const rst = await new Promise((resolve) => {
			const req = client.request({ ":path": "/" });
			req.on("error", () => {});
			req.on("close", () => resolve(req.rstCode));
			req.end();
		});
		assert.strictEqual(rst, NGHTTP2_REFUSED_STREAM);
		await new Promise((resolve) => client.close(resolve));
	} finally {
		await server.close({ force: true });
	}
});

test("deny() on h1 drops the connection whatever the reason", async () => {
	const server = await start((ctx) => ctx.deny("internal"));
	try {
		await assert.rejects(fetch(server.url));
	} finally {
		await server.close({ force: true });
	}
});

// ------------------------------------------------------ sendInformational ----

test("multiple interim responses precede the final one over h1", async () => {
	const server = await start((ctx) => {
		ctx.sendInformational(103, { link: "</a.css>; rel=preload" });
		ctx.sendInformational(103, { link: "</b.css>; rel=preload" });
		return new Response("done");
	});
	try {
		const socket = net.connect(server.port, server.hostname);
		socket.on("error", () => {});
		await new Promise((r) => socket.once("connect", r));
		const chunks = [];
		socket.on("data", (c) => chunks.push(c));
		socket.write("GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n");
		await new Promise((r) => socket.once("close", r));
		const out = Buffer.concat(chunks).toString();
		assert.strictEqual((out.match(/HTTP\/1\.1 103 /g) ?? []).length, 2);
		assert.match(out, /a\.css/);
		assert.match(out, /b\.css/);
		assert.ok(out.lastIndexOf("103") < out.indexOf("200"));
	} finally {
		await server.close();
	}
});

test("sendInformational accepts no headers argument", async () => {
	const server = await start((ctx) => {
		ctx.sendInformational(103);
		return new Response("ok");
	});
	try {
		assert.strictEqual((await fetch(server.url)).status, 200);
	} finally {
		await server.close();
	}
});

test("sendInformational rejects 101 without an upgrade handler", async () => {
	let message;
	const server = await start((ctx) => {
		try {
			ctx.sendInformational(101);
		} catch (error) {
			message = error.message;
		}
		return new Response("ok");
	});
	try {
		assert.strictEqual((await fetch(server.url)).status, 200);
		assert.match(message, /requires an upgrade handler/);
	} finally {
		await server.close();
	}
});

// --------------------------------------------------------------- waitUntil ---

test("waitUntil rejections go to onError, not the client", async () => {
	const errors = [];
	const server = await start(
		(ctx) => {
			ctx.waitUntil(Promise.reject(new Error("background boom")));
			return new Response("ok");
		},
		{ onError: (error) => errors.push(error) },
	);
	const res = await fetch(server.url);
	assert.strictEqual(res.status, 200);
	assert.strictEqual(await res.text(), "ok");
	await server.close();
	assert.ok(errors.some((e) => e.message === "background boom"));
});

// ----------------------------------------------------------------- destroy ---

test("destroy(error) reports the error to onError", async () => {
	const errors = [];
	const server = await start(() => new Promise(() => {}), {
		onError: (error) => errors.push(error),
	});
	fetch(server.url).catch(() => {});
	await new Promise((r) => setTimeout(r, 30));
	server.destroy(new Error("shutdown now"));
	await server.closed;
	assert.ok(errors.some((e) => e.message === "shutdown now"));
});

// -------------------------------------------------------------------- busy ---

test("busy can be toggled repeatedly", async () => {
	const server = await start(() => new Response("live"));
	try {
		assert.strictEqual((await fetch(server.url)).status, 200);
		server.busy = true;
		assert.strictEqual((await fetch(server.url)).status, 503);
		server.busy = false;
		assert.strictEqual((await fetch(server.url)).status, 200);
		server.busy = true;
		assert.strictEqual((await fetch(server.url)).status, 503);
	} finally {
		await server.close();
	}
});
