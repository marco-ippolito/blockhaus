import assert from "node:assert";
import https from "node:https";
import { test } from "node:test";
import { cert, key } from "./fixtures/tls.js";
import { start } from "./helpers.js";

// HTTP/3 needs a QUIC-enabled binary: compiled with `./configure
// --experimental-quic` AND run with `--experimental-quic`. Official release
// binaries ship with QUIC compiled out, so these tests self-skip there.
const hasQuic = process.features.quic === true;
const tls = { key, cert };

test("full h3 request/response round trip", { skip: !hasQuic }, async () => {
	const server = await start(
		async (ctx) => {
			const body = ctx.request.body ? await ctx.request.text() : "nobody";
			return new Response(
				`h3:${ctx.httpVersion}:${ctx.alpnProtocol}:${new URL(ctx.request.url).pathname}:${body}`,
			);
		},
		{ tls, quic: true },
	);
	try {
		assert.ok(server.protocols.includes("h3"));
		const { connect } = await import("node:quic");
		const session = await connect(
			{ address: "127.0.0.1", port: server.port },
			{
				alpn: "h3",
				servername: "localhost",
				ca: Buffer.from(cert),
			},
		);
		const { promise: headersReceived, resolve: onHeaders } =
			Promise.withResolvers();
		const stream = await session.createBidirectionalStream({
			headers: {
				":method": "GET",
				":path": "/hello",
				":scheme": "https",
				":authority": `localhost:${server.port}`,
			},
			onheaders: onHeaders,
		});
		const resHeaders = await headersReceived;
		const chunks = [];
		// the QuicStream iterator yields Uint8Array[] batches
		for await (const batch of stream) {
			for (const c of batch) chunks.push(Buffer.from(c));
		}
		assert.strictEqual(String(resHeaders[":status"]), "200");
		assert.strictEqual(
			Buffer.concat(chunks).toString(),
			"h3:3:h3:/hello:nobody",
		);
		await session.close();
	} finally {
		await server.close();
	}
});

test("h3 POST body round-trips", { skip: !hasQuic }, async () => {
	const server = await start(
		async (ctx) =>
			ctx.request.method === "POST"
				? new Response(await ctx.request.text())
				: new Response("nope", { status: 405 }),
		{ tls, quic: true },
	);
	try {
		const { connect } = await import("node:quic");
		const session = await connect(
			{ address: "127.0.0.1", port: server.port },
			{ alpn: "h3", servername: "localhost", ca: Buffer.from(cert) },
		);
		const payload = "q".repeat(64 * 1024);
		const { promise: headersReceived, resolve: onHeaders } =
			Promise.withResolvers();
		const stream = await session.createBidirectionalStream({
			headers: {
				":method": "POST",
				":path": "/echo",
				":scheme": "https",
				":authority": `localhost:${server.port}`,
			},
			body: Uint8Array.from(Buffer.from(payload)),
			onheaders: onHeaders,
		});
		const resHeaders = await headersReceived;
		const chunks = [];
		for await (const batch of stream) {
			for (const c of batch) chunks.push(Buffer.from(c));
		}
		assert.strictEqual(String(resHeaders[":status"]), "200");
		assert.strictEqual(Buffer.concat(chunks).toString(), payload);
		await session.close();
	} finally {
		await server.close();
	}
});

test("h3 streaming response arrives incrementally", {
	skip: !hasQuic,
}, async () => {
	const server = await start(
		() => {
			const body = new ReadableStream({
				async start(c) {
					c.enqueue(new TextEncoder().encode("first-"));
					await new Promise((r) => setTimeout(r, 10));
					c.enqueue(new TextEncoder().encode("second"));
					c.close();
				},
			});
			return new Response(body);
		},
		{ tls, quic: true },
	);
	try {
		const { connect } = await import("node:quic");
		const session = await connect(
			{ address: "127.0.0.1", port: server.port },
			{ alpn: "h3", servername: "localhost", ca: Buffer.from(cert) },
		);
		const stream = await session.createBidirectionalStream({
			headers: {
				":method": "GET",
				":path": "/stream",
				":scheme": "https",
				":authority": `localhost:${server.port}`,
			},
		});
		const chunks = [];
		for await (const batch of stream) {
			for (const c of batch) chunks.push(Buffer.from(c));
		}
		assert.strictEqual(Buffer.concat(chunks).toString(), "first-second");
		await session.close();
	} finally {
		await server.close();
	}
});

test("h3 endpoint starts and Alt-Svc is advertised on h1", {
	skip: !hasQuic,
}, async () => {
	const server = await start(() => new Response("over-tcp"), {
		tls,
		quic: true,
	});
	try {
		assert.ok(server.protocols.includes("h3"));
		const res = await new Promise((resolve, reject) => {
			https
				.get(`https://localhost:${server.port}/`, { ca: cert }, resolve)
				.on("error", reject);
		});
		res.resume();
		assert.strictEqual(
			res.headers["alt-svc"],
			`h3=":${server.port}"; ma=86400`,
		);
	} finally {
		await server.close();
	}
});

test("h3 silently dropped when QUIC is unavailable", {
	skip: hasQuic,
}, async () => {
	const server = await start(() => new Response("ok"), {
		tls,
		quic: true,
	});
	try {
		assert.deepStrictEqual(server.protocols, ["h1", "h2"]);
		const res = await new Promise((resolve, reject) => {
			https
				.get(`https://localhost:${server.port}/`, { ca: cert }, resolve)
				.on("error", reject);
		});
		res.resume();
		assert.strictEqual(res.headers["alt-svc"], undefined);
	} finally {
		await server.close();
	}
});

