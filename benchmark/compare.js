import { fork } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import { performance } from "node:perf_hooks";

const WARMUP_REQUESTS = Number(process.env.BENCHMARK_WARMUP ?? 500);
const MEASURED_REQUESTS = Number(process.env.BENCHMARK_REQUESTS ?? 3_000);
const CONCURRENCY = Number(process.env.BENCHMARK_CONCURRENCY ?? 50);
const SAMPLES = Number(process.env.BENCHMARK_SAMPLES ?? 5);
const MIN_RELATIVE_THROUGHPUT = Number(
	process.env.BENCHMARK_MIN_RELATIVE ?? 0.45,
);
const MAX_BASELINE_REGRESSION = Number(
	process.env.BENCHMARK_MAX_REGRESSION ?? Number.POSITIVE_INFINITY,
);
const BASELINE_METRIC = process.env.BENCHMARK_BASELINE_METRIC ?? "ratio";
const CPU_PROFILE = process.env.BENCHMARK_CPU_PROFILE;
const CPU_PROFILE_DIR = process.env.BENCHMARK_CPU_PROFILE_DIR;
if (!["ratio", "dodici-rps"].includes(BASELINE_METRIC)) {
	throw new Error("BENCHMARK_BASELINE_METRIC must be ratio or dodici-rps");
}
if (MAX_BASELINE_REGRESSION < 0) {
	throw new Error("BENCHMARK_MAX_REGRESSION must not be negative");
}
const HOST = "127.0.0.1";
const referenceUrl = new URL(
	process.env.BENCHMARK_BASELINE ?? "baseline.json",
	import.meta.url,
);
const reference = JSON.parse(await readFile(referenceUrl, "utf8"));

const scenarios = [
	{
		name: "no-content",
		expectedStatus: 204,
		expectedBody: "",
	},
	{
		name: "request-url",
		expectedStatus: 200,
		expectedBody: "ok",
	},
	{
		name: "request-header",
		expectedStatus: 200,
		expectedBody: "benchmark",
	},
];

async function startServer(implementation, protocol, scenario) {
	const profileName = `${implementation}/${protocol}/${scenario.name}`;
	const profile = CPU_PROFILE === profileName;
	if (profile && !CPU_PROFILE_DIR) {
		throw new Error(
			"BENCHMARK_CPU_PROFILE_DIR is required with BENCHMARK_CPU_PROFILE",
		);
	}
	const child = fork(
		new URL("server.js", import.meta.url),
		[implementation, protocol, scenario.name],
		{
			stdio: ["ignore", "inherit", "inherit", "ipc"],
			...(profile
				? {
						execArgv: [
							...process.execArgv,
							"--cpu-prof",
							`--cpu-prof-dir=${CPU_PROFILE_DIR}`,
							`--cpu-prof-name=${implementation}-${protocol.replace("/", "-")}-${scenario.name}.cpuprofile`,
						],
					}
				: {}),
		},
	);
	const exited = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`benchmark server exited: ${code ?? signal}`));
		});
	});
	const port = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) =>
			reject(new Error(`benchmark server exited: ${code ?? signal}`)),
		);
		child.once("message", (message) => {
			if (message?.type === "ready") resolve(message.port);
		});
	});
	return {
		port,
		close: async () => {
			child.send({ type: "close" });
			await exited;
		},
	};
}

function validateResponse(scenario, status, body) {
	if (status !== scenario.expectedStatus || body !== scenario.expectedBody) {
		throw new Error(
			`${scenario.name}: expected ${scenario.expectedStatus} ${JSON.stringify(scenario.expectedBody)}, received ${status} ${JSON.stringify(body)}`,
		);
	}
}

function createHttpClient(port, scenario) {
	const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
	return {
		request: () =>
			new Promise((resolve, reject) => {
				const request = http.request(
					{
						agent,
						host: HOST,
						port,
						path: "/benchmark",
						headers: { "x-benchmark": "benchmark" },
					},
					(response) => {
						let body = "";
						response.setEncoding("utf8");
						response.on("data", (chunk) => {
							body += chunk;
						});
						response.once("end", () => {
							try {
								validateResponse(scenario, response.statusCode, body);
								resolve();
							} catch (error) {
								reject(error);
							}
						});
					},
				);
				request.once("error", reject);
				request.end();
			}),
		close: () => agent.destroy(),
	};
}

