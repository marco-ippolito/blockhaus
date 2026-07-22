# Implementation and Verification Report

## Outcome

The reviewed implementation has been hardened across HTTP/1.1, HTTP/2, HTTP/3,
TLS, CONNECT, lifecycle handling, request limits, trailers, and its TypeScript
surface. All runnable tests and lint checks pass.

Final validation:

- Stock Node 26: **238 tests, 219 passed, 19 HTTP/3 tests skipped, 0 failed**.
- QUIC-enabled Node: **236 tests, 232 passed, 4 documented skips, 0 failed**.
- `npm run check` (Biome, TypeScript, and tests): passes.
- QUIC capability check: `process.features.quic === true`.
- Stock source coverage (excluding unavailable HTTP/3): **93.14% lines,
  86.17% branches, 79.84% functions**.

Repository hardening added after the implementation audit:

- Biome 2 as the single formatter and linter, with shared EditorConfig/editor
  settings and a zero-diagnostic CI policy;
- a compile-only TypeScript public API fixture;
- enforced stock-runtime coverage thresholds;
- package-content validation with `npm pack --dry-run`;
- CodeQL, Dependabot, concurrency-cancelled CI, contribution guidance, and a
  private vulnerability reporting policy;
- 21 raw-socket HTTP/1.1 security cases covering CL.TE, TE.CL, duplicate and
  malformed lengths, transfer-coding ambiguity, Host/authority confusion,
  forbidden trailers, body-on-GET/HEAD, malformed chunks, obs-fold, and bare LF.
- a typed `node:diagnostics_channel` audit surface for server lifecycle,
  admitted requests, pre-handler transport rejections, CONNECT decisions, and
  errors, with stable server/request correlation IDs and timing metadata.
- lazy Web `Request` construction across every protocol, allocation-free
  diagnostics when no audit channel is subscribed, and an HTTP/1 throughput
  benchmark reported by a dedicated CI job.

The adversarial pipelining cases found and fixed an additional issue: after one
message was rejected inside a Milo parse callback, later messages parsed from
the same input buffer could still be queued before deferred teardown. Terminal
failure state now suppresses every subsequent callback in that parse call.

The QUIC binary was built from
`/Users/marcoippolito/Documents/projects/forks/node` using the requested
`./configure --ninja --experimental-quic` configuration followed by
`ninja -C out/Release -j 8`. The generated Makefile's parallel forwarding
invoked Ninja with a bare `-j`, so Ninja was run directly with an explicit job
count.

## Implemented corrections

### TLS and lifecycle

- Replaced the socket-identity-dependent custom TLS handshake timer with
  `tls.createServer({ handshakeTimeout })`.
- Established TLS sessions now survive beyond the handshake deadline.
- TLS handshake failures are reported and the affected socket is destroyed.
- Added explicit `created -> binding -> listening -> closing -> closed` state.
- Listen failures are terminal and resolve `closed`; later `listen()` calls no
  longer return a stale rejected promise while claiming the server is reusable.
- AbortSignal listeners are removed at shutdown and startup failure, preventing
  a long-lived signal from retaining closed Server instances.
- `listen()` now rejects after `close()` or `destroy()` instead of resurrecting
  an already-closed server.
- Busy, closing, and closed servers reject new CONNECT admission with a
  retryable 503 response.
- HTTP/3 endpoint shutdown now destroys any server-side sessions that remain
  after the endpoint has closed.

### HTTP/1.1

- Preserved bytes coalesced after CONNECT headers and transferred them to the
  tunnel before resuming the socket.
- Deferred parser destruction until Milo has unwound from its active WASM
  callback, avoiding parser teardown during parsing.
- Added regression coverage for CONNECT headers and initial tunnel payload in
  one TCP write.
- Late malformed chunks and late body-limit violations now close a committed
  exchange without emitting a second HTTP response on the same connection.

### HTTP/2

- Reworked inbound bodies around transport events rather than
  `Readable.toWeb()` consumption alone.
- Request bytes are counted independently of handler consumption.
- Ignored bodies are drained before response commitment, preventing streaming
  requests without `Content-Length` from bypassing `maxRequestBodySize`.
- Abort, reset, close, backpressure, and trailer completion are propagated to
  the Web `ReadableStream`.
- Request trailers no longer race an eager empty-trailer fallback.
- GET and HEAD inbound data are drained rather than left flow-control blocked.
- CONNECT rejection `Response` headers and bodies are serialized completely.

### HTTP/3

- Ignored unlocked request bodies are drained through the size-accounting
  iterator before committing the response.
- GET and HEAD payloads are also drained and size-limited even though Fetch does
  not expose bodies for those methods.
