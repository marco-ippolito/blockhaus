import assert from "node:assert";
import dgram from "node:dgram";
import http2 from "node:http2";
import net from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { withTrailers } from "../lib/index.js";
import { cert, key } from "./fixtures/tls.js";
import { start } from "./helpers.js";

const hasQuic = process.features.quic === true;

test("HTTP/1 CONNECT establishes a backpressured tunnel", async () => {
	const server = await start({
		fetch: () => new Response("ordinary"),
		connect: () => new PassThrough(),
	});
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((resolve) => socket.once("connect", resolve));
		const response = readUntil(socket, "\r\n\r\n");
		socket.write(
			"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
		);
		assert.match(await response, /^HTTP\/1\.1 200 Connection Established/);
		const echoed = new Promise((resolve) => socket.once("data", resolve));
		socket.write("tunnel-data");
		assert.strictEqual((await echoed).toString(), "tunnel-data");
		socket.destroy();
	} finally {
		await server.close({ force: true });
	}
});

test("HTTP/1 CONNECT preserves payload coalesced with the headers", async () => {
	const server = await start({
		fetch: () => new Response("unused"),
		connect: () => new PassThrough(),
	});
	const socket = net.connect(server.port, server.hostname);
	try {
		const chunks = [];
		socket.on("data", (chunk) => chunks.push(chunk));
		await new Promise((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		socket.write(
			"CONNECT target:443 HTTP/1.1\r\nHost: target:443\r\n\r\nearly",
		);
		const output = await new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("tunnel payload timed out")),
				1_000,
			);
			socket.on("data", () => {
				const value = Buffer.concat(chunks).toString();
				if (value.includes("early")) {
					clearTimeout(timer);
					resolve(value);
				}
			});
		});
		assert.match(output, /^HTTP\/1\.1 200 Connection Established/);
		assert.match(output, /early$/);
	} finally {
		socket.destroy();
		await server.close({ force: true });
	}
});

test("HTTP/2 CONNECT establishes a tunnel", async () => {
	const server = await start(
		{
			fetch: () => new Response("ordinary"),
			connect: () => new PassThrough(),
		},
		{ tls: { key, cert } },
	);
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const stream = client.request({
			":method": "CONNECT",
			":authority": "example.com:443",
		});
		const headers = await new Promise((resolve) =>
			stream.once("response", resolve),
		);
		assert.strictEqual(headers[":status"], 200);
		const echoed = new Promise((resolve) => stream.once("data", resolve));
		stream.write("h2-tunnel");
		assert.strictEqual((await echoed).toString(), "h2-tunnel");
		stream.close();
		client.destroy();
	} finally {
		await server.close({ force: true });
	}
});

test("HTTP/2 CONNECT rejection preserves response headers and body", async () => {
	const server = await start(
		{
			fetch: () => new Response("ordinary"),
			connect: () =>
				new Response("proxy denied", {
					status: 407,
					headers: { "proxy-authenticate": "Basic realm=proxy" },
				}),
		},
		{ tls: { key, cert } },
	);
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const stream = client.request({
			":method": "CONNECT",
			":authority": "example.com:443",
		});
		const headers = await new Promise((resolve) =>
			stream.once("response", resolve),
		);
		const chunks = [];
		stream.on("data", (chunk) => chunks.push(chunk));
		await new Promise((resolve) => stream.once("end", resolve));
		assert.strictEqual(headers[":status"], 407);
		assert.strictEqual(headers["proxy-authenticate"], "Basic realm=proxy");
		assert.strictEqual(Buffer.concat(chunks).toString(), "proxy denied");
		client.destroy();
	} finally {
		await server.close({ force: true });
	}
});

test("HTTP/3 CONNECT establishes a tunnel", { skip: !hasQuic }, async () => {
	const server = await start(
		{
			fetch: () => new Response("ordinary"),
			connect: () => new PassThrough(),
		},
		{ tls: { key, cert }, quic: true },
	);
	try {
		const session = await connectH3(server.port);
		const received = Promise.withResolvers();
		const stream = await session.createBidirectionalStream({
			onheaders: received.resolve,
		});
		stream.sendHeaders({
			":method": "CONNECT",
			":authority": "example.com:443",
		});
		assert.strictEqual(String((await received.promise)[":status"]), "200");
		stream.writer.writeSync(Buffer.from("h3-tunnel"));
		const { value } = await stream[Symbol.asyncIterator]().next();
		assert.strictEqual(
			Buffer.concat(value.map((chunk) => Buffer.from(chunk))).toString(),
			"h3-tunnel",
		);
		stream.destroy();
		await session.close();
	} finally {
		await server.close({ force: true });
	}
});

