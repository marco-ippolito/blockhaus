import assert from "node:assert";
import http2 from "node:http2";
import { test } from "node:test";
import { cert, key } from "./fixtures/tls.js";
import { rawRequest, start } from "./helpers.js";

test("Request is constructed only when the handler accesses ctx.request", async () => {
	const OriginalRequest = globalThis.Request;
	let constructions = 0;
	globalThis.Request = class CountingRequest extends OriginalRequest {
		constructor(...args) {
			super(...args);
			constructions++;
		}
	};
	const server = await start((ctx) => {
		if (ctx.httpVersion === "never") return new Response(ctx.request.url);
		return new Response(null, { status: 204 });
	});
	try {
		await rawRequest(
			server,
			"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
		);
		assert.strictEqual(constructions, 0);
	} finally {
		globalThis.Request = OriginalRequest;
		await server.close();
	}
});

test("lazy Request construction still preserves POST body draining", async () => {
	const OriginalRequest = globalThis.Request;
	let constructions = 0;
	globalThis.Request = class CountingRequest extends OriginalRequest {
		constructor(...args) {
			super(...args);
			constructions++;
		}
	};
	const server = await start(() => new Response("ok"));
	try {
		const response = await rawRequest(
			server,
			"POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbody",
		);
		assert.match(response, /^HTTP\/1\.1 200 /);
		assert.strictEqual(constructions, 0);
	} finally {
		globalThis.Request = OriginalRequest;
		await server.close();
	}
});

test("HTTP/2 also avoids Request construction when it is unused", async () => {
	const OriginalRequest = globalThis.Request;
	let constructions = 0;
	globalThis.Request = class CountingRequest extends OriginalRequest {
		constructor(...args) {
			super(...args);
			constructions++;
		}
	};
	const server = await start(() => new Response(null, { status: 204 }), {
		tls: { key, cert },
	});
	const client = http2.connect(`https://localhost:${server.port}`, {
		ca: cert,
	});
	try {
		const stream = client.request({ ":path": "/" });
		stream.resume();
		stream.end();
		await new Promise((resolve) => stream.once("end", resolve));
		assert.strictEqual(constructions, 0);
	} finally {
		globalThis.Request = OriginalRequest;
		client.destroy();
		await server.close();
	}
});
