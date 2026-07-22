import assert from "node:assert";
import { test } from "node:test";
import { Server, serve } from "../lib/index.js";
import { cert, key } from "./fixtures/tls.js";
import { start } from "./helpers.js";

const handler = { fetch: () => new Response("ok") };

test("serve returns a Server synchronously, not a promise", () => {
	const server = serve(handler);
	assert.ok(server instanceof Server);
	assert.strictEqual(server.port, null);
});

test("listen is idempotent and resolves to the server", async () => {
	const server = serve(handler);
	try {
		const a = server.listen({ port: 0 });
		const b = server.listen();
		assert.strictEqual(a, b);
		assert.strictEqual(await a, server);
		assert.ok(server.port > 0);
	} finally {
		await server.close();
	}
});

test("port 0 assigns an ephemeral port and url reflects the scheme", async () => {
	const server = await start(handler);
	try {
		assert.ok(server.port > 0);
		assert.strictEqual(server.url, `http://127.0.0.1:${server.port}/`);
	} finally {
		await server.close();
	}
});

test("url uses https when TLS is configured", async () => {
	const server = await start(handler, { tls: { key, cert } });
	try {
		assert.strictEqual(server.url, `https://127.0.0.1:${server.port}/`);
	} finally {
		await server.close();
	}
});

test("address() returns the bound address", async () => {
	const server = await start(handler);
	try {
		const addr = server.address();
		assert.strictEqual(addr.address, "127.0.0.1");
		assert.strictEqual(addr.port, server.port);
	} finally {
		await server.close();
	}
});

test("protocols reflect the active set", async () => {
	const plaintext = await start(handler);
	try {
		assert.deepStrictEqual(plaintext.protocols, ["h1", "h2"]);
	} finally {
		await plaintext.close();
	}

	const secure = await start(handler, { tls: { key, cert } });
	try {
		assert.deepStrictEqual(secure.protocols, ["h1", "h2"]);
	} finally {
		await secure.close();
	}

	const h1Only = await start(handler, {
		tls: { key, cert, alpn: ["h1"] },
	});
	try {
		assert.deepStrictEqual(h1Only.protocols, ["h1"]);
	} finally {
		await h1Only.close();
	}
});

test("readonly server metadata cannot be overwritten", async () => {
	const server = await start(handler);
	try {
		assert.throws(() => {
			server.port = 1;
		}, TypeError);
		assert.throws(() => {
			server.hostname = "attacker.invalid";
		}, TypeError);
		assert.throws(() => {
			server.protocols = ["h3"];
		}, TypeError);
		assert.throws(() => server.protocols.push("h3"), TypeError);
		assert.notStrictEqual(server.port, 1);
		assert.strictEqual(server.hostname, "127.0.0.1");
		assert.deepStrictEqual(server.protocols, ["h1", "h2"]);
	} finally {
		await server.close();
	}
});

test("close is idempotent", async () => {
	const server = await start(handler);
	await Promise.all([server.close(), server.close(), server.close()]);
	await assert.rejects(fetch(`http://${server.hostname}:${server.port}/`));
});

test("closed resolves and stays resolved", async () => {
	const server = await start(handler);
	await server.close();
	await server.closed;
	// resolving again returns the same settled promise
	await server.closed;
	assert.ok(true);
});

test("await using closes the server on scope exit", async () => {
	let ref;
	{
		await using server = serve(handler, { port: 0 });
		await server.listen();
		ref = server;
		assert.strictEqual((await fetch(server.url)).status, 200);
	}
	await ref.closed;
	await assert.rejects(fetch(ref.url));
});

test("a fresh serve() does not listen until asked", async () => {
	const server = serve(handler);
	assert.strictEqual(server.port, null);
	assert.deepStrictEqual(server.protocols, []);
	await server.listen({ port: 0 });
	assert.ok(server.port > 0);
	await server.close();
});

test("listen is rejected after close before binding", async () => {
	const server = serve(handler);
	await server.close();
	await assert.rejects(
		server.listen({ port: 0 }),
		/cannot listen while server is closed/,
	);
});

test("listen is rejected after destroy before binding", async () => {
	const server = serve(handler);
	server.destroy();
	await server.closed;
	await assert.rejects(
		server.listen({ port: 0 }),
		/cannot listen while server is closed/,
	);
});