test("HTTP/3 CONNECT rejection preserves response headers and body", {
	skip: !hasQuic,
}, async () => {
	const server = await start(
		{
			fetch: () => new Response("ordinary"),
			connect: () =>
				new Response("proxy denied", {
					status: 407,
					headers: { "proxy-authenticate": "Basic realm=proxy" },
				}),
		},
		{ tls: { key, cert }, quic: true },
	);
	try {
		const session = await connectH3(server.port);
		const received = Promise.withResolvers();
		const stream = await session.createBidirectionalStream({
			headers: {
				":method": "CONNECT",
				":authority": "example.com:443",
			},
			onheaders: received.resolve,
		});
		const headers = await received.promise;
		const chunks = [];
		for await (const batch of stream) {
			for (const chunk of batch) chunks.push(Buffer.from(chunk));
		}
		assert.strictEqual(String(headers[":status"]), "407");
		assert.strictEqual(headers["proxy-authenticate"], "Basic realm=proxy");
		assert.strictEqual(Buffer.concat(chunks).toString(), "proxy denied");
		await session.close();
	} finally {
		await server.close({ force: true });
	}
});

test("requestTimeout returns 408 on a stuck HTTP/2 handler", async () => {
	const server = await start(() => new Promise(() => {}), {
		tls: { key, cert },
		requestTimeout: 100,
	});
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const stream = client.request({ ":path": "/" });
		const headers = await new Promise((resolve) =>
			stream.once("response", resolve),
		);
		assert.strictEqual(headers[":status"], 408);
		client.destroy();
	} finally {
		await server.close({ force: true });
	}
});

test("requestTimeout returns 408 on a stuck HTTP/3 handler", {
	skip: !hasQuic,
}, async () => {
	const server = await start(() => new Promise(() => {}), {
		tls: { key, cert },
		requestTimeout: 100,
		quic: true,
	});
	try {
		const session = await connectH3(server.port);
		const response = Promise.withResolvers();
		await session.createBidirectionalStream({
			headers: h3Headers(server.port),
			onheaders: response.resolve,
		});
		assert.strictEqual(String((await response.promise)[":status"]), "408");
		await session.close();
	} finally {
		await server.close({ force: true });
	}
});

test("maxRequestBodySize rejects HTTP/1, HTTP/2, and HTTP/3", {
	skip: !hasQuic,
}, async () => {
	const server = await start(
		async (ctx) => new Response(await ctx.request.text()),
		{
			tls: { key, cert },
			maxRequestBodySize: 4,
			quic: true,
		},
	);
	try {
		const h1 = await rawRequest(
			server,
			"POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nConnection: close\r\n\r\n12345",
			true,
		);
		assert.match(h1, /^HTTP\/1\.1 413 /);

		const h2 = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const h2stream = h2.request({
			":method": "POST",
			":path": "/",
			"content-length": "5",
		});
		const h2headers = await new Promise((resolve) =>
			h2stream.once("response", resolve),
		);
		assert.strictEqual(h2headers[":status"], 413);
		h2.destroy();

		const h3 = await connectH3(server.port);
		const h3response = Promise.withResolvers();
		await h3.createBidirectionalStream({
			headers: {
				...h3Headers(server.port),
				":method": "POST",
				"content-length": "5",
			},
			body: Buffer.from("12345"),
			onheaders: h3response.resolve,
		});
		assert.strictEqual(String((await h3response.promise)[":status"]), "413");
		await h3.close();
	} finally {
		await server.close({ force: true });
	}
});

test("HTTP/3 enforces body limits on GET even though Fetch hides the body", {
	skip: !hasQuic,
}, async () => {
	const server = await start(() => new Response("must not win"), {
		tls: { key, cert },
		quic: true,
		maxRequestBodySize: 4,
	});
	try {
		const session = await connectH3(server.port);
		const response = Promise.withResolvers();
		await session.createBidirectionalStream({
			headers: h3Headers(server.port),
			body: Buffer.from("12345"),
			onheaders: response.resolve,
		});
		assert.strictEqual(String((await response.promise)[":status"]), "413");
		await session.close();
	} finally {
		await server.close({ force: true });
	}
});