- `ctx.trailers` resolves as soon as an undeclared trailing section is known to
  be absent, avoiding a request/response stream-closure deadlock.
- CONNECT rejection `Response` headers and bodies are serialized completely.
- Trailer absence is resolved from stream closure instead of racing trailing
  HEADERS immediately after DATA completion.
- Backpressure waits remove the listener for the event that loses the race.
- Async response-trailer providers are resolved before installing the QUIC
  API's required synchronous `onwanttrailers` callback.
- Endpoint close cleans retained sessions even where the experimental runtime
  does not complete graceful idle-session signaling.

### API consistency and types

- `sendInformational(101)` is rejected because no Upgrade handoff exists.
- Deferred trailer output is validated centrally against declared names for
  every protocol.
- `withTrailers` is declared in `index.d.ts` in both supported forms.
- `Server.port` is `number | null` and `Server.address()` is declared.
- `port`, `hostname`, and `protocols` are getter-only at runtime, matching their
  readonly TypeScript declarations.
- CONNECT handlers use the runtime contract
  `Duplex | Response | null` (including promises).
- `Context.deny()` consistently accepts `DenyReason`.
- README wording now describes CONNECT only; HTTP Upgrade is not implemented.
- The exported `diagnosticChannels` constants prevent audit integrations from
  depending on copied string literals; diagnostics do not consume bodies or
  copy potentially sensitive headers.

## Test coverage added or strengthened

The suite now covers, among other cases:

- established TLS connections surviving the handshake timeout;
- close/destroy before first listen and attempted relisten;
- 101 rejection without an Upgrade implementation;
- CONNECT payload coalesced with HTTP/1 headers;
- ignored streamed HTTP/2 bodies exceeding the configured limit;
- request and response trailers over HTTP/1 and HTTP/2;
- HTTP/3 round trips, POST bodies, streaming, resets, concurrency, flow
  control, CONNECT and CONNECT rejection responses, request timeouts, POST and
  GET body limits, no-trailer completion, cookies, handler failures, and HEAD
  behavior;
- smuggling defenses for conflicting framing headers;
- abort propagation and early response cleanup;
- shutdown escalation and idempotent close/destroy behavior;
- public API options and lifecycle invariants.

## Remaining findings and limitations

### Experimental Node QUIC limitations

Four checks are intentionally skipped in the QUIC run, with the reason printed
by the test runner:

1. **HTTP/3 response trailers:** the current experimental body API does not
   request trailers when the body completes. Both `pendingTrailers` and the
   documented callback path were exercised; one omits trailers and the other
   can leave the exchange open.
2. **Idle peer shutdown notification:** destroying the server endpoint and its
   retained session does not cause an idle client session's `closed` promise to
   settle reliably.
3. **H3 startup rollback via UDP collision:** the runtime enables UDP address
   reuse, including when another UDP socket requests exclusive binding, so a
   deterministic post-TCP/pre-H3 bind failure cannot be induced this way.
4. The non-QUIC fallback assertion is skipped when QUIC is present by design.

These are explicit gaps, not silent passes. HTTP/3's core request, response,
streaming, reset, limit, timeout, concurrency, flow-control, and CONNECT paths
do execute successfully with the compiled binary.

### Cross-protocol follow-up opportunities

- `maxHeaderSize` still maps onto protocol-specific parser/QPACK/HPACK notions
  rather than one identical wire-byte definition. The option should eventually
  document whether it limits decoded field-section size or encoded wire size.
- HTTP/1 internal transport/parser failures could expose richer structured
  `onError` metadata, matching the multiplexed backends.

CI now builds the upstream `nodejs/node` `main` branch with experimental QUIC
enabled and runs the full suite serially.
Serialization is required because parallel test processes can independently
select the same ephemeral TCP port and then collide while binding UDP for H3.

## Verification commands

```sh
npm test
npm run check
npm run test:coverage
npm pack --dry-run --ignore-scripts

/Users/marcoippolito/Documents/projects/forks/node/node \
  --experimental-quic -p 'process.features.quic'
/Users/marcoippolito/Documents/projects/forks/node/node \
  --experimental-quic --test --test-concurrency=1 test/*.test.js
```

## Assessment

The high-impact defects found in the initial review—TLS timer destruction,
HTTP/2 trailer completion, consumption-dependent body limits, lost CONNECT
bytes, invalid lifecycle resurrection, and type/runtime drift—are addressed and
covered by regression tests. The implementation is substantially stronger and
the remaining uncertainty is concentrated in clearly marked behavior of
Node's experimental QUIC API rather than unreported failures in the ordinary
HTTP/1.1 and HTTP/2 paths.
