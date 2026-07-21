import assert from "node:assert";
import { test } from "node:test";
import { serve } from "../lib/index.js";
import { cert, key } from "./fixtures/tls.js";

const handler = { fetch: () => new Response("ok") };

test("serve requires a handler object with a fetch() method", () => {
	assert.throws(() => serve(null), {
		name: "TypeError",
		message: /handler must be an object/,
	});
	assert.throws(() => serve({}), {
		name: "TypeError",
		message: /handler\.fetch must be a function/,
	});
	// a bare function is no longer accepted (clean break)
	assert.throws(() => serve(() => new Response("x")), {
		name: "TypeError",
		message: /handler must be an object/,
	});
});

test("serve validates handler.connect and the protocol marker", () => {
	assert.throws(() => serve({ fetch: () => {}, connect: 5 }), {
		name: "TypeError",
		message: /handler\.connect must be a function/,
	});
	assert.throws(
		() => serve({ [Symbol.for("server.protocol")]: 2, fetch: () => {} }),
		{ name: "TypeError", message: /server\.protocol/ },
	);
	// version 1 marker is accepted
	assert.doesNotThrow(() =>
		serve({ [Symbol.for("server.protocol")]: 1, fetch: () => {} }),
	);
});

for (const [name, options, message] of [
	["invalid port", { port: -1 }, /port/],
	["empty hostname", { hostname: "" }, /hostname/],
	["incomplete TLS", { tls: { key: "key" } }, /tls/],
	["bad tls.alpn", { tls: { key, cert, alpn: ["h4"] } }, /ALPN/],
	["quic without tls", { quic: true }, /HTTP\/3/],
	["non-boolean quic", { quic: "yes" }, /quic/],
	["bad signal", { signal: {} }, /signal/],
	["negative timeout", { requestTimeout: -1 }, /requestTimeout/],
	[
		"infinite timeout",
		{ headersTimeout: Number.POSITIVE_INFINITY },
		/headersTimeout/,
	],
	["non-positive maxConnections", { maxConnections: 0 }, /maxConnections/],
]) {
	test(`serve rejects ${name} synchronously`, () => {
		assert.throws(() => serve(handler, options), message);
	});
}