test("HEAD over h3 omits and cancels the response body", {
	skip: !hasQuic,
}, async () => {
	const cancelled = Promise.withResolvers();
	const server = await start(
		() =>
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.enqueue(new TextEncoder().encode("must-not-be-sent"));
					},
					cancel() {
						cancelled.resolve();
					},
				}),
				{ headers: { "x-head": "yes" } },
			),
		{ tls, quic: true },
	);
	try {
		const session = await connectH3(server.port);
		const response = await h3Request(session, server.port, {
			method: "HEAD",
		});
		assert.strictEqual(String(response.headers[":status"]), "200");
		assert.strictEqual(response.headers["x-head"], "yes");
		assert.strictEqual(response.body.length, 0);
		await cancelled.promise;
		await session.close();
	} finally {
		await server.close();
	}
});

test("h3 preserves duplicate request headers and response cookies", {
	skip: !hasQuic,
}, async () => {
	const server = await start(
		(ctx) => {
			const headers = new Headers({
				"x-combined": ctx.request.headers.get("x-many"),
			});
			headers.append("set-cookie", "a=1; Path=/");
			headers.append("set-cookie", "b=2; HttpOnly");
			return new Response("ok", { headers });
		},
		{ tls, quic: true },
	);
	try {
		const session = await connectH3(server.port);
		const response = await h3Request(session, server.port, {
			headers: { "x-many": ["one", "two"] },
		});
		assert.strictEqual(response.headers["x-combined"], "one, two");
		assert.deepStrictEqual(response.headers["set-cookie"], [
			"a=1; Path=/",
			"b=2; HttpOnly",
		]);
		await session.close();
	} finally {
		await server.close();
	}
});

test("many concurrent h3 streams complete independently", {
	skip: !hasQuic,
}, async () => {
	const server = await start(
		async (ctx) => {
			const id = new URL(ctx.request.url).pathname.slice(1);
			await new Promise((resolve) => setTimeout(resolve, Number(id) % 5));
			return new Response(id);
		},
		{ tls, quic: true },
	);
	try {
		const session = await connectH3(server.port);
		const responses = await Promise.all(
			Array.from({ length: 32 }, (_, id) =>
				h3Request(session, server.port, { path: `/${id}` }),
			),
		);
		assert.deepStrictEqual(
			responses.map(({ body }) => body.toString()),
			Array.from({ length: 32 }, (_, id) => String(id)),
		);
		await session.close();
	} finally {
		await server.close();
	}
});

test("h3 client reset aborts ctx.signal and leaves the session healthy", {
	skip: !hasQuic,
}, async () => {
	const aborted = Promise.withResolvers();
	const entered = Promise.withResolvers();
	const release = Promise.withResolvers();
	const server = await start(
		async (ctx) => {
			if (new URL(ctx.request.url).pathname === "/cancel") {
				ctx.signal.addEventListener("abort", aborted.resolve, { once: true });
				entered.resolve();
				await release.promise;
			}
			return new Response("healthy");
		},
		{ tls, quic: true },
	);
	try {
		const session = await connectH3(server.port);
		const stream = await session.createBidirectionalStream({
			headers: requestHeaders(server.port, "GET", "/cancel"),
		});
		stream.onerror = () => {};
		stream.closed.catch(() => {});
		await entered.promise;
		stream.resetStream(42n);
		await aborted.promise;
		release.resolve();
		const response = await h3Request(session, server.port, {
			path: "/after",
		});
		assert.strictEqual(response.body.toString(), "healthy");
		await session.close();
	} finally {
		release.resolve();
		await server.close();
	}
});

test("large h3 request and response cross flow-control windows", {
	skip: !hasQuic,
}, async () => {
	const server = await start((ctx) => new Response(ctx.request.body), {
		tls,
		quic: true,
	});
	try {
		const session = await connectH3(server.port);
		const payload = Buffer.alloc(2 * 1024 * 1024, "z");
		const response = await h3Request(session, server.port, {
			method: "POST",
			path: "/large",
			body: payload,
		});
		assert.deepStrictEqual(response.body, payload);
		await session.close();
	} finally {
		await server.close();
	}
});

test("handler failures become 500 responses over h3", {
	skip: !hasQuic,
}, async () => {
	const server = await start(
		() => {
			throw new Error("boom");
		},
		{ tls, quic: true },
	);
	try {
		const session = await connectH3(server.port);
		const response = await h3Request(session, server.port);
		assert.strictEqual(String(response.headers[":status"]), "500");
		assert.strictEqual(response.body.toString(), "Internal Server Error");
		await session.close();
	} finally {
		await server.close();
	}
});

async function connectH3(port) {
	const { connect } = await import("node:quic");
	return connect(
		{ address: "127.0.0.1", port },
		{ alpn: "h3", servername: "localhost", ca: Buffer.from(cert) },
	);
}

function requestHeaders(port, method = "GET", path = "/", headers = {}) {
	return {
		":method": method,
		":path": path,
		":scheme": "https",
		":authority": `localhost:${port}`,
		...headers,
	};
}

async function h3Request(
	session,
	port,
	{ method = "GET", path = "/", headers = {}, body } = {},
) {
	const received = Promise.withResolvers();
	const stream = await session.createBidirectionalStream({
		headers: requestHeaders(port, method, path, headers),
		...(body === undefined ? {} : { body: Uint8Array.from(body) }),
		onheaders: received.resolve,
	});
	const responseHeaders = await received.promise;
	const chunks = [];
	for await (const batch of stream) {
		for (const chunk of batch) chunks.push(Buffer.from(chunk));
	}
	return { headers: responseHeaders, body: Buffer.concat(chunks) };
}
