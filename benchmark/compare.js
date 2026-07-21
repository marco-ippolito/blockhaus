import { appendFile, readFile } from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import { performance } from "node:perf_hooks";
import { serve } from "../lib/index.js";

const WARMUP_REQUESTS = Number(process.env.BENCHMARK_WARMUP ?? 500);
const MEASURED_REQUESTS = Number(process.env.BENCHMARK_REQUESTS ?? 3_000);
const CONCURRENCY = Number(process.env.BENCHMARK_CONCURRENCY ?? 50);
const SAMPLES = Number(process.env.BENCHMARK_SAMPLES ?? 5);
const MIN_RELATIVE_THROUGHPUT = Number(
	process.env.BENCHMARK_MIN_RELATIVE ?? 0.45,
);
const HOST = "127.0.0.1";
const NO_CONTENT = new Response(null, { status: 204 });
const reference = JSON.parse(
	await readFile(
		process.env.BENCHMARK_BASELINE ?? new URL("baseline.json", import.meta.url),
		"utf8",
	),
);

const scenarios = [
	{
		name: "no-content",
		expectedStatus: 204,
		expectedBody: "",
		dodici: () => NO_CONTENT,
		nodeHttp: (_request, response) => {
			response.statusCode = 204;
			response.end();
		},
		nodeHttp2: (stream) => {
			stream.respond({ ":status": 204 });
			stream.end();
		},
	},
	{
		name: "request-url",
		expectedStatus: 200,
		expectedBody: "ok",
		dodici: (context) => {
			void context.request.url;
			return new Response("ok");
		},
		nodeHttp: (request, response) => {
			void request.url;
			response.end("ok");
		},
		nodeHttp2: (stream, headers) => {
			void headers[":path"];
			stream.respond({ ":status": 200 });
			stream.end("ok");
		},
	},
	{
		name: "request-header",
		expectedStatus: 200,
		expectedBody: "benchmark",
		dodici: (context) =>
			new Response(context.request.headers.get("x-benchmark")),
		nodeHttp: (request, response) => {
			response.end(request.headers["x-benchmark"]);
		},
		nodeHttp2: (stream, headers) => {
			stream.respond({ ":status": 200 });
			stream.end(headers["x-benchmark"]);
		},
	},
];

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, HOST, () => {
			server.removeListener("error", reject);
			resolve(server.address().port);
		});
	});
}

function closeNodeServer(server) {
	return new Promise((resolve, reject) => {
		server.closeAllConnections?.();
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

async function startNodeHttp(scenario) {
	const server = http.createServer(scenario.nodeHttp);
	const port = await listen(server);
	return { port, close: () => closeNodeServer(server) };
}

async function startNodeHttp2(scenario) {
	const server = http2.createServer();
	server.on("stream", scenario.nodeHttp2);
	const port = await listen(server);
	return { port, close: () => closeNodeServer(server) };
}

async function startDodici(scenario) {
	const server = serve({ fetch: scenario.dodici }, { hostname: HOST, port: 0 });
	await server.listen();
	return { port: server.port, close: () => server.close({ force: true }) };
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

async function measure({ implementation, protocol, scenario, start, client }) {
	const runningServer = await start(scenario);
	const runningClient = client(runningServer.port, scenario);
	try {
		await batch(runningClient.request, WARMUP_REQUESTS);
		const samples = [];
		for (let index = 0; index < SAMPLES; index++) {
			const started = performance.now();
			await batch(runningClient.request, MEASURED_REQUESTS);
			samples.push(MEASURED_REQUESTS / ((performance.now() - started) / 1_000));
		}
		samples.sort((left, right) => left - right);
		return {
			implementation,
			protocol,
			scenario: scenario.name,
			median: samples[Math.floor(samples.length / 2)],
			min: samples[0],
			max: samples.at(-1),
		};
	} finally {
		await runningClient.close();
		await runningServer.close();
	}
}

const implementations = [
	{
		implementation: "node",
		protocol: "http/1",
		start: startNodeHttp,
		client: createHttpClient,
	},
	{
		implementation: "dodici",
		protocol: "http/1",
		start: startDodici,
		client: createHttpClient,
	},
	{
		implementation: "node",
		protocol: "h2c",
		start: startNodeHttp2,
		client: createHttp2Client,
	},
	{
		implementation: "dodici",
		protocol: "h2c",
		start: startDodici,
		client: createHttp2Client,
	},
];

const results = [];
for (const scenario of scenarios) {
	for (const implementation of implementations) {
		const result = await measure({ ...implementation, scenario });
		results.push(result);
		console.log(JSON.stringify(result));
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
		const previous = reference.results[resultKey(result)];
		return {
			protocol: result.protocol,
			scenario: result.scenario,
			node: nodeResult.median,
			dodici: result.median,
			current,
			previous,
			change: previous === undefined ? null : (current / previous - 1) * 100,
		};
	});

console.log("\nPerformance recap (ratios normalize for the current machine):");
console.table(
	recap.map((row) => ({
		protocol: row.protocol,
		scenario: row.scenario,
		"Node req/s": row.node.toFixed(0),
		"Dodici req/s": row.dodici.toFixed(0),
		"current ratio": `${row.current.toFixed(1)}%`,
		"previous ratio":
			row.previous === undefined ? "n/a" : `${row.previous.toFixed(1)}%`,
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
				`| ${row.protocol} | ${row.scenario} | ${row.node.toFixed(0)} | ${row.dodici.toFixed(0)} | ${row.current.toFixed(1)}% | ${row.previous === undefined ? "n/a" : `${row.previous.toFixed(1)}%`} | ${row.change === null ? "n/a" : `${row.change >= 0 ? "+" : ""}${row.change.toFixed(1)}%`} |`,
		)
		.join("\n");
	await appendFile(
		process.env.GITHUB_STEP_SUMMARY,
		`## Performance recap\n\nThe change column compares normalized Dodici/Node throughput with the checked-in baseline. Negative means slower.\n\n| Protocol | Scenario | Node req/s | Dodici req/s | Current ratio | Previous ratio | Change |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |\n${recapRows}\n\n<details><summary>Detailed samples</summary>\n\n${SAMPLES} samples of ${MEASURED_REQUESTS.toLocaleString("en-US")} requests after ${WARMUP_REQUESTS.toLocaleString("en-US")} warmups, concurrency ${CONCURRENCY}.\n\n| Protocol | Scenario | Server | Median req/s | Min | Max | Relative |\n| --- | --- | --- | ---: | ---: | ---: | ---: |\n${rows}\n\n</details>\n`,
	);
}

if (regressions.length > 0) {
	throw new Error(
		`Dodici fell below ${(MIN_RELATIVE_THROUGHPUT * 100).toFixed(0)}% of Node core in: ${regressions.map((result) => `${result.protocol}/${result.scenario}`).join(", ")}`,
	);
}
