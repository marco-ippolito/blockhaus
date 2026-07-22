import assert from "node:assert";
import net from "node:net";
import { describe, test } from "node:test";
import { start } from "./helpers.js";

const SMUGGLED =
	"GET /smuggled HTTP/1.1\r\nHost: victim\r\nConnection: close\r\n\r\n";

function exchange(server, fragments) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(server.port, server.hostname);
		const chunks = [];
		socket.on("data", (chunk) => chunks.push(chunk));
		socket.on("error", reject);
		socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
		socket.once("connect", async () => {
			try {
				for (const fragment of fragments) {
					if (!socket.write(fragment)) {
						await new Promise((ready) => socket.once("drain", ready));
					}
				}
			} catch (error) {
				socket.destroy();
				reject(error);
			}
		});
	});
}

const rejected = [
	["negative content-length", "Content-Length: -1\r\n", "x"],
	["explicitly positive content-length", "Content-Length: +1\r\n", "x"],
	["hex content-length", "Content-Length: 0x10\r\n", ""],
	["decimal content-length", "Content-Length: 1.0\r\n", "x"],
	["exponent content-length", "Content-Length: 1e1\r\n", "x"],
	["comma-joined identical content-length", "Content-Length: 0, 0\r\n", ""],
	["empty content-length", "Content-Length:\r\n", ""],
	["content-length with an internal tab", "Content-Length: 1\t0\r\n", ""],
	["overflowing content-length", `Content-Length: ${"9".repeat(100)}\r\n`, ""],
	[
		"transfer-encoding with an empty token",
		"Transfer-Encoding: chunked,\r\n",
		"0\r\n\r\n",
	],
	[
		"transfer-encoding with a leading empty token",
		"Transfer-Encoding: ,chunked\r\n",
		"0\r\n\r\n",
	],
	["transfer-encoding identity", "Transfer-Encoding: identity\r\n", ""],
	["transfer-encoding gzip", "Transfer-Encoding: gzip\r\n", ""],
	[
		"chunked followed by another coding",
		"Transfer-Encoding: chunked, gzip\r\n",
		"0\r\n\r\n",
	],
	[
		"two transfer-encoding fields",
		"Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n",
		"0\r\n\r\n",
	],
];

describe("adversarial HTTP/1 framing", () => {
	for (const [name, framing, body] of rejected) {
		test(`rejects ${name} without dispatching appended bytes`, async () => {
			const seen = [];
			const server = await start((ctx) => {
				seen.push(new URL(ctx.url).pathname);
				return new Response("handled");
			});
			try {
				const output = await exchange(server, [
					`POST /first HTTP/1.1\r\nHost: victim\r\n${framing}\r\n${body}${SMUGGLED}`,
				]);
				assert.match(output, /^HTTP\/1\.1 400 /);
				assert.deepStrictEqual(seen, []);
			} finally {
				await server.close({ force: true });
			}
		});
	}

	const malformed = [
		["NUL in target", "GET /safe\0evil HTTP/1.1\r\nHost: victim\r\n\r\n"],
		["NUL in header value", "GET / HTTP/1.1\r\nHost: victim\0evil\r\n\r\n"],
		["bare CR line endings", "GET / HTTP/1.1\rHost: victim\r\r"],
		["mixed CRLF and LF", "GET / HTTP/1.1\r\nHost: victim\n\r\n"],
		["space before Host colon", "GET / HTTP/1.1\r\nHost : victim\r\n\r\n"],
		["tab before Host colon", "GET / HTTP/1.1\r\nHost\t: victim\r\n\r\n"],
		["empty header name", "GET / HTTP/1.1\r\nHost: victim\r\n: value\r\n\r\n"],
		[
			"control byte in header name",
			"GET / HTTP/1.1\r\nHost: victim\r\nX\x01Y: z\r\n\r\n",
		],
		["tab-delimited request line", "GET\t/\tHTTP/1.1\r\nHost: victim\r\n\r\n"],
		[
			"extra request-line token",
			"GET / HTTP/1.1 EXTRA\r\nHost: victim\r\n\r\n",
		],
		["HTTP/1.1 suffix", "GET / HTTP/1.1x\r\nHost: victim\r\n\r\n"],
		[
			"fragment identifier in target",
			"GET /path#fragment HTTP/1.1\r\nHost: victim\r\n\r\n",
		],
	];

	for (const [name, request] of malformed) {
		test(`rejects ${name}`, async () => {
			let calls = 0;
			const server = await start(() => {
				calls++;
				return new Response("unexpected");
			});
			try {
				const output = await exchange(server, [request]);
				assert.match(output, /^HTTP\/1\.1 400 /);
				assert.strictEqual(calls, 0);
			} finally {
				await server.close({ force: true });
			}
		});
	}
});

test("valid chunk extensions, fragmented chunks, trailers, and pipelining coexist", async () => {
	const seen = [];
	const server = await start(async (ctx) => {
		seen.push({
			path: new URL(ctx.url).pathname,
			body: ctx.request.body ? await ctx.request.text() : "",
			trailers: Object.fromEntries(await ctx.trailers),
		});
		return new Response("ok");
	});
	try {
		const request =
			"POST /chunks HTTP/1.1\r\nHost: victim\r\nTransfer-Encoding: ChUnKeD\r\nTrailer: X-Checksum\r\n\r\n" +
			'3;foo=bar\r\nabc\r\n2;quoted="x"\r\nde\r\n0\r\nX-Checksum: yes\r\n\r\n' +
			"GET /after HTTP/1.1\r\nHost: victim\r\nConnection: close\r\n\r\n";
		const output = await exchange(
			server,
			Array.from(Buffer.from(request), (byte) => Buffer.from([byte])),
		);
		assert.strictEqual((output.match(/HTTP\/1\.1 200/g) ?? []).length, 2);
		assert.deepStrictEqual(seen, [
			{ path: "/chunks", body: "abcde", trailers: { "x-checksum": "yes" } },
			{ path: "/after", body: "", trailers: {} },
		]);
	} finally {
		await server.close({ force: true });
	}
});

test("cancelling a request body drains it and preserves the next pipelined request", async () => {
	const seen = [];
	const server = await start(async (ctx) => {
		seen.push(new URL(ctx.url).pathname);
		if (ctx.request.body)
			await ctx.request.body.cancel("handler is uninterested");
		return new Response(new URL(ctx.url).pathname);
	});
	try {
		const output = await exchange(server, [
			"POST /cancel HTTP/1.1\r\nHost: victim\r\nContent-Length: 12\r\n\r\nignored-body" +
				"GET /after HTTP/1.1\r\nHost: victim\r\nConnection: close\r\n\r\n",
		]);
		assert.strictEqual((output.match(/HTTP\/1\.1 200/g) ?? []).length, 2);
		assert.deepStrictEqual(seen, ["/cancel", "/after"]);
		assert.ok(output.includes("/cancel"));
		assert.ok(output.includes("/after"));
	} finally {
		await server.close({ force: true });
	}
});
