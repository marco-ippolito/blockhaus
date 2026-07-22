import type { Duplex } from "node:stream";
import {
	type ConnectContext,
	Context,
	diagnosticChannels,
	type Handler,
	type Server,
	type ServerContext,
	serve,
	withTrailers,
} from "dodici";

const requestEndChannel: "dodici.request.end" = diagnosticChannels.requestEnd;
const requestRejectChannel: "dodici.request.reject" =
	diagnosticChannels.requestReject;
void requestEndChannel;
void requestRejectChannel;

const handler = {
	[Symbol.for("server.protocol")]: 1,
	async fetch(ctx: ServerContext) {
		ctx.sendInformational(103, { link: "</style.css>; rel=preload" });
		ctx.waitUntil(Promise.resolve());
		if (ctx.request.method === "TRACE") ctx.deny("rejected");
		return withTrailers(new Response(ctx.request.body), { "x-checksum": "ok" });
	},
	connect(ctx: ConnectContext): Duplex | Response | null {
		return ctx.authority === "blocked.example"
			? new Response(null, { status: 403 })
			: null;
	},
} satisfies Handler;

const server: Server = serve(handler, { port: 0, maxRequestBodySize: 1_024 });
server.busy = false;
server.address();
server.listen();
server.close();

declare const request: Request;
declare const metadata: Record<string, unknown>;
const context: ServerContext = new Context(request, metadata);
context.deny("cancelled");
