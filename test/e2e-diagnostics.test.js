import assert from "node:assert";
import diagnosticsChannel from "node:diagnostics_channel";
import net from "node:net";
import { test } from "node:test";
import { diagnosticChannels } from "../lib/index.js";
import { start } from "./helpers.js";

function capture(names) {
	const events = [];
	const subscriptions = names.map((name) => {
		const channel = diagnosticsChannel.channel(name);
		const listener = (message) => events.push({ name, message });
		channel.subscribe(listener);
		return { channel, listener };
	});
	return {
		events,
		close() {
			for (const { channel, listener } of subscriptions) {
				channel.unsubscribe(listener);
			}
		},
	};
}

test("diagnostics publish auditable server and request lifecycle events", async () => {
	const audit = capture([
		diagnosticChannels.serverListening,
		diagnosticChannels.requestStart,
		diagnosticChannels.requestEnd,
		diagnosticChannels.requestReject,
		diagnosticChannels.serverClose,
	]);
	let server;
	try {
		server = await start(() => new Response("audited", { status: 201 }));
		const response = await fetch(`${server.url}audit`);
		assert.strictEqual(await response.text(), "audited");
		const probe = net.connect(server.port, server.hostname);
		await new Promise((resolve) => probe.once("connect", resolve));
		const rejected = new Promise((resolve) => probe.once("data", resolve));
		probe.end("GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n");
		await rejected;
		await server.close();

		const events = audit.events.filter(
			({ message }) => message.server === server,
		);
		assert.deepStrictEqual(
			events.map(({ name }) => name),
			[
				diagnosticChannels.serverListening,
				diagnosticChannels.requestStart,
				diagnosticChannels.requestEnd,
				diagnosticChannels.requestReject,
				diagnosticChannels.serverClose,
			],
		);
		const startEvent = events[1].message;
		const endEvent = events[2].message;
		assert.ok(Number.isInteger(startEvent.serverId));
		assert.ok(Number.isInteger(startEvent.requestId));
		assert.strictEqual(startEvent.request.url, `${server.url}audit`);
		assert.strictEqual(startEvent.protocol, "1.1");
		assert.strictEqual(endEvent.requestId, startEvent.requestId);
		assert.strictEqual(endEvent.status, 201);
		assert.strictEqual(endEvent.outcome, "response");
		assert.ok(endEvent.duration >= 0);
		assert.strictEqual(events[3].message.status, 400);
		assert.strictEqual(events[3].message.protocol, "1.1");
		assert.deepStrictEqual(events[0].message.protocols, ["h1", "h2"]);
	} finally {
		audit.close();
		await server?.close();
	}
});

test("diagnostics publish CONNECT decisions and handler errors", async () => {
	const audit = capture([
		diagnosticChannels.connectStart,
		diagnosticChannels.connectEnd,
		diagnosticChannels.error,
	]);
	const server = await start({
		fetch() {
			throw new Error("audit boom");
		},
		connect() {
			return new Response("denied", { status: 403 });
		},
	});
	try {
		assert.strictEqual((await fetch(server.url)).status, 500);
		const socket = net.connect(server.port, server.hostname);
		await new Promise((resolve) => socket.once("connect", resolve));
		const received = new Promise((resolve) => socket.once("data", resolve));
		socket.write("CONNECT target:443 HTTP/1.1\r\nHost: target:443\r\n\r\n");
		await received;
		socket.destroy();

		const events = audit.events.filter(
			({ message }) => message.server === server,
		);
		const error = events.find(
			({ name }) => name === diagnosticChannels.error,
		).message;
		assert.strictEqual(error.error.message, "audit boom");
		assert.strictEqual(error.metadata.phase, "handler");
		const connectStart = events.find(
			({ name }) => name === diagnosticChannels.connectStart,
		).message;
		const connectEnd = events.find(
			({ name }) => name === diagnosticChannels.connectEnd,
		).message;
		assert.strictEqual(connectStart.authority, "target:443");
		assert.strictEqual(connectEnd.requestId, connectStart.requestId);
		assert.strictEqual(connectEnd.status, 403);
		assert.strictEqual(connectEnd.outcome, "result");
	} finally {
		audit.close();
		await server.close();
	}
});
