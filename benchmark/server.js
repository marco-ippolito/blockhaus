import http from "node:http";
import http2 from "node:http2";
import { serve } from "../lib/index.js";

const HOST = "127.0.0.1";
const [implementation, protocol, scenario] = process.argv.slice(2);
const NO_CONTENT = new Response(null, { status: 204 });

const handlers = {
	"no-content": {
		dodici: () => NO_CONTENT,
		nodeHttp: (_request, response) => {
			response.statusCode = 204;
			response.end();
		},
		nodeHttp2: (_request, response) => {
			response.statusCode = 204;
			response.end();
		},
	},
	"request-url": {
		dodici: (context) => {
			void context.url;
			return new Response("ok");
		},
		nodeHttp: (request, response) => {
			void request.url;
			response.end("ok");
		},
		nodeHttp2: (request, response) => {
			void request.url;
			response.end("ok");
		},
	},
	"request-header": {
		dodici: (context) => new Response(context.header("x-benchmark")),
		nodeHttp: (request, response) => {
			response.end(request.headers["x-benchmark"]);
		},
		nodeHttp2: (request, response) => {
			response.end(request.headers["x-benchmark"]);
		},
	},
};

const handler = handlers[scenario];
if (!handler || !["node", "dodici"].includes(implementation)) {
	throw new Error("invalid benchmark server arguments");
}

let close;
let port;
if (implementation === "dodici") {
	const server = serve({ fetch: handler.dodici }, { hostname: HOST, port: 0 });
	await server.listen();
	port = server.port;
	close = () => server.close({ force: true });
} else {
	const server =
		protocol === "http/1"
			? http.createServer(handler.nodeHttp)
			: http2.createServer(handler.nodeHttp2);
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, HOST, resolve);
	});
	port = server.address().port;
	close = () =>
		new Promise((resolve, reject) => {
			server.closeAllConnections?.();
			server.close((error) => (error ? reject(error) : resolve()));
		});
}

process.send?.({ type: "ready", port });
process.once("message", async (message) => {
	if (message?.type !== "close") return;
	await close();
	process.disconnect();
});