test("HTTP/3 ctx.trailers resolves when a request has no trailers", {
	skip: !hasQuic,
}, async () => {
	const server = await start(
		async (ctx) => {
			assert.strictEqual(await ctx.request.text(), "body");
			assert.deepStrictEqual([...(await ctx.trailers)], []);
			return new Response("done");
		},
		{ tls: { key, cert }, quic: true },
	);
	try {
		const session = await connectH3(server.port);
		const response = Promise.withResolvers();
		const stream = await session.createBidirectionalStream({
			headers: { ...h3Headers(server.port), ":method": "POST" },
			body: Buffer.from("body"),
			onheaders: response.resolve,
		});
		assert.strictEqual(String((await response.promise)[":status"]), "200");
		await stream.closed;
		await session.close();
	} finally {
		await server.close({ force: true });
	}
});

test("request trailers are exposed on HTTP/1", async () => {
	const server = await start(async (ctx) => {
		await ctx.request.text();
		return new Response((await ctx.trailers).get("x-checksum"));
	});
	try {
		const raw = await rawRequest(
			server,
			"POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\ndata\r\n0\r\nX-Checksum: abc\r\n\r\n",
		);
		assert.match(raw, /\r\n\r\n3\r\nabc\r\n0\r\n\r\n$/);
	} finally {
		await server.close();
	}
});

test("response trailers are sent on HTTP/1", async () => {
	const server = await start(() =>
		withTrailers(new Response("body"), { "x-checksum": "abc" }),
	);
	try {
		const raw = await rawRequest(
			server,
			"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
		);
		assert.match(raw, /trailer: x-checksum/i);
		assert.match(raw, /0\r\nx-checksum: abc\r\n\r\n$/i);
	} finally {
		await server.close();
	}
});

test("request and response trailers work over HTTP/2", async () => {
	const server = await start(
		async (ctx) => {
			await ctx.request.text();
			const requestTrailer = (await ctx.trailers).get("x-request-checksum");
			return withTrailers(new Response(requestTrailer), {
				"x-response-checksum": "response-ok",
			});
		},
		{ tls: { key, cert } },
	);
	try {
		const client = http2.connect(`https://localhost:${server.port}`, {
			ca: cert,
		});
		const stream = client.request(
			{ ":method": "POST", ":path": "/" },
			{ waitForTrailers: true },
		);
		stream.on("wantTrailers", () =>
			stream.sendTrailers({ "x-request-checksum": "request-ok" }),
		);
		const responseTrailers = Promise.withResolvers();
		stream.on("trailers", responseTrailers.resolve);
		const chunks = [];
		stream.on("data", (chunk) => chunks.push(chunk));
		stream.end("body");
		await new Promise((resolve) => stream.once("end", resolve));
		assert.strictEqual(Buffer.concat(chunks).toString(), "request-ok");
		assert.strictEqual(
			(await responseTrailers.promise)["x-response-checksum"],
			"response-ok",
		);
		client.destroy();
	} finally {
		await server.close();
	}
});

test("response trailers work over HTTP/3", {
	skip: hasQuic
		? "Node's experimental QUIC body API does not currently request trailers"
		: true,
}, async () => {
	const server = await start(
		async (ctx) => {
			assert.strictEqual(await ctx.request.text(), "body");
			return withTrailers(new Response("ok"), {
				"x-response-checksum": "response-ok",
			});
		},
		{ tls: { key, cert }, quic: true },
	);
	try {
		const session = await connectH3(server.port);
		const responseTrailers = Promise.withResolvers();
		const stream = await session.createBidirectionalStream({
			headers: { ...h3Headers(server.port), ":method": "POST" },
			body: Buffer.from("body"),
			ontrailers: responseTrailers.resolve,
		});
		const chunks = [];
		for await (const batch of stream) {
			for (const chunk of batch) chunks.push(Buffer.from(chunk));
		}
		assert.strictEqual(Buffer.concat(chunks).toString(), "ok");
		assert.strictEqual(
			(await responseTrailers.promise)["x-response-checksum"],
			"response-ok",
		);
		await session.close();
	} finally {
		await server.close();
	}
});

test("response content-length mismatch destroys HTTP/1 connection", async () => {
	const server = await start(
		() => new Response("short", { headers: { "content-length": "10" } }),
	);
	try {
		const raw = await rawRequest(
			server,
			"GET / HTTP/1.1\r\nHost: localhost\r\n\r\nGET /again HTTP/1.1\r\nHost: localhost\r\n\r\n",
		);
		assert.strictEqual((raw.match(/HTTP\/1\.1 200/g) ?? []).length, 1);
		assert.ok(!raw.includes("0\r\n\r\n"));
	} finally {
		await server.close({ force: true });
	}
});

