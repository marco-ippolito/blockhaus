import assert from "node:assert";
import http2 from "node:http2";
import { test } from "node:test";
import { start } from "./helpers.js";

const infoHandler = (ctx) =>
	Response.json({ httpVersion: ctx.httpVersion, alpn: ctx.alpnProtocol });

test("h2c prior knowledge routes to the h2 backend", async () => {
	const server = await start(infoHandler);
	try {
		const client = http2.connect(`http://127.0.0.1:${server.port}`);
		const body = await new Promise((resolve, reject) => {
			const req = client.request({ ":path": "/" });
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => resolve(Buffer.concat(chunks).toString()));
			req.on("error", reject);
			req.end();
		});
		client.destroy();
		const parsed = JSON.parse(body);
		assert.strictEqual(parsed.httpVersion, "2");
		assert.strictEqual(parsed.alpn, null);
	} finally {
		await server.close();
	}
});

test("h1 still served on the same plaintext port", async () => {
	const server = await start(infoHandler);
	try {
		const res = await fetch(server.url);
		const parsed = await res.json();
		assert.strictEqual(parsed.httpVersion, "1.1");
	} finally {
		await server.close();
	}
});
