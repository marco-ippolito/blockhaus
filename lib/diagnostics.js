import diagnosticsChannel from "node:diagnostics_channel";

export const diagnosticChannels = Object.freeze({
	serverListening: "dodici.server.listening",
	serverClose: "dodici.server.close",
	requestStart: "dodici.request.start",
	requestEnd: "dodici.request.end",
	requestReject: "dodici.request.reject",
	connectStart: "dodici.connect.start",
	connectEnd: "dodici.connect.end",
	error: "dodici.error",
});

const channels = new Map(
	Object.values(diagnosticChannels).map((name) => [
		name,
		diagnosticsChannel.channel(name),
	]),
);

/** Publish only when the process has installed an audit observer. */
export function publishDiagnostic(name, message) {
	const channel = channels.get(name);
	if (!channel?.hasSubscribers) return;
	channel.publish(message);
}

export function hasDiagnosticSubscribers(first, second) {
	return (
		channels.get(first)?.hasSubscribers === true ||
		(second !== undefined && channels.get(second)?.hasSubscribers === true)
	);
}
