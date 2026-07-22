import { setup } from "@perseveranza-pets/milo";

const FORBIDDEN_TRAILER_FIELDS = new Set([
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

/**
 * WASM HTTP/1.x parser wrapper.
 *
 * Parser callbacks are registered once per WASM instance (module level), not
 * per parser, so a single shared instance dispatches to the owning H1Parser
 * through the parser-pointer map below.
 *
 * Callback offsets (`at`) are relative to the buffer passed to the current
 * parse() call; data must be copied out synchronously because the WASM
 * allocation is freed when feed() returns.
 */
const parsers = new Map();

function target(parser) {
	return parsers.get(parser);
}

function span(at, len) {
	if (len === 0) return Buffer.alloc(0);
	const current = active;
	// Buffer.from(TypedArray) copies; the view alone would dangle after dealloc.
	return Buffer.from(
		new Uint8Array(milo.memory.buffer, current.base + at, len),
	);
}

function str(at, len) {
	return span(at, len).toString("latin1");
}

/** The parser currently inside feed(); WASM callbacks are synchronous. */
let active = null;

const milo = setup({
	on_method(parser, at, len) {
		target(parser).message.method = str(at, len);
	},
	on_url(parser, at, len) {
		target(parser).message.url = str(at, len);
	},
	on_version(parser, at, len) {
		target(parser).message.version = str(at, len);
	},
	on_header_name(parser, at, len) {
		target(parser).pendingHeaderName = str(at, len);
	},
	on_header_value(parser, at, len) {
		const p = target(parser);
		const m = p.message;
		const name = p.pendingHeaderName;
		const value = str(at, len);
		m.headers.push([name, value]);
		const normalizedName = name.toLowerCase();
		m.headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
		switch (normalizedName) {
			case "host":
				m.hostCount++;
				m.host ??= value;
				break;
			case "content-length":
				m.contentLengthCount++;
				{
					const trimmed = value.trim();
					m.invalidContentLength ||= !/^\d+$/.test(trimmed);
					m.conflictingContentLength ||=
						m.firstContentLength !== null && trimmed !== m.firstContentLength;
					m.firstContentLength ??= trimmed;
					m.contentLength = Number.parseInt(trimmed, 10) || 0;
				}
				break;
			case "transfer-encoding":
				for (const token of value.toLowerCase().split(",")) {
					m.transferEncodingCount++;
					const normalized = token.trim();
					m.invalidTransferEncoding ||= normalized !== "chunked";
					m.chunked ||= normalized === "chunked";
				}
				break;
			case "trailer":
				for (const token of value.toLowerCase().split(",")) {
					m.forbiddenTrailer ||= FORBIDDEN_TRAILER_FIELDS.has(token.trim());
				}
				break;
			case "connection":
				for (const token of value.toLowerCase().split(",")) {
					const normalized = token.trim();
					if (normalized === "close") m.connectionClose = true;
					else if (normalized === "upgrade") m.upgrade = true;
					m.connectionNominatesFraming ||=
						normalized === "content-length" ||
						normalized === "host" ||
						normalized === "transfer-encoding";
				}
				break;
			case "expect":
				m.expect =
					m.expect === ""
						? value.toLowerCase()
						: `${m.expect}, ${value}`.toLowerCase();
				break;
		}
		p.pendingHeaderName = "";
	},
	on_trailer_name(parser, at, len) {
		target(parser).pendingTrailerName = str(at, len);
	},
	on_trailer_value(parser, at, len) {
		const p = target(parser);
		p.message.trailers.push([p.pendingTrailerName, str(at, len)]);
		p.pendingTrailerName = "";
	},
	on_trailers(parser) {
		const p = target(parser);
		p.events.onTrailers?.(p.message.trailers);
	},
	on_headers(parser) {
		const p = target(parser);
		const m = p.message;
		// Per-message facts are derived from the collected headers, NOT from
		// the parser getters: callbacks are delivered at the end of parse(), so
		// with pipelined messages in one buffer the getters already reflect the
		// last message parsed, not the one this callback is for.
		m.hasBody = m.chunked || m.contentLength > 0;
		p.events.onHeaders(m);
	},
	on_data(parser, at, len) {
		target(parser).events.onData(span(at, len));
	},
	on_message_complete(parser) {
		const p = target(parser);
		p.events.onMessageComplete();
		p.message = emptyMessage();
	},
});

function emptyMessage() {
	return {
		method: "",
		url: "",
		version: "",
		/** @type {[string, string][]} */
		headers: [],
		headerBytes: 0,
		host: null,
		hostCount: 0,
		contentLengthCount: 0,
		firstContentLength: null,
		invalidContentLength: false,
		conflictingContentLength: false,
		transferEncodingCount: 0,
		invalidTransferEncoding: false,
		forbiddenTrailer: false,
		connectionNominatesFraming: false,
		expect: "",
		/** @type {[string, string][]} */
		trailers: [],
		hasBody: false,
		contentLength: 0,
		chunked: false,
		upgrade: false,
		connectionClose: false,
	};
}

/**
 * One HTTP/1.x request parser per connection.
 *
 * Unconsumed input is managed here (not by the parser) so that callback offsets
 * always refer to the buffer of the current parse() call. The parser consumes
 * only up to the last complete token, so spans never straddle two feed() calls;
 * the remainder is re-fed with the next chunk.
 */
export class H1Parser {
	#ptr;
	#pending = null;
	base = 0;
	message = emptyMessage();
	pendingHeaderName = "";
	pendingTrailerName = "";
	failed = false;

	/**
	 * @param {object} events
	 * @param {(message: object) => void} events.onHeaders
	 * @param {(chunk: Buffer) => void} events.onData
	 * @param {(info: {connectionClose: boolean}) => void} events.onMessageComplete
	 * @param {(code: number, description: string) => void} events.onError
	 */
	constructor(events) {
		this.events = events;
		this.#ptr = milo.create();
		// Callbacks are opt-in per parser: without this mask none of the
		// registered callbacks ever fire. on_error is intentionally excluded;
		// selective activation does not deliver it reliably, so feed() reports
		// failures from getErrorCode() after each parse instead.
		milo.setActiveCallbacks(
			this.#ptr,
			milo.CALLBACK_ACTIVE_ON_MESSAGE_COMPLETE |
				milo.CALLBACK_ACTIVE_ON_METHOD |
				milo.CALLBACK_ACTIVE_ON_URL |
				milo.CALLBACK_ACTIVE_ON_VERSION |
				milo.CALLBACK_ACTIVE_ON_HEADER_NAME |
				milo.CALLBACK_ACTIVE_ON_HEADER_VALUE |
				milo.CALLBACK_ACTIVE_ON_HEADERS |
				milo.CALLBACK_ACTIVE_ON_DATA |
				milo.CALLBACK_ACTIVE_ON_TRAILER_NAME |
				milo.CALLBACK_ACTIVE_ON_TRAILER_VALUE |
				milo.CALLBACK_ACTIVE_ON_TRAILERS,
		);
		parsers.set(this.#ptr, this);
	}

	/** @param {Buffer} chunk */
	feed(chunk) {
		if (this.failed) return;
		const data = this.#pending ? Buffer.concat([this.#pending, chunk]) : chunk;
		const ptr = milo.alloc(data.length);
		// alloc may grow wasm memory and detach earlier views: create the view
		// (and record the base for callbacks) only after alloc.
		new Uint8Array(milo.memory.buffer, ptr, data.length).set(data);
		this.base = ptr;
		active = this;
		let consumed;
		try {
			consumed = milo.parse(this.#ptr, ptr, data.length);
		} finally {
			active = null;
			milo.dealloc(ptr, data.length);
		}
		if (milo.getErrorCode(this.#ptr) !== 0) {
			this.failed = true;
			this.#pending = null;
			this.events.onError(
				milo.getErrorCode(this.#ptr),
				milo.getErrorDescription(this.#ptr),
			);
			return;
		}
		this.#pending = consumed < data.length ? data.subarray(consumed) : null;
	}

	destroy() {
		parsers.delete(this.#ptr);
		milo.destroy(this.#ptr);
		this.#pending = null;
	}

	takePending() {
		const pending = this.#pending;
		this.#pending = null;
		return pending;
	}
}
