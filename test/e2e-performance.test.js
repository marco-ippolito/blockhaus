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

test("fast request metadata avoids Fetch Request construction over h1", async () => {
	const OriginalRequest = globalThis.Request;
	let constructions = 0;
	globalThis.Request = class CountingRequest extends OriginalRequest {
		constructor(...args) {
			super(...args);
			constructions++;
		}
	};
	const server = await start((ctx) => {
		assert.strictEqual(ctx.method, "GET");
		const url = new URL(ctx.url);
		assert.strictEqual(url.pathname, "/fast");
		assert.strictEqual(url.search, "?value=1");
		assert.strictEqual(ctx.header("X-FAST"), "one, two");
		assert.strictEqual(ctx.header("x-missing"), null);
		assert.throws(() => ctx.header("bad header"), TypeError);
		return new Response(null, { status: 204 });
	});
	try {
		const response = await rawRequest(
			server,
			"GET /fast?value=1 HTTP/1.1\r\nHost: localhost\r\nX-Fast: one\r\nX-Fast: two\r\nConnection: close\r\n\r\n",
		);
		assert.match(response, /^HTTP\/1\.1 204 /);
		assert.strictEqual(constructions, 0);
	} finally {
		globalThis.Request = OriginalRequest;
		await server.close();
	}
});

test("fast request metadata avoids Fetch Request construction over h2", async () => {
	const OriginalRequest = globalThis.Request;
	let constructions = 0;
	globalThis.Request = class CountingRequest extends OriginalRequest {
		constructor(...args) {
			super(...args);
			constructions++;
		}
	};
	const server = await start(
		(ctx) => {
			assert.strictEqual(ctx.method, "GET");
			assert.strictEqual(new URL(ctx.url).pathname, "/fast");
			assert.strictEqual(ctx.header("X-FAST"), "value");
			return new Response("fast-h2", { status: 202 });
		},
		{ tls: { key, cert } },
	);
	const client = http2.connect(`https://localhost:${server.port}`, {
		ca: cert,
	});
	try {
		const stream = client.request({ ":path": "/fast", "x-fast": "value" });
		let status;
		let body = "";
		stream.setEncoding("utf8");
		stream.once("response", (headers) => {
			status = headers[":status"];
		});
		stream.on("data", (chunk) => {
			body += chunk;
		});
		stream.end();
		await new Promise((resolve) => stream.once("end", resolve));
		assert.strictEqual(status, 202);
		assert.strictEqual(body, "fast-h2");
		assert.strictEqual(constructions, 0);
	} finally {
		globalThis.Request = OriginalRequest;
		client.destroy();
		await server.close();
	}
});
