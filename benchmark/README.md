# Dodici benchmarks

This private package compares Dodici with the corresponding Node core server:

- `node:http` and Dodici over HTTP/1.1
- `node:http2` and Dodici over cleartext HTTP/2

Both implementations receive the same requests from the same protocol-specific
client. Every response is validated before its timing contributes to a result.
Each scenario is warmed up, sampled repeatedly, and reported as median, minimum,
maximum, and percentage of the matching Node core result.

## Run

From this directory:

```sh
npm ci
npm run benchmark
```

For a short smoke run:

```sh
npm run quick
```

The root `npm run benchmark` command delegates here. Available tuning variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `BENCHMARK_WARMUP` | 500 | Untimed requests before sampling |
| `BENCHMARK_REQUESTS` | 3000 | Requests in each measured sample |
| `BENCHMARK_CONCURRENCY` | 50 | Concurrent request workers |
| `BENCHMARK_SAMPLES` | 5 | Samples used to select the median |
| `BENCHMARK_MIN_RELATIVE` | 0.45 | Minimum Dodici/Node throughput ratio |
| `BENCHMARK_BASELINE` | `baseline.json` | Comparison baseline file |

The recap compares the current Dodici/Node ratio with the checked-in
`baseline.json`; a negative change means the current implementation is slower.
Ratios remove much of the variation between machines, but benchmark noise still
matters. Update the baseline only from repeated full CI runs, never from the
short smoke command. The relative floor catches major regressions.

## Why the runner is local

The unpublished `node-bench` package cannot be installed from npm. Common
microbenchmark libraries measure functions rather than live protocol servers,
while HTTP load generators generally do not provide equivalent HTTP/1.1 and
HTTP/2 clients. The local runner keeps connection reuse, concurrency, response
validation, sampling, and output identical across the compared servers.