function createHttp2Client(port, scenario) {
	const session = http2.connect(`http://${HOST}:${port}`);
	return {
		request: () =>
			new Promise((resolve, reject) => {
				const request = session.request({
					":path": "/benchmark",
					"x-benchmark": "benchmark",
				});
				let status;
				let body = "";
				request.setEncoding("utf8");
				request.once("response", (headers) => {
					status = headers[":status"];
				});
				request.on("data", (chunk) => {
					body += chunk;
				});
				request.once("error", reject);
				request.once("end", () => {
					try {
						validateResponse(scenario, status, body);
						resolve();
					} catch (error) {
						reject(error);
					}
				});
				request.end();
			}),
		close: () => new Promise((resolve) => session.close(resolve)),
	};
}

async function batch(request, count) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, count) }, async () => {
			while (next < count) {
				next++;
				await request();
			}
		}),
	);
}

async function sample(request) {
	const started = performance.now();
	await batch(request, MEASURED_REQUESTS);
	return MEASURED_REQUESTS / ((performance.now() - started) / 1_000);
}

function summarize(implementation, protocol, scenario, samples) {
	samples.sort((left, right) => left - right);
	return {
		implementation,
		protocol,
		scenario: scenario.name,
		median: samples[Math.floor(samples.length / 2)],
		min: samples[0],
		max: samples.at(-1),
	};
}

async function measurePair(protocol, scenario, createClient) {
	const nodeServer = await startServer("node", protocol, scenario);
	const dodiciServer = await startServer("dodici", protocol, scenario);
	const nodeClient = createClient(nodeServer.port, scenario);
	const dodiciClient = createClient(dodiciServer.port, scenario);
	try {
		// Warm both implementations in alternating order. Timed rounds reverse
		// order each time so thermal drift and transient host load affect each
		// side symmetrically instead of favoring whichever server runs first.
		await batch(nodeClient.request, WARMUP_REQUESTS);
		await batch(dodiciClient.request, WARMUP_REQUESTS);
		const nodeSamples = [];
		const dodiciSamples = [];
		for (let index = 0; index < SAMPLES; index++) {
			if (index % 2 === 0) {
				nodeSamples.push(await sample(nodeClient.request));
				dodiciSamples.push(await sample(dodiciClient.request));
			} else {
				dodiciSamples.push(await sample(dodiciClient.request));
				nodeSamples.push(await sample(nodeClient.request));
			}
		}
		return [
			summarize("node", protocol, scenario, nodeSamples),
			summarize("dodici", protocol, scenario, dodiciSamples),
		];
	} finally {
		await Promise.all([nodeClient.close(), dodiciClient.close()]);
		await Promise.all([nodeServer.close(), dodiciServer.close()]);
	}
}

const protocols = [
	{
		protocol: "http/1",
		client: createHttpClient,
	},
	{
		protocol: "h2c",
		client: createHttp2Client,
	},
];

const results = [];
for (const scenario of scenarios) {
	for (const { protocol, client } of protocols) {
		const pair = await measurePair(protocol, scenario, client);
		for (const result of pair) console.log(JSON.stringify(result));
		results.push(...pair);
	}
}

function relative(result) {
	if (result.implementation === "node") return 100;
	const baseline = results.find(
		(candidate) =>
			candidate.implementation === "node" &&
			candidate.protocol === result.protocol &&
			candidate.scenario === result.scenario,
	);
	return (result.median / baseline.median) * 100;
}

function resultKey(result) {
	return `${result.protocol}/${result.scenario}`;
}

const recap = results
	.filter((result) => result.implementation === "dodici")
	.map((result) => {
		const nodeResult = results.find(
			(candidate) =>
				candidate.implementation === "node" &&
				candidate.protocol === result.protocol &&
				candidate.scenario === result.scenario,
		);
		const current = relative(result);
		const gateCurrent = BASELINE_METRIC === "ratio" ? current : result.median;
		const gateBaseline =
			BASELINE_METRIC === "ratio"
				? reference.results[resultKey(result)]
				: reference.dodiciRequestsPerSecond?.[resultKey(result)];
		return {
			protocol: result.protocol,
			scenario: result.scenario,
			node: nodeResult.median,
			dodici: result.median,
			current,
			gateCurrent,
			gateBaseline,
			change:
				gateBaseline === undefined
					? null
					: (gateCurrent / gateBaseline - 1) * 100,
		};
	});

