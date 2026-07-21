# dodici

[![CI](https://github.com/marco-ippolito/dodici/actions/workflows/ci.yml/badge.svg)](https://github.com/marco-ippolito/dodici/actions/workflows/ci.yml)
[![CodeQL](https://github.com/marco-ippolito/dodici/actions/workflows/codeql.yml/badge.svg)](https://github.com/marco-ippolito/dodici/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

One handler, three HTTP versions. `dodici` runs the same request handler over
HTTP/1.1, HTTP/2, and HTTP/3 on a single port.

```js
import { serve } from "dodici";

const server = serve({
	fetch(ctx) {
		return new Response(`hello over HTTP/${ctx.httpVersion}`);
	},
});

await server.listen({ port: 3000 });
console.log(`listening on ${server.url}`);
```

Requests arrive as standard `Request` objects and you reply with standard
`Response` objects. The same handler works whether the client speaks HTTP/1.1,
HTTP/2, or HTTP/3, so you write it once.

## Install

```sh
npm install dodici
```

Requires Node.js v26 or newer. HTTP/3 additionally requires a build with QUIC
support (see [HTTP/3](#http3)).

## Quick start

A handler is an object with a `fetch` method. Pass it to `serve`, then listen:

```js
import { serve } from "dodici";

const server = serve({
	async fetch(ctx) {
		const url = new URL(ctx.request.url);
		if (url.pathname === "/echo") {
			return new Response(ctx.request.body, { headers: { "x-echo": "1" } });
		}
		return Response.json({ path: url.pathname, from: ctx.remoteAddress.address });
	},
});

await server.listen({ port: 8080 });
```

Passing connection options directly to `serve` starts listening immediately, so
these two forms are equivalent:

```js
// two step
const a = serve(handler);
await a.listen({ port: 8080 });

// one step
const b = serve(handler, { port: 8080 });
await b.listen(); // resolves once the port is bound
```

`serve` is synchronous and returns the server right away. Awaiting
`server.listen()` waits until the socket is bound and `server.port` is set.

## `serve(handler, options?)`

Creates a server and returns it. `handler` is validated synchronously, as are
`options`, so bad input throws from `serve` itself. The only failure that
surfaces later is the port bind, which you get by awaiting `server.listen()`.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `port` | `3000` | TCP port to bind. `0` picks a free port. |
| `hostname` | `"127.0.0.1"` | Address to bind. |
| `tls` | none | `{ key, cert, alpn? }` PEM material. Enables HTTPS. |
| `quic` | `false` | Enable HTTP/3. Requires `tls`. |
| `signal` | none | An `AbortSignal` that closes the server when aborted. |
| `keepAliveTimeout` | `5000` | Close idle connections after this many ms. |
| `headersTimeout` | `60000` | Deadline to receive HTTP/1.1 request headers. |
| `requestTimeout` | `300000` | Deadline for one exchange to complete. |
| `tlsHandshakeTimeout` | `10000` | Deadline to finish the TLS handshake. |
| `shutdownTimeout` | `30000` | Grace period before a graceful close forces. |
| `maxConnections` | `1024` | Reject new connections past this count. |
| `maxConcurrentStreams` | `100` | Per HTTP/2 or HTTP/3 session. |
| `maxHeaderSize` | `16384` | Reject requests with larger header blocks. |
| `maxRequestBodySize` | `10485760` | Reject request bodies larger than this. |
| `onError` | none | `(error, metadata)` called for internal and handler errors. |

Every timeout is in milliseconds. Set one to `0` to disable it.

`tls.alpn` limits which protocols are offered over TLS. It defaults to both
`["h2", "h1"]`; pass `["h1"]` to turn HTTP/2 off, for example. The server maps
`h1` to the standard wire-level ALPN token `http/1.1` internally.

## The handler

```js
const handler = {
	// Optional version marker so a runtime can detect the handler shape.
	[Symbol.for("server.protocol")]: 1,

	async fetch(ctx) {
		return new Response("ok");
	},

	// Optional. Called for CONNECT requests.
	async connect(ctx) {
		return null; // 501 Not Implemented
	},
};
```

`fetch(ctx)` receives a [context](#the-context) and returns a `Response` (or a
promise of one). Returning nothing refuses the request; see
[`ctx.deny`](#ctxdenyreason).

## The context

`ctx` carries the request, information about the connection, and a few server
side capabilities.

### Properties

| Property | Type | Description |
| --- | --- | --- |
| `request` | `Request` | The incoming request. |
| `remoteAddress` | `{ address, port, family }` | The client socket address. |
| `alpnProtocol` | `string \| null` | Negotiated protocol id, or `null` on plaintext. |
| `httpVersion` | `"1.1" \| "2" \| "3"` | The version that carried the request. |
| `signal` | `AbortSignal` | Aborts if the client goes away before you reply. |
| `trailers` | `Promise<Headers>` | Request trailers, available after the body. |
| `denied` | `boolean` | Whether `deny()` has been called. |

```js
async fetch(ctx) {
	// stop downstream work if the client disconnects
	const data = await fetch(upstream, { signal: ctx.signal });

	// read trailers after the body
	await ctx.request.text();
	const checksum = (await ctx.trailers).get("x-checksum");

	return new Response(data.body);
}
```

### `ctx.sendInformational(status, headers?)`

Send an interim `1xx` response before the final one, such as `103` Early Hints.
`status` must be in the range `100` to `199`. On protocols that do not support
interim responses it is silently ignored.

```js
ctx.sendInformational(103, { link: "</style.css>; rel=preload; as=style" });
return new Response(page);
```

### `ctx.deny(reason?)`

Reject the request without sending a response. The stream is reset; on HTTP/1.1,
which has no per-request reset, the connection is dropped instead.

| Reason | Meaning |
| --- | --- |
| `"rejected"` (default) | Refused, safe to retry (including non-idempotent methods). |
| `"cancelled"` | The request was cancelled. |
| `"internal"` | An internal error occurred. |
| `"connect"` | A tunnel or CONNECT target could not be reached. |
| `"goaway"` | Ask the client to stop using this connection. |

```js
async fetch(ctx) {
	if (overCapacity()) ctx.deny(); // retryable
	return new Response("ok");
}
```

Returning `undefined` from `fetch` has the same effect as `ctx.deny()`.

### `ctx.waitUntil(promise)`

Keep the server alive until `promise` settles, even after the response is sent.
A graceful `close()` waits for these promises. Rejections are reported to
`onError`, never sent to the client.

```js
ctx.waitUntil(writeAccessLog(ctx.request));
return new Response("ok");
```

## Diagnostics and auditing

Dodici publishes structured events through `node:diagnostics_channel`. Import
`diagnosticChannels` instead of copying channel-name strings:

```js
import diagnosticsChannel from "node:diagnostics_channel";
import { diagnosticChannels } from "dodici";

diagnosticsChannel.subscribe(diagnosticChannels.requestEnd, (event) => {
	console.log({
		serverId: event.serverId,
		requestId: event.requestId,
		method: event.request.method,
		url: event.request.url,
		status: event.status,
		outcome: event.outcome,
		duration: event.duration,
	});
});
```

| Export key | Channel | Published when |
| --- | --- | --- |
| `serverListening` | `dodici.server.listening` | All configured transports are accepting requests. |
| `serverClose` | `dodici.server.close` | Server teardown has completed. |
| `requestStart` | `dodici.request.start` | A Fetch request is admitted for dispatch. |
| `requestEnd` | `dodici.request.end` | The handler decision settles, before transport serialization. |
| `requestReject` | `dodici.request.reject` | A malformed or over-limit request is rejected before or during dispatch. |
| `connectStart` | `dodici.connect.start` | A CONNECT request is admitted. |
| `connectEnd` | `dodici.connect.end` | The CONNECT handler decision settles. |
| `error` | `dodici.error` | An internal, handler, background, or transport error is observed. |

Request events contain stable per-process `serverId` and per-server
`requestId` values, protocol and remote-address metadata, timestamps, and the
original Web `Request`/`Response` references. CONNECT events include the
authority, headers, signal, result, and status where applicable. Error events
contain the original error and the same metadata sent to `onError`.

No request or response bodies are consumed or copied for diagnostics. Audit
subscribers decide which headers or URLs to retain and should redact secrets
before writing them. As with all `node:diagnostics_channel` subscribers, audit
callbacks must not throw; Node treats subscriber exceptions as uncaught errors.

## The server

`serve` returns a `Server`.

### Properties

| Property | Description |
| --- | --- |
| `port` | The bound port, or `null` before `listen()`. |
| `hostname` | The bound address. |
| `url` | Full origin URL, for example `http://127.0.0.1:8080/`. |
| `protocols` | The protocols actually being served, such as `["h1", "h2", "h3"]`. |
| `busy` | Set `true` to reply `503` to new requests without dispatching them. |
| `closed` | A promise that resolves once the server is fully closed. |

### `server.listen(options?)`

Bind and start serving. Idempotent: later calls return the same promise.
Resolves to the server once the port is bound. Accepts the same connection
options as `serve`.

### `server.close(options?)`

Graceful shutdown. Stops accepting connections, lets in-flight exchanges finish,
and waits for `waitUntil` promises. Options:

- `force`: `true` destroys all connections immediately.
- `timeout`: ms to wait before a graceful close escalates to a forced one
  (defaults to `shutdownTimeout`).

```js
await server.close(); // graceful
await server.close({ force: true }); // immediate
```

### `server.destroy(error?)`

Terminate immediately. In-flight requests are aborted and `waitUntil` promises
are ignored. Returns right away; `server.closed` resolves once teardown is done.

### `server.busy`

While `true`, new requests receive a retryable `503` and are not dispatched to
the handler. Requests already running continue. Useful for brief back pressure,
for example while reloading configuration.

```js
server.busy = true;
await reloadConfig();
server.busy = false;
```

### Automatic cleanup

`Server` implements `Symbol.asyncDispose`, so `await using` closes it for you:

```js
{
	await using server = serve(handler, { port: 0 });
	await server.listen();
	// ... use the server ...
} // gracefully closed here
```

## Protocol negotiation

One TCP port serves both HTTP/1.1 and HTTP/2:

- Over TLS, the protocol is chosen by ALPN (`h2` or `http/1.1`).
- Over plaintext, an HTTP/2 prior-knowledge preface is detected; everything else
  is treated as HTTP/1.1.

HTTP/3 runs on the same port number over UDP. While it is live, HTTP/1.1 and
HTTP/2 responses advertise it with an `Alt-Svc` header so clients can upgrade.

## HTTP/3

HTTP/3 is opt-in with `quic: true` and requires TLS:

```js
const server = serve(handler, { tls: { key, cert }, quic: true });
await server.listen({ port: 443 });
```

QUIC support must be present in the Node.js binary, both compiled in and enabled
at startup. When it is missing, HTTP/3 is dropped without error and
`server.protocols` reports what is actually running:

```js
serve(handler, { tls: { key, cert }, quic: true });
// server.protocols is ["h1", "h2"] on a build without QUIC
```

## HTTP/1.1 is strict

The HTTP/1.1 text protocol is HTTP/1.1 only. There is no HTTP/1.0 or HTTP/0.9
compatibility mode, and malformed framing is rejected rather than guessed.

| Input | Result |
| --- | --- |
| HTTP/1.0 or HTTP/0.9 request | `400`, connection closed |
| obs-fold or bare LF/CR line endings | `400`, connection closed |
| body on `GET` or `HEAD` | `400`, connection closed |
| `Content-Length` and `Transfer-Encoding` together | `400` (smuggling defense) |
| duplicate or non-decimal `Content-Length` | `400` |
| transfer coding other than one `chunked` token | `400` |
| missing or duplicate `Host` | `400` |
| absolute-form or CONNECT authority disagreeing with `Host` | `400` |
| framing/routing fields declared or sent as trailers | `400` |

Once a message is rejected, all later parser callbacks from the same input
buffer are ignored. A pipelined request cannot be dispatched after an ambiguous
message in front of it.

## Behavior notes

- Duplicate request headers are combined into one `a, b` value on every
  protocol, matching Fetch semantics.
- Request targets: origin-form maps onto `scheme://host`; absolute-form is kept
  as sent; `OPTIONS *` becomes `/`. Percent-encoding is never rewritten.
- `Expect: 100-continue` is answered with an interim `100` before the handler
  runs.
- A client that disconnects mid-body errors the handler's `request.body` stream.
- A response body stream that throws destroys that one connection; the client
  sees truncated framing rather than a falsely complete response, and the server
  keeps running.
- Responses without an explicit `content-length` are sent chunked.
- Multiple `Set-Cookie` response headers are preserved individually.

## Development

```sh
nvm use      # v26
npm run check # Biome CI, declarations, all tests, and enforced coverage
npm run fix   # apply Biome-safe formatting and lint fixes
```

`npm test` always runs every regular, security, unit, and end-to-end test with
coverage thresholds enabled. HTTP/3 source is excluded from the stock-runtime
coverage threshold and exercised separately with the QUIC-enabled command
below.

The HTTP/3 tests self-skip on a binary without QUIC support. To run them, use a
QUIC-enabled build:

```sh
/path/to/quic-node --experimental-quic --test test/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

MIT
