import assert from "node:assert";
import { Readable, Transform } from "node:stream";
import { test } from "node:test";
import { start } from "./helpers.js";

test("Web ReadableStream responses preserve empty and binary chunks", async () => {
	const expected = Buffer.from([0, 1, 2, 127, 128, 255]);
	const firstBacking = Uint8Array.from([99, 0, 1, 2, 99]);
	const secondBacking = Uint8Array.from([99, 127, 128, 255, 99]);
	const server = await start(
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array());
						// Exercise non-Buffer views with offsets: the response writer passes
						// these through without copying the surrounding backing bytes.
						controller.enqueue(firstBacking.subarray(1, 4));
						controller.enqueue(new Uint8Array());
						controller.enqueue(secondBacking.subarray(1, 4));
						controller.close();
					},
				}),
			),
	);
	try {
		const response = await fetch(server.url);
		assert.deepStrictEqual(Buffer.from(await response.arrayBuffer()), expected);
	} finally {
		await server.close();
	}
});

test("Node Readable responses interoperate through Readable.toWeb", async () => {
	const server = await start(() => {
		const source = Readable.from(["node-", Buffer.from("stream-"), "response"]);
		return new Response(Readable.toWeb(source));
	});
	try {
		const response = await fetch(server.url);
		assert.strictEqual(await response.text(), "node-stream-response");
	} finally {
		await server.close();
	}
});

test("request Web Streams interoperate with Node transforms", async () => {
	const server = await start(async (ctx) => {
		const uppercase = new Transform({
			transform(chunk, _encoding, callback) {
				callback(null, chunk.toString().toUpperCase());
			},
		});
		Readable.fromWeb(ctx.request.body).pipe(uppercase);
		const chunks = [];
		for await (const chunk of uppercase) chunks.push(chunk);
		return new Response(Buffer.concat(chunks));
	});
	try {
		const body = Readable.toWeb(Readable.from(["mixed-", "case"]));
		const response = await fetch(server.url, {
			method: "POST",
			body,
			duplex: "half",
		});
		assert.strictEqual(await response.text(), "MIXED-CASE");
	} finally {
		await server.close();
	}
});

test("a streamed response is followed by a healthy keep-alive request", async () => {
	let requestNumber = 0;
	const server = await start(() => {
		requestNumber++;
		if (requestNumber === 1) {
			return new Response(Readable.toWeb(Readable.from(["first", "-stream"])));
		}
		return new Response("second-response");
	});
	try {
		const first = await fetch(server.url);
		assert.strictEqual(await first.text(), "first-stream");
		const second = await fetch(server.url);
		assert.strictEqual(await second.text(), "second-response");
	} finally {
		await server.close();
	}
});