function formatGateValue(value) {
	if (value === undefined) return "n/a";
	return BASELINE_METRIC === "ratio"
		? `${value.toFixed(1)}%`
		: `${value.toFixed(0)} req/s`;
}

console.log("\nPerformance recap (ratios normalize for the current machine):");
console.table(
	recap.map((row) => ({
		protocol: row.protocol,
		scenario: row.scenario,
		"Node req/s": row.node.toFixed(0),
		"Dodici req/s": row.dodici.toFixed(0),
		"current ratio": `${row.current.toFixed(1)}%`,
		"gate current": formatGateValue(row.gateCurrent),
		"gate baseline": formatGateValue(row.gateBaseline),
		change:
			row.change === null
				? "n/a"
				: `${row.change >= 0 ? "+" : ""}${row.change.toFixed(1)}%`,
	})),
);

const regressions = results.filter(
	(result) =>
		result.implementation === "dodici" &&
		relative(result) < MIN_RELATIVE_THROUGHPUT * 100,
);
const baselineRegressions = recap.filter(
	(row) => row.change !== null && row.change < -MAX_BASELINE_REGRESSION * 100,
);
const missingBaselines = recap.filter((row) => row.gateBaseline === undefined);

if (process.env.GITHUB_STEP_SUMMARY) {
	const rows = results
		.map(
			(result) =>
				`| ${result.protocol} | ${result.scenario} | ${result.implementation} | ${result.median.toFixed(0)} | ${result.min.toFixed(0)} | ${result.max.toFixed(0)} | ${relative(result).toFixed(1)}% |`,
		)
		.join("\n");
	const recapRows = recap
		.map(
			(row) =>
				`| ${row.protocol} | ${row.scenario} | ${row.node.toFixed(0)} | ${row.dodici.toFixed(0)} | ${row.current.toFixed(1)}% | ${formatGateValue(row.gateBaseline)} | ${row.change === null ? "n/a" : `${row.change >= 0 ? "+" : ""}${row.change.toFixed(1)}%`} |`,
		)
		.join("\n");
	await appendFile(
		process.env.GITHUB_STEP_SUMMARY,
		`## Performance recap\n\nThe blocking gate compares ${BASELINE_METRIC === "ratio" ? "the Dodici/Node ratio" : "Dodici throughput"} with the checked-in baseline. Negative means slower.\n\n| Protocol | Scenario | Node req/s | Dodici req/s | Current ratio | Gate baseline | Change |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |\n${recapRows}\n\n<details><summary>Detailed samples</summary>\n\n${SAMPLES} samples of ${MEASURED_REQUESTS.toLocaleString("en-US")} requests after ${WARMUP_REQUESTS.toLocaleString("en-US")} warmups, concurrency ${CONCURRENCY}.\n\n| Protocol | Scenario | Server | Median req/s | Min | Max | Relative |\n| --- | --- | --- | ---: | ---: | ---: | ---: |\n${rows}\n\n</details>\n`,
	);
}

if (regressions.length > 0) {
	throw new Error(
		`Dodici fell below ${(MIN_RELATIVE_THROUGHPUT * 100).toFixed(0)}% of Node core in: ${regressions.map((result) => `${result.protocol}/${result.scenario}`).join(", ")}`,
	);
}

if (missingBaselines.length > 0) {
	throw new Error(
		`benchmark baseline is missing: ${missingBaselines.map((row) => `${row.protocol}/${row.scenario}`).join(", ")}`,
	);
}

if (baselineRegressions.length > 0) {
	throw new Error(
		`Dodici regressed by more than ${(MAX_BASELINE_REGRESSION * 100).toFixed(0)}% from the benchmark baseline in: ${baselineRegressions.map((row) => `${row.protocol}/${row.scenario} (${row.change.toFixed(1)}%)`).join(", ")}`,
	);
}
