import assert from "node:assert";
import { test } from "node:test";
import { H1Parser } from "../lib/h1/parser.js";

function collect() {
	const events = {
		messages: [],
		chunks: [],
		completions: [],
		errors: [],
	};
	const parser = new H1Parser({
		onHeaders: (m) => events.messages.push(structuredClone(m)),
		onData: (chunk) => events.chunks.push(Buffer.from(chunk)),
		onMessageComplete: (info) => events.completions.push(info),
		onError: (code, description) => events.errors.push({ code, description }),
	});
	return { parser, events };
}

test("parses a simple GET", () => {
	const { parser, events } = collect();
	parser.feed(
		Buffer.from(
			"GET /hello?x=1 HTTP/1.1\r\nHost: example\r\nAccept: */*\r\n\r\n",
		),
	);

	assert.strictEqual(events.messages.length, 1);
	const m = events.messages[0];
	assert.strictEqual(m.method, "GET");
	assert.strictEqual(m.url, "/hello?x=1");
	assert.strictEqual(m.version, "1.1");
	assert.deepStrictEqual(m.headers, [
		["Host", "example"],
		["Accept", "*/*"],
	]);
	assert.strictEqual(m.hasBody, false);
	assert.strictEqual(m.connectionClose, false);
	assert.strictEqual(events.completions.length, 1);
	parser.destroy();
});

test("parses byte-by-byte feeding", () => {
	const { parser, events } = collect();
	const raw = "GET /split HTTP/1.1\r\nHost: h\r\n\r\n";
	for (const byte of Buffer.from(raw)) parser.feed(Buffer.from([byte]));

	assert.strictEqual(events.messages.length, 1);
	assert.strictEqual(events.messages[0].url, "/split");
	assert.strictEqual(events.completions.length, 1);
	parser.destroy();
});

test("content-length body arrives via onData", () => {
	const { parser, events } = collect();
	parser.feed(
		Buffer.from(
			"POST /b HTTP/1.1\r\nHost: h\r\nContent-Length: 11\r\n\r\nhello world",
		),
	);

	assert.strictEqual(events.messages[0].hasBody, true);
	assert.strictEqual(Buffer.concat(events.chunks).toString(), "hello world");
	assert.strictEqual(events.completions.length, 1);
	parser.destroy();
});

test("chunked body arrives via onData across feeds", () => {
	const { parser, events } = collect();
	parser.feed(
		Buffer.from(
			"POST /c HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n",
		),
	);
	parser.feed(Buffer.from("5\r\nhello\r\n"));
	parser.feed(Buffer.from("6\r\n world\r\n"));
	parser.feed(Buffer.from("0\r\n\r\n"));

	assert.strictEqual(events.messages[0].hasBody, true);
	assert.strictEqual(Buffer.concat(events.chunks).toString(), "hello world");
	assert.strictEqual(events.completions.length, 1);
	parser.destroy();
});

test("pipelined requests in one feed", () => {
	const { parser, events } = collect();
	parser.feed(
		Buffer.from(
			"GET /a HTTP/1.1\r\nHost: h\r\n\r\nGET /b HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n",
		),
	);

	assert.strictEqual(events.messages.length, 2);
	assert.strictEqual(events.messages[0].url, "/a");
	assert.strictEqual(events.messages[1].url, "/b");
	assert.strictEqual(events.messages[0].connectionClose, false);
	assert.strictEqual(events.messages[1].connectionClose, true);
	assert.strictEqual(events.completions.length, 2);
	parser.destroy();
});

test("two parsers are independent (shared wasm instance)", () => {
	const a = collect();
	const b = collect();
	a.parser.feed(Buffer.from("GET /from-a HTTP/1.1\r\nHo"));
	b.parser.feed(
		Buffer.from(
			"POST /from-b HTTP/1.1\r\nHost: h\r\nContent-Length: 2\r\n\r\nzz",
		),
	);
	a.parser.feed(Buffer.from("st: h\r\n\r\n"));

	assert.strictEqual(a.events.messages[0].url, "/from-a");
	assert.strictEqual(b.events.messages[0].url, "/from-b");
	assert.strictEqual(Buffer.concat(b.events.chunks).toString(), "zz");
	a.parser.destroy();
	b.parser.destroy();
});

test("garbage input reports a parse error", () => {
	const { parser, events } = collect();
	parser.feed(Buffer.from("THIS IS NOT HTTP\r\n\r\n"));

	assert.strictEqual(events.errors.length, 1);
	assert.strictEqual(parser.failed, true);
	// subsequent feeds are ignored
	parser.feed(Buffer.from("GET / HTTP/1.1\r\n\r\n"));
	assert.strictEqual(events.messages.length, 0);
	parser.destroy();
});
