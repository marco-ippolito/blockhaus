# Contributing

## Requirements

- Node.js 26 (see `.nvmrc`)
- npm with lockfile support

## Setup

```sh
npm ci
npm run check
```

`npm run check` runs Biome's CI command, verifies public TypeScript
declarations, and runs the complete stock-Node suite with enforced coverage.

Run `npm run benchmark` for the Node-core comparison across HTTP/1 and HTTP/2.
GitHub Actions runs the same benchmark in a separate job after the quality
gate. Override sample sizing with `BENCHMARK_WARMUP`, `BENCHMARK_REQUESTS`,
`BENCHMARK_CONCURRENCY`, and `BENCHMARK_SAMPLES` when profiling locally.
The benchmark is an independent private package; see
[`benchmark/README.md`](benchmark/README.md) for its methodology and commands.

## HTTP/3 tests

HTTP/3 tests require a Node binary compiled with experimental QUIC support:

```sh
/path/to/node --experimental-quic --test test/*.test.js
```

Stock Node runs skip those tests. Pull requests that touch `lib/h3`, shared
request handling, limits, trailers, CONNECT, or shutdown should also be checked
with a QUIC-enabled binary.

CI caches the compiled QUIC-enabled Node binary by the exact upstream Node
commit. An exact hit skips configure and compilation; misses reuse the latest
compatible Ninja build tree before saving the new binary.

## Changes

- Add regression tests for behavior changes and bug fixes.
- Preserve strict HTTP/1.1 framing. Ambiguous messages must be rejected, not
  normalized.
- Keep protocol-specific code in its backend and align observable behavior
  across HTTP/1.1, HTTP/2, and HTTP/3 where their APIs permit it.
- Do not commit certificates other than the intentionally public test fixture.
- Run `npm run fix` before opening a pull request.

## Commit and pull request scope

Keep changes focused. Explain compatibility and security implications for
parser, framing, timeout, stream, and lifecycle changes in the pull request.
