import diagnosticsChannel from "node:diagnostics_channel";

export const diagnosticChannels = Object.freeze({
	serverListening: "blockhaus.server.listening",
	serverClose: "blockhaus.server.close",
	requestStart: "blockhaus.request.start",
	requestEnd: "blockhaus.request.end",
	requestReject: "blockhaus.request.reject",
	connectStart: "blockhaus.connect.start",
	connectEnd: "blockhaus.connect.end",
	error: "blockhaus.error",
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
