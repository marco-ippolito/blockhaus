import assert from "node:assert";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { writeResponse } from "../lib/h1/serializer.js";

async function serialize(response, opts) {
	const socket = new PassThrough();
	const collected = [];
	socket.on("data", (c) => collected.push(c));
	await writeResponse(socket, response, opts);
	return Buffer.concat(collected).toString();
}

test("body without explicit content-length is chunked", async () => {
	// undici's Response hides the body source length behind private fields,
	// so fixed strings frame as chunked unless the handler sets content-length.
	const out = await serialize(new Response("hello", { status: 200 }));
	assert.match(out, /^HTTP\/1\.1 200 OK\r\n/);
	assert.match(out, /transfer-encoding: chunked\r\n/);
	assert.match(out, /connection: keep-alive\r\n/);
	assert.ok(out.includes("5\r\nhello\r\n0\r\n\r\n"));
});

test("null body gets content-length: 0", async () => {
	const out = await serialize(new Response(null, { status: 200 }));
	assert.match(out, /content-length: 0\r\n/);
});

test("stream body without content-length is chunked", async () => {
	const body = new ReadableStream({
		start(c) {
			c.enqueue(new TextEncoder().encode("hel"));
			c.enqueue(new TextEncoder().encode("lo"));
			c.close();
		},
	});
	const out = await serialize(new Response(body));
	assert.match(out, /transfer-encoding: chunked\r\n/);
	assert.ok(out.includes("3\r\nhel\r\n2\r\nlo\r\n0\r\n\r\n"));
});

test("HEAD omits the body but keeps framing headers", async () => {
	const out = await serialize(
		new Response("hello", { headers: { "content-length": "5" } }),
		{ isHead: true },
	);
	assert.match(out, /content-length: 5\r\n/);
	assert.ok(out.endsWith("\r\n\r\n"));
});

test("204 has no body and no content-length", async () => {
	const out = await serialize(new Response(null, { status: 204 }));
	assert.doesNotMatch(out, /content-length/);
	assert.match(out, /^HTTP\/1\.1 204 No Content\r\n/);
});

test("connection: close when keep-alive disabled", async () => {
	const out = await serialize(new Response("x"), { keepAlive: false });
	assert.match(out, /connection: close\r\n/);
});

test("alt-svc advertised when provided", async () => {
	const out = await serialize(new Response("x"), {
		altSvc: 'h3=":443"; ma=86400',
	});
	assert.match(out, /alt-svc: h3=":443"; ma=86400\r\n/);
});

test("set-cookie headers are split", async () => {
	const headers = new Headers();
	headers.append("set-cookie", "a=1");
	headers.append("set-cookie", "b=2");
	const out = await serialize(new Response("x", { headers }));
	assert.match(out, /set-cookie: a=1\r\n/);
	assert.match(out, /set-cookie: b=2\r\n/);
});

test("respects an explicit content-length from the response", async () => {
	const body = new ReadableStream({
		start(c) {
			c.enqueue(new TextEncoder().encode("12345"));
			c.close();
		},
	});
	const out = await serialize(
		new Response(body, { headers: { "content-length": "5" } }),
	);
	assert.match(out, /content-length: 5\r\n/);
	assert.doesNotMatch(out, /transfer-encoding/);
	assert.ok(out.endsWith("\r\n\r\n12345"));
});

for (const value of ["", "00", "01", "+1", "-1", "1.0", "1x"]) {
	test(`rejects invalid response content-length ${JSON.stringify(value)}`, async () => {
		await assert.rejects(
			serialize(new Response("x", { headers: { "content-length": value } })),
			/invalid response content-length/,
		);
	});
}

test("rejects response content-length above the safe integer range", async () => {
	await assert.rejects(
		serialize(
			new Response("x", {
				headers: { "content-length": "9007199254740992" },
			}),
		),
		/response content-length is too large/,
	);
});