test("graceful close terminates an idle HTTP/3 session", {
	skip: hasQuic
		? "Node QUIC does not currently notify an idle peer when its endpoint is destroyed"
		: true,
}, async () => {
	const server = await start(() => new Response("ok"), {
		tls: { key, cert },
		quic: true,
	});
	const session = await connectH3(server.port);
	try {
		await server.close({ timeout: 1_000 });
		await Promise.race([
			session.closed.catch(() => {}),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("peer session stayed open")), 1_000),
			),
		]);
	} finally {
		if (!session.destroyed) session.destroy();
	}
});

test("shutdownTimeout escalates a stuck request to forced close", async () => {
	const entered = Promise.withResolvers();
	const server = await start(
		() => {
			entered.resolve();
			return new Promise(() => {});
		},
		{ shutdownTimeout: 100 },
	);
	const socket = net.connect(server.port, server.hostname);
	socket.on("error", () => {}); // expect a reset once the server escalates
	await new Promise((resolve) => socket.once("connect", resolve));
	socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
	await entered.promise; // the handler is now stuck in-flight
	const started = Date.now();
	await server.close();
	assert.ok(Date.now() - started < 2_000);
	await new Promise((resolve) =>
		socket.destroyed ? resolve() : socket.once("close", resolve),
	);
	assert.ok(socket.destroyed);
});

test("close is idempotent and force can escalate an in-progress close", async () => {
	const server = await start(() => new Promise(() => {}));
	const request = fetch(server.url).catch(() => null);
	await new Promise((resolve) => setTimeout(resolve, 20));
	const graceful = server.close({ timeout: 5_000 });
	await Promise.all([server.close({ force: true }), server.close(), graceful]);
	await request;
});

test("H3 startup failure rolls back the already-bound TCP listener", {
	skip: hasQuic
		? "Node QUIC enables UDP address reuse, so collision cannot induce startup failure"
		: true,
}, async () => {
	const udp = dgram.createSocket("udp4");
	await new Promise((resolve) =>
		udp.bind({ port: 0, address: "127.0.0.1", exclusive: true }, resolve),
	);
	const port = udp.address().port;
	await assert.rejects(
		start(() => new Response("ok"), { port, tls: { key, cert }, quic: true }),
	);
	udp.close();
	await new Promise((resolve) => udp.once("close", resolve));
	const probe = net.createServer();
	await new Promise((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(port, "127.0.0.1", resolve);
	});
	await new Promise((resolve) => probe.close(resolve));
});

test("TLS handshake timeout drops clients that never start TLS", async () => {
	const server = await start(() => new Response("ok"), {
		tls: { key, cert },
		tlsHandshakeTimeout: 100,
	});
	try {
		const socket = net.connect(server.port, server.hostname);
		await new Promise((resolve) => socket.once("connect", resolve));
		await new Promise((resolve) => socket.once("close", resolve));
		assert.ok(socket.destroyed);
	} finally {
		await server.close({ force: true });
	}
});

test("onError observes handler failures without affecting the 500 response", async () => {
	const observed = Promise.withResolvers();
	const server = await start(
		() => {
			throw new Error("visible failure");
		},
		{ onError: observed.resolve },
	);
	try {
		const response = await fetch(server.url);
		assert.strictEqual(response.status, 500);
		assert.strictEqual((await observed.promise).message, "visible failure");
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

function h3Headers(port) {
	return {
		":method": "GET",
		":path": "/",
		":scheme": "https",
		":authority": `localhost:${port}`,
	};
}

function readUntil(socket, marker) {
	return new Promise((resolve, reject) => {
		let data = "";
		const onData = (chunk) => {
			data += chunk.toString();
			if (data.includes(marker)) {
				socket.off("data", onData);
				resolve(data);
			}
		};
		socket.on("data", onData);
		socket.once("error", reject);
	});
}

async function rawRequest(server, request, tls = false) {
	const socket = tls
		? (await import("node:tls")).connect({
				host: server.hostname,
				port: server.port,
				ca: cert,
				ALPNProtocols: ["http/1.1"],
			})
		: net.connect(server.port, server.hostname);
	await new Promise((resolve, reject) => {
		socket.once(tls ? "secureConnect" : "connect", resolve);
		socket.once("error", reject);
	});
	const chunks = [];
	socket.on("data", (chunk) => chunks.push(chunk));
	socket.end(request);
	await new Promise((resolve) => socket.once("close", resolve));
	return Buffer.concat(chunks).toString();
}
