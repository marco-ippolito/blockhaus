const responseTrailers = new WeakMap();
const FORBIDDEN = new Set([
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

/**
 * Attach HTTP response trailers to a web Response.
 *
 * Static form: withTrailers(response, { "digest": "..." })
 * Deferred form: withTrailers(response, ["digest"], async () => ({ digest }))
 */
export function withTrailers(response, namesOrValues, provider) {
	if (!(response instanceof Response)) {
		throw new TypeError("response must be a Response");
	}
	let names;
	let getValues;
	if (provider === undefined) {
		const values = normalize(namesOrValues);
		names = [...values.keys()];
		getValues = async () => values;
	} else {
		if (!Array.isArray(namesOrValues) || namesOrValues.length === 0) {
			throw new TypeError("trailer names must be a non-empty array");
		}
		names = namesOrValues.map(normalizeName);
		getValues = async () => {
			const values = normalize(
				typeof provider === "function" ? await provider() : await provider,
			);
			for (const name of values.keys()) {
				if (!names.includes(name)) {
					throw new TypeError(`undeclared response trailer: ${name}`);
				}
			}
			return values;
		};
	}
	for (const name of names) validateName(name);
	responseTrailers.set(response, { names: [...new Set(names)], getValues });
	return response;
}

export function getResponseTrailers(response) {
	return responseTrailers.get(response) ?? null;
}

function normalize(values) {
	const headers = new Headers(values);
	for (const name of headers.keys()) validateName(name);
	return headers;
}

function normalizeName(name) {
	return String(name).toLowerCase();
}

function validateName(name) {
	if (FORBIDDEN.has(normalizeName(name))) {
		throw new TypeError(`forbidden trailer field: ${name}`);
	}
}

export function trailersToObject(headers) {
	const values = {};
	for (const [name, value] of headers) values[name] = value;
	const cookies = headers.getSetCookie();
	if (cookies.length > 0) values["set-cookie"] = cookies;
	return values;
}
