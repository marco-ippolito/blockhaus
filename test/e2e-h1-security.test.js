import assert from "node:assert";
import net from "node:net";
import { test } from "node:test";
import { rawRequest, start } from "./helpers.js";

const SMUGGLED =
	"GET /smuggled HTTP/1.1\r\nHost: victim\r\nConnection: close\r\n\r\n";

async function rejectsAmbiguousRequest(name, request) {
	test(name, async () => {
		const seen = [];
		const server = await start((ctx) => {
			seen.push(new URL(ctx.request.url).pathname);
			return new Response("handled");
		});
		try {
			const output = await rawRequest(server, request);
			assert.match(output, /HTTP\/1\.1 400 /);
			assert.ok(
				!seen.includes("/smuggled"),
				"smuggled request reached handler",
			);
		} finally {
			await server.close({ force: true });
		}
	});
}

await rejectsAmbiguousRequest(
	"rejects CL.TE request smuggling",
	"POST / HTTP/1.1\r\nHost: victim\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n" +
		SMUGGLED,
);

await rejectsAmbiguousRequest(
	"rejects TE.CL request smuggling",
	"POST / HTTP/1.1\r\nHost: victim\r\nTransfer-Encoding: chunked\r\nContent-Length: 40\r\n\r\n0\r\n\r\n" +
		SMUGGLED,
);

await rejectsAmbiguousRequest(
	"rejects duplicate conflicting Content-Length values",
	"POST / HTTP/1.1\r\nHost: victim\r\nContent-Length: 0\r\nContent-Length: 62\r\n\r\n" +
		SMUGGLED,
);

await rejectsAmbiguousRequest(
	"rejects comma-separated Content-Length ambiguity",
	`POST / HTTP/1.1\r\nHost: victim\r\nContent-Length: 0, 62\r\n\r\n${SMUGGLED}`,
);

await rejectsAmbiguousRequest(
	"rejects signed Content-Length values",
	`POST / HTTP/1.1\r\nHost: victim\r\nContent-Length: +0\r\n\r\n${SMUGGLED}`,
);

await rejectsAmbiguousRequest(
	"rejects unsupported transfer codings before chunked",
	"POST / HTTP/1.1\r\nHost: victim\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n" +
		SMUGGLED,
);

await rejectsAmbiguousRequest(
	"rejects repeated chunked transfer coding",
	"POST / HTTP/1.1\r\nHost: victim\r\nTransfer-Encoding: chunked, chunked\r\n\r\n0\r\n\r\n" +
		SMUGGLED,
);

await rejectsAmbiguousRequest(
	"rejects whitespace before a framing header colon",
	"POST / HTTP/1.1\r\nHost: victim\r\nTransfer-Encoding : chunked\r\n\r\n0\r\n\r\n" +
		SMUGGLED,
);

await rejectsAmbiguousRequest(
	"rejects Connection nominating Content-Length",
	"POST / HTTP/1.1\r\nHost: victim\r\nConnection: content-length\r\nContent-Length: 0\r\n\r\n" +
		SMUGGLED,
);

await rejectsAmbiguousRequest(
	"rejects duplicate Host headers",
	`GET / HTTP/1.1\r\nHost: victim\r\nHost: attacker\r\n\r\n${SMUGGLED}`,
);

await rejectsAmbiguousRequest(
	"rejects absolute-form authority and Host disagreement",
	"GET http://attacker.example/smuggled HTTP/1.1\r\nHost: victim\r\n\r\n",
);

await rejectsAmbiguousRequest(
	"rejects CONNECT authority and Host disagreement",
	"CONNECT attacker.example:443 HTTP/1.1\r\nHost: victim:443\r\n\r\n",
);

await rejectsAmbiguousRequest(
	"rejects a missing Host header",
	`GET / HTTP/1.1\r\nConnection: keep-alive\r\n\r\n${SMUGGLED}`,
);

await rejectsAmbiguousRequest(
	"rejects GET requests carrying a declared body",
	`GET / HTTP/1.1\r\nHost: victim\r\nContent-Length: 1\r\n\r\nx${SMUGGLED}`,
);

await rejectsAmbiguousRequest(
	"rejects HEAD requests carrying a chunked body",
	"HEAD / HTTP/1.1\r\nHost: victim\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n" +
		SMUGGLED,
);

await rejectsAmbiguousRequest(
	"rejects forbidden framing fields in trailers",
	"POST / HTTP/1.1\r\nHost: victim\r\nTransfer-Encoding: chunked\r\nTrailer: Content-Length\r\n\r\n" +
		"1\r\nx\r\n0\r\nContent-Length: 40\r\n\r\n" +
		SMUGGLED,
);

await rejectsAmbiguousRequest(
	"rejects forbidden trailer declarations before reading a body",
	"POST / HTTP/1.1\r\nHost: victim\r\nTransfer-Encoding: chunked\r\nTrailer: Transfer-Encoding\r\n\r\n" +
		"0\r\n\r\n" +
		SMUGGLED,
);

await rejectsAmbiguousRequest(
	"rejects malformed chunk sizes without parsing following bytes",
	"POST / HTTP/1.1\r\nHost: victim\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\n" +
		SMUGGLED,
);

await rejectsAmbiguousRequest(
	"rejects obsolete folded headers",
	`GET / HTTP/1.1\r\nHost: victim\r\nX-Test: one\r\n two\r\n\r\n${SMUGGLED}`,
);

await rejectsAmbiguousRequest(
	"rejects bare-LF request framing",
	`GET / HTTP/1.1\nHost: victim\n\n${SMUGGLED}`,
);

await rejectsAmbiguousRequest(
	"strictly rejects even identical duplicate Content-Length fields",
	"POST / HTTP/1.1\r\nHost: victim\r\nContent-Length: 4\r\nContent-Length: 4\r\n\r\ntest",
);

async function responseBeforeBodyFailure({ options = {}, suffix }) {
	const server = await start(() => new Response("early"), options);
	try {
		const socket = net.connect(server.port, server.hostname);
		const chunks = [];
		socket.on("data", (chunk) => chunks.push(chunk));
		await new Promise((resolve) => socket.once("connect", resolve));
		socket.write(
			"POST / HTTP/1.1\r\nHost: victim\r\nTransfer-Encoding: chunked\r\n\r\n",
		);
		await new Promise((resolve) => socket.once("data", resolve));
		socket.write(suffix);
		await new Promise((resolve) => socket.once("close", resolve));
		return Buffer.concat(chunks).toString();
	} finally {
		await server.close({ force: true });
	}
}

test("late malformed chunks close without emitting a second response", async () => {
	const output = await responseBeforeBodyFailure({ suffix: "Z\r\n" });
	assert.strictEqual((output.match(/HTTP\/1\.1 /g) ?? []).length, 1);
	assert.match(output, /^HTTP\/1\.1 200 /);
	assert.ok(!output.includes("400 Bad Request"));
});

test("late body-limit failures close without emitting a second response", async () => {
	const output = await responseBeforeBodyFailure({
		options: { maxRequestBodySize: 2 },
		suffix: "3\r\nabc\r\n0\r\n\r\n",
	});
	assert.strictEqual((output.match(/HTTP\/1\.1 /g) ?? []).length, 1);
	assert.match(output, /^HTTP\/1\.1 200 /);
	assert.ok(!output.includes("413 Content Too Large"));
});
