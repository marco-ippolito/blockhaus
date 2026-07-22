import assert from "node:assert";
import net from "node:net";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { start } from "./helpers.js";

test("byte-oriented Web Streams round-trip all octets across tiny chunks", async () => {
	const expected = Uint8Array.from({ length: 256 }, (_, index) => index);
	const server = await start(async (ctx) => {
		const received = new Uint8Array(await ctx.request.arrayBuffer());
		assert.deepStrictEqual(received, expected);
		let offset = 0;
		return new Response(
			new ReadableStream({
				type: "bytes",
				pull(controller) {
					if (offset === received.length) return controller.close();
					controller.enqueue(received.slice(offset, ++offset));
				},
			}),
		);
	});
	try {
		const body = new ReadableStream({
			type: "bytes",
			start(controller) {
				for (const byte of expected) controller.enqueue(Uint8Array.of(byte));
				controller.close();
			},
		});
		const response = await fetch(server.url, {
			method: "POST",
			body,
			duplex: "half",
		});
		assert.deepStrictEqual(
			new Uint8Array(await response.arrayBuffer()),
			expected,
		);
	} finally {
		await server.close();
	}
});

test("Node pipeline consumes a fragmented request with backpressure", async () => {
	const expected = Buffer.alloc(512 * 1024, 0x61);
	let writes = 0;
	const server = await start(async (ctx) => {
		const chunks = [];
		const slowSink = new Writable({
			highWaterMark: 1,
			write(chunk, _encoding, callback) {
				writes++;
				chunks.push(Buffer.from(chunk));
				setImmediate(callback);
			},
		});
		await pipeline(Readable.fromWeb(ctx.request.body), slowSink);
		return new Response(Buffer.concat(chunks));
	});
	try {
		const body = Readable.toWeb(
			Readable.from(
				(function* () {
					for (let offset = 0; offset < expected.length; offset += 997) {
						yield expected.subarray(offset, offset + 997);
					}
				})(),
			),
		);
		const response = await fetch(server.url, {
			method: "POST",
			body,
			duplex: "half",
		});
		assert.deepStrictEqual(Buffer.from(await response.arrayBuffer()), expected);
		assert.ok(writes > 1);
	} finally {
		await server.close();
	}
});

test("disconnecting during a response cancels its Web Stream exactly once", async () => {
	const cancelled = Promise.withResolvers();
	let cancelCalls = 0;
	const server = await start(() => {
		return new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array(64 * 1024));
				},
				cancel(reason) {
					cancelCalls++;
					cancelled.resolve(reason);
				},
			}),
		);
	});
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((resolve, reject) => {
			socket.once("error", reject);
			socket.once("connect", resolve);
		});
		const received = new Promise((resolve) => socket.once("data", resolve));
		socket.write("GET / HTTP/1.1\r\nHost: victim\r\n\r\n");
		await received;
		socket.destroy();
		await cancelled.promise;
		assert.strictEqual(cancelCalls, 1);

		const healthy = await fetch(server.url);
		const reader = healthy.body.getReader();
		await reader.read();
		await reader.cancel();
	} finally {
		await server.close({ force: true });
	}
});

test("an already-aborted upload never destabilizes later requests", async () => {
	let aborts = 0;
	const server = await start(async (ctx) => {
		try {
			await ctx.request.text();
		} catch {
			aborts++;
		}
		return new Response("ok");
	});
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((resolve) => socket.once("connect", resolve));
		socket.end(
			"POST / HTTP/1.1\r\nHost: victim\r\nContent-Length: 999999\r\n\r\nshort",
		);
		await new Promise((resolve) => socket.once("close", resolve));
		assert.strictEqual(aborts, 1);
		const response = await fetch(server.url, {
			method: "POST",
			body: "complete",
		});
		assert.strictEqual(await response.text(), "ok");
	} finally {
		await server.close({ force: true });
	}
});
