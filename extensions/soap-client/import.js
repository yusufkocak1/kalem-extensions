/**
 * Requests pasted from elsewhere: cURL (bash and Windows cmd), PowerShell, fetch,
 * a HAR file, a Postman collection, a raw HTTP request or a bare URL. Pure.
 *
 * Each request found is `{ name, method, url, headers: [{ key, value }], body, form }`
 * where `body` is text or null and `form` holds `-F` fields.
 */

const BROWSER_HEADERS =
	/^(sec-|user-agent$|accept-language$|accept-encoding$|priority$|referer$|origin$|dnt$|upgrade-insecure-requests$|cache-control$|pragma$|connection$|te$)/i;
const NEVER_KEPT = /^(content-length|host)$/i;

export function isBrowserHeader(name) {
	return BROWSER_HEADERS.test(name);
}

/** What the text is and the requests in it; `error` when nothing could be read. */
export function parseImport(input) {
	const text = String(input ?? "")
		.replace(/^\uFEFF/, "")
		.trim();
	if (text === "") return { format: null, requests: [] };
	try {
		if (/^[[{]/.test(text)) {
			const json = tryJson(text);
			if (json !== undefined) return fromJson(json);
		}
		if (/^(curl(\.exe)?)\s/i.test(text) || /(^|[\n;&|]\s*)curl(\.exe)?\s/i.test(text))
			return { format: "curl", requests: parseCurl(text) };
		if (/^(await\s+)?fetch\s*\(/.test(text) || /\bfetch\s*\(\s*["'`]/.test(text))
			return { format: "fetch", requests: parseFetch(text) };
		if (/Invoke-(WebRequest|RestMethod)\b/i.test(text))
			return { format: "powershell", requests: parsePowerShell(text) };
		if (/^[A-Z]+\s+\S+\s+HTTP\/[\d.]+\s*$/m.test(text.split(/\r?\n/)[0]))
			return { format: "http", requests: [parseRawHttp(text)] };
		if (/^(https?:\/\/|www\.)\S+$/i.test(text))
			return { format: "url", requests: [request("GET", text, [], null)] };
	} catch (error) {
		return { format: null, requests: [], error: error.message };
	}
	return { format: null, requests: [] };
}

function tryJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function fromJson(json) {
	if (json?.log && Array.isArray(json.log.entries))
		return { format: "har", requests: json.log.entries.map((entry) => fromHar(entry.request)) };
	if (Array.isArray(json?.item) || /postman/i.test(String(json?.info?.schema ?? ""))) {
		return {
			format: "postman",
			name: String(json.info?.name ?? ""),
			requests: postmanItems(json.item ?? []),
			variables: (json.variable ?? [])
				.filter((each) => each && each.key)
				.map((each) => ({ key: String(each.key), value: String(each.value ?? "") })),
		};
	}
	return { format: null, requests: [] };
}

const request = (method, url, headers, body, extra = {}) => {
	const kept = headers.filter(
		(row) => row.key !== "" && !row.key.startsWith(":") && !NEVER_KEPT.test(row.key),
	);
	return {
		name: nameOf(method, url),
		// kalem-locale-ok: HTTP methods are ASCII
		method: String(method || "GET").toUpperCase(),
		url,
		headers: kept,
		body,
		form: [],
		...extra,
	};
};

function nameOf(method, url) {
	try {
		const parsed = new URL(url);
		const path =
			parsed.pathname === "/" ? parsed.host : parsed.pathname.split("/").slice(-2).join("/");
		// kalem-locale-ok: HTTP methods are ASCII
		return `${String(method || "GET").toUpperCase()} ${path}`;
	} catch {
		return url.slice(0, 60);
	}
}

export function headerOf(headers, name) {
	// kalem-locale-ok: header names are ASCII
	return headers.find((row) => row.key.toLowerCase() === name.toLowerCase())?.value;
}

// --- cURL ------------------------------------------------------------------------------

const SEPARATOR = Symbol("separator");

/** Shell words, with `;`, `&`, `&&` and `|` outside quotes as separators. */
function shellWords(text) {
	const words = [];
	let word = null;
	const push = () => {
		if (word !== null) words.push(word);
		word = null;
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "\\" && (text[i + 1] === "\n" || text[i + 1] === "\r")) {
			i += text[i + 1] === "\r" && text[i + 2] === "\n" ? 2 : 1;
			continue;
		}
		if (c === " " || c === "\t") {
			push();
			continue;
		}
		if (c === "\n" || c === "\r") {
			push();
			if (words.at(-1) !== SEPARATOR) words.push(SEPARATOR);
			continue;
		}
		if (c === ";" || c === "&" || c === "|") {
			push();
			if (text[i + 1] === c) i++;
			words.push(SEPARATOR);
			continue;
		}
		word ??= "";
		if (c === "'") {
			const end = text.indexOf("'", i + 1);
			word += end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
			i = end === -1 ? text.length : end;
		} else if (c === "$" && text[i + 1] === "'") {
			i += 2;
			for (; i < text.length && text[i] !== "'"; i++) {
				if (text[i] !== "\\") {
					word += text[i];
					continue;
				}
				const next = text[++i];
				const simple = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"', 0: "\0" };
				if (next in simple) word += simple[next];
				else if (next === "x") {
					const hex = /^[0-9a-f]{1,2}/i.exec(text.slice(i + 1))[0];
					word += String.fromCharCode(Number.parseInt(hex, 16));
					i += hex.length;
				} else if (next === "u" || next === "U") {
					const hex = (next === "u" ? /^[0-9a-f]{1,4}/i : /^[0-9a-f]{1,8}/i).exec(
						text.slice(i + 1),
					)[0];
					word += String.fromCodePoint(Number.parseInt(hex, 16));
					i += hex.length;
				} else word += `\\${next}`;
			}
		} else if (c === '"') {
			for (i++; i < text.length && text[i] !== '"'; i++) {
				if (text[i] === "\\" && '"\\$`\n'.includes(text[i + 1])) {
					i++;
					if (text[i] !== "\n") word += text[i];
				} else word += text[i];
			}
		} else if (c === "\\") {
			word += text[++i] ?? "";
		} else word += c;
	}
	push();
	return words;
}

/** Windows cmd's `^` escapes, as Chrome's "Copy as cURL (cmd)" writes them, made bash-like. */
function fromCmd(text) {
	return text
		.replace(/\^\r?\n/g, "\\\n")
		.replace(/\^\^/g, "\u0001")
		.replace(/\^(.)/g, "$1")
		.replace(/\u0001/g, "^")
		.replace(/""/g, '\\"')
		.replace(/%%/g, "%");
}

const CURL_IGNORED = new Set([
	"-s",
	"--silent",
	"-S",
	"--show-error",
	"-L",
	"--location",
	"-k",
	"--insecure",
	"-v",
	"--verbose",
	"-i",
	"--include",
	"--compressed",
	"-g",
	"--globoff",
	"-f",
	"--fail",
	"-#",
	"--progress-bar",
	"--http1.1",
	"--http2",
	"--http2-prior-knowledge",
	"--location-trusted",
	"-N",
	"--no-buffer",
]);
const CURL_WITH_VALUE = new Set([
	"-o",
	"--output",
	"-m",
	"--max-time",
	"--connect-timeout",
	"-x",
	"--proxy",
	"--cert",
	"-E",
	"--key",
	"--cacert",
	"-w",
	"--write-out",
	"--retry",
	"--resolve",
	"-c",
	"--cookie-jar",
	"-T",
	"--upload-file",
	"--limit-rate",
	"-r",
	"--range",
	"--max-redirs",
	"-K",
	"--config",
	"--proxy-user",
	"-U",
	"--interface",
]);
const SHORT_WITH_VALUE = "XHdubAeFoxmwcTEKrU";

export function parseCurl(input) {
	const text = /\^\r?\n|\^"/.test(input) ? fromCmd(input) : input;
	const commands = [];
	let current = [];
	for (const word of shellWords(text)) {
		if (word === SEPARATOR) {
			commands.push(current);
			current = [];
		} else current.push(word);
	}
	commands.push(current);
	const found = commands
		.filter((words) => /^curl(\.exe)?$/i.test(words[0] ?? ""))
		.map((words) => curlRequest(words.slice(1)));
	if (found.length === 0) throw new Error("No curl command was found.");
	return found;
}

function curlRequest(args) {
	let method = null;
	let url = null;
	let get = false;
	let head = false;
	const headers = [];
	const data = [];
	const form = [];
	let user = null;
	let bearer = null;
	const option = (name, value) => {
		switch (name) {
			case "-X":
			case "--request":
				method = value;
				break;
			case "-H":
			case "--header": {
				const colon = value.indexOf(":");
				if (colon > 0) {
					const key = value.slice(0, colon).trim();
					const rest = value.slice(colon + 1).trim();
					headers.push({ key, value: rest });
				}
				break;
			}
			case "-d":
			case "--data":
			case "--data-ascii":
			case "--data-binary":
			case "--data-raw":
			case "--json":
				data.push(value);
				if (name === "--json") {
					headers.push({ key: "Content-Type", value: "application/json" });
					headers.push({ key: "Accept", value: "application/json" });
				}
				break;
			case "--data-urlencode": {
				const equals = value.indexOf("=");
				data.push(
					equals === -1
						? encodeURIComponent(value)
						: `${value.slice(0, equals)}${equals === 0 ? "" : "="}${encodeURIComponent(value.slice(equals + 1))}`,
				);
				break;
			}
			case "-F":
			case "--form":
			case "--form-string": {
				const equals = value.indexOf("=");
				form.push(
					equals === -1
						? { key: value, value: "" }
						: { key: value.slice(0, equals), value: value.slice(equals + 1) },
				);
				break;
			}
			case "-u":
			case "--user":
				user = value;
				break;
			case "--oauth2-bearer":
				bearer = value;
				break;
			case "-b":
			case "--cookie":
				if (value.includes("=")) headers.push({ key: "Cookie", value });
				break;
			case "-A":
			case "--user-agent":
				headers.push({ key: "User-Agent", value });
				break;
			case "-e":
			case "--referer":
				headers.push({ key: "Referer", value });
				break;
			case "--url":
				url = value;
				break;
		}
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-G" || arg === "--get") get = true;
		else if (arg === "-I" || arg === "--head") head = true;
		else if (CURL_IGNORED.has(arg) || CURL_WITH_VALUE.has(arg)) {
			if (CURL_WITH_VALUE.has(arg)) i++;
		} else if (arg.startsWith("--")) {
			const equals = arg.indexOf("=");
			if (
				equals !== -1 &&
				!/^--(data|header|form|url|user|request|json|cookie)/.test(arg.slice(0, equals))
			)
				continue;
			if (equals !== -1) option(arg.slice(0, equals), arg.slice(equals + 1));
			else option(arg, args[++i] ?? "");
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (let at = 1; at < arg.length; at++) {
				const flag = `-${arg[at]}`;
				if (SHORT_WITH_VALUE.includes(arg[at])) {
					const rest = arg.slice(at + 1);
					if (!"oxmwcTEKrU".includes(arg[at])) option(flag, rest !== "" ? rest : (args[++i] ?? ""));
					else if (rest === "") i++;
					break;
				}
				if (flag === "-G") get = true;
				if (flag === "-I") head = true;
			}
		} else if (url === null) url = arg;
	}
	if (url === null) throw new Error("The curl command has no address.");
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("{{")) url = `http://${url}`;
	let body = data.length > 0 ? data.join("&") : null;
	if (get && body !== null) {
		url = `${url}${url.includes("?") ? "&" : "?"}${body}`;
		body = null;
	}
	if (data.length > 0 && !get && headerOf(headers, "content-type") === undefined)
		headers.push({ key: "Content-Type", value: "application/x-www-form-urlencoded" });
	method ??= head ? "HEAD" : body !== null || form.length > 0 ? "POST" : "GET";
	const auth =
		user !== null ? basic(user) : bearer !== null ? { type: "bearer", token: bearer } : null;
	const result = request(method, url, headers, body, auth ? { auth } : {});
	if (form.length > 0) {
		result.form = form;
		result.headers = result.headers.filter((row) => !/^content-type$/i.test(row.key));
	}
	return result;
}

function basic(user) {
	const colon = user.indexOf(":");
	return {
		type: "basic",
		username: colon === -1 ? user : user.slice(0, colon),
		password: colon === -1 ? "" : user.slice(colon + 1),
	};
}

// --- fetch -----------------------------------------------------------------------------

function readString(text, at) {
	const quote = text[at];
	let out = "";
	let i = at + 1;
	for (; i < text.length && text[i] !== quote; i++) {
		if (text[i] === "\\") {
			const next = text[++i];
			const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };
			if (next in simple) out += simple[next];
			else if (next === "u") {
				const braced = text[i + 1] === "{";
				const hex = braced ? text.slice(i + 2, text.indexOf("}", i)) : text.slice(i + 1, i + 5);
				out += String.fromCodePoint(Number.parseInt(hex, 16));
				i += braced ? hex.length + 2 : 4;
			} else if (next === "x") {
				out += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 3), 16));
				i += 2;
			} else if (next !== "\n") out += next;
		} else out += text[i];
	}
	return { value: out, end: i + 1 };
}

/** A JS object literal as Chrome writes it (JSON with possibly unquoted keys or `null`). */
function readObject(text, at) {
	let depth = 0;
	for (let i = at; i < text.length; i++) {
		const c = text[i];
		if (c === '"' || c === "'" || c === "`") {
			i = readString(text, i).end - 1;
		} else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return { source: text.slice(at, i + 1), end: i + 1 };
	}
	throw new Error("The fetch call's options are not closed.");
}

function looseJson(source) {
	const json = tryJson(source);
	if (json !== undefined) return json;
	let out = "";
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === '"' || c === "'" || c === "`") {
			const read = readString(source, i);
			out += JSON.stringify(read.value);
			i = read.end - 1;
		} else if (/[A-Za-z_$]/.test(c)) {
			const word = /^[\w$]+/.exec(source.slice(i))[0];
			const after = source.slice(i + word.length).trimStart();
			out += after.startsWith(":") ? JSON.stringify(word) : word === "undefined" ? "null" : word;
			i += word.length - 1;
		} else out += c;
	}
	const parsed = tryJson(out.replace(/,(\s*[}\]])/g, "$1"));
	if (parsed === undefined) throw new Error("The fetch call's options could not be read.");
	return parsed;
}

export function parseFetch(text) {
	const found = [];
	const pattern = /\bfetch\s*\(\s*/g;
	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		let at = pattern.lastIndex;
		if (!"\"'`".includes(text[at])) continue;
		const url = readString(text, at);
		at = url.end;
		while (/\s/.test(text[at] ?? "")) at++;
		let options = {};
		if (text[at] === ",") {
			at++;
			while (/\s/.test(text[at] ?? "")) at++;
			if (text[at] === "{") {
				const object = readObject(text, at);
				options = looseJson(object.source) ?? {};
				at = object.end;
			}
		}
		pattern.lastIndex = at;
		const headers = Object.entries(options.headers ?? {}).map(([key, value]) => ({
			key,
			value: String(value),
		}));
		if (options.referrer && headerOf(headers, "referer") === undefined)
			headers.push({ key: "Referer", value: String(options.referrer) });
		const body = typeof options.body === "string" ? options.body : null;
		found.push(
			request(options.method ?? (body !== null ? "POST" : "GET"), url.value, headers, body),
		);
	}
	if (found.length === 0) throw new Error("No fetch call was found.");
	return found;
}

// --- PowerShell ------------------------------------------------------------------------

function psString(text, at) {
	const quote = text[at];
	let out = "";
	let i = at + 1;
	for (; i < text.length; i++) {
		const c = text[i];
		if (quote === "'" && c === "'" && text[i + 1] === "'") {
			out += "'";
			i++;
		} else if (c === quote) break;
		else if (quote === '"' && c === "`") {
			const next = text[++i];
			out += { n: "\n", r: "\r", t: "\t", 0: "\0" }[next] ?? next;
		} else out += c;
	}
	return { value: out, end: i + 1 };
}

export function parsePowerShell(text) {
	const source = text.replace(/`\r?\n/g, " ");
	const found = [];
	for (const command of source.split(/(?=Invoke-(?:WebRequest|RestMethod)\b)/i)) {
		if (!/^Invoke-/i.test(command)) continue;
		const values = {};
		const headers = [];
		const pattern = /-(\w+)\s+/g;
		for (let match = pattern.exec(command); match !== null; match = pattern.exec(command)) {
			const name = match[1].toLowerCase();
			let at = pattern.lastIndex;
			if (name === "headers" && command.slice(at, at + 2) === "@{") {
				at += 2;
				while (at < command.length && command[at] !== "}") {
					while (/[\s;]/.test(command[at] ?? "")) at++;
					if (command[at] === "}") break;
					const key = /^["']/.test(command[at])
						? psString(command, at)
						: (() => {
								const word = /^[^\s=]+/.exec(command.slice(at))[0];
								return { value: word, end: at + word.length };
							})();
					at = key.end;
					while (/[\s=]/.test(command[at] ?? "")) at++;
					const value = psString(command, at);
					headers.push({ key: key.value, value: value.value });
					at = value.end;
				}
				pattern.lastIndex = at + 1;
			} else if (/^["']/.test(command[at] ?? "")) {
				const value = psString(command, at);
				values[name] = value.value;
				pattern.lastIndex = value.end;
			} else {
				const word = /^[^\s]*/.exec(command.slice(at))[0];
				values[name] = word;
				pattern.lastIndex = at + word.length;
			}
		}
		if (values.contenttype && headerOf(headers, "content-type") === undefined)
			headers.push({ key: "Content-Type", value: values.contenttype });
		if (values.useragent) headers.push({ key: "User-Agent", value: values.useragent });
		const url = values.uri ?? /Invoke-\w+\s+["']?([^\s"']+)/i.exec(command)?.[1];
		if (!url) continue;
		const body = values.body ?? null;
		found.push(request(values.method ?? (body !== null ? "POST" : "GET"), url, headers, body));
	}
	if (found.length === 0) throw new Error("No Invoke-WebRequest was found.");
	return found;
}

// --- Raw HTTP --------------------------------------------------------------------------

export function parseRawHttp(text) {
	const normalized = text.replace(/\r\n/g, "\n");
	const split = normalized.indexOf("\n\n");
	const head = (split === -1 ? normalized : normalized.slice(0, split)).split("\n");
	const body = split === -1 ? "" : normalized.slice(split + 2);
	const [method, target] = head[0].trim().split(/\s+/);
	const headers = head
		.slice(1)
		.filter((line) => line.includes(":"))
		.map((line) => {
			const colon = line.indexOf(":");
			return { key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
		});
	let url = target;
	if (!/^[a-z]+:\/\//i.test(target)) {
		const host = headerOf(headers, "host") ?? "localhost";
		const plain = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(host) || /:80$/.test(host);
		url = `${plain ? "http" : "https"}://${host}${target.startsWith("/") ? "" : "/"}${target}`;
	}
	return request(method, url, headers, body.trim() === "" ? null : body);
}

// --- HAR -------------------------------------------------------------------------------

function fromHar(entry) {
	const headers = (entry?.headers ?? []).map((row) => ({
		key: String(row.name ?? ""),
		value: String(row.value ?? ""),
	}));
	const post = entry?.postData;
	let body = null;
	if (post) {
		if (typeof post.text === "string") body = post.text;
		else if (Array.isArray(post.params))
			body = post.params
				.map((row) => `${encodeURIComponent(row.name)}=${encodeURIComponent(row.value ?? "")}`)
				.join("&");
		if (post.mimeType && headerOf(headers, "content-type") === undefined)
			headers.push({ key: "Content-Type", value: post.mimeType });
	}
	return request(entry?.method ?? "GET", String(entry?.url ?? ""), headers, body);
}

// --- Postman ---------------------------------------------------------------------------

function postmanItems(items, folder = "") {
	const found = [];
	for (const item of items) {
		if (Array.isArray(item?.item)) {
			found.push(
				...postmanItems(item.item, folder ? `${folder} / ${item.name}` : String(item.name ?? "")),
			);
			continue;
		}
		if (!item?.request) continue;
		const source = typeof item.request === "string" ? { url: item.request } : item.request;
		const url =
			typeof source.url === "string"
				? source.url
				: (source.url?.raw ??
					`${source.url?.protocol ? `${source.url.protocol}://` : ""}${[].concat(source.url?.host ?? []).join(".")}/${[].concat(source.url?.path ?? []).join("/")}`);
		const headers = (Array.isArray(source.header) ? source.header : [])
			.filter((row) => row && !row.disabled)
			.map((row) => ({ key: String(row.key ?? ""), value: String(row.value ?? "") }));
		let body = null;
		let form = [];
		let mode = null;
		const raw = source.body;
		if (raw?.mode === "raw" && typeof raw.raw === "string") {
			body = raw.raw;
			mode = raw.options?.raw?.language ?? null;
		} else if (raw?.mode === "urlencoded") {
			body = (raw.urlencoded ?? [])
				.filter((row) => !row.disabled)
				.map((row) => `${encodeURIComponent(row.key)}=${encodeURIComponent(row.value ?? "")}`)
				.join("&");
			if (headerOf(headers, "content-type") === undefined)
				headers.push({ key: "Content-Type", value: "application/x-www-form-urlencoded" });
		} else if (raw?.mode === "formdata") {
			form = (raw.formdata ?? [])
				.filter((row) => !row.disabled)
				.map((row) => ({ key: String(row.key ?? ""), value: String(row.value ?? row.src ?? "") }));
		} else if (raw?.mode === "graphql" && raw.graphql) {
			body = JSON.stringify({
				query: raw.graphql.query ?? "",
				variables: tryJson(raw.graphql.variables ?? "") ?? {},
			});
			mode = "json";
		}
		const result = request(source.method ?? "GET", url, headers, body, { language: mode });
		result.form = form;
		result.auth = postmanAuth(source.auth);
		result.name = folder
			? `${folder} / ${item.name ?? result.name}`
			: String(item.name ?? result.name);
		found.push(result);
	}
	return found;
}

function postmanAuth(auth) {
	if (!auth?.type) return null;
	const values = Object.fromEntries(
		(Array.isArray(auth[auth.type]) ? auth[auth.type] : []).map((row) => [
			row.key,
			String(row.value ?? ""),
		]),
	);
	if (auth.type === "bearer") return { type: "bearer", token: values.token ?? "" };
	if (auth.type === "basic")
		return { type: "basic", username: values.username ?? "", password: values.password ?? "" };
	if (auth.type === "apikey")
		return {
			type: "apikey",
			key: values.key ?? "",
			value: values.value ?? "",
			in: values.in === "query" ? "query" : "header",
		};
	return null;
}

// --- SOAP ------------------------------------------------------------------------------

export const isEnvelope = (text) =>
	typeof text === "string" &&
	/<(?:[\w.-]+:)?Envelope\b/.test(text) &&
	/<(?:[\w.-]+:)?Body\b/.test(text);

/** Whether the text is a WSDL document rather than a request. */
export const isWsdl = (text) =>
	/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(?:[\w.-]+:)?definitions\b/.test(text);

/** The operation an envelope calls: its Body's first element. */
export function operationOf(envelope) {
	const match = /<(?:[\w.-]+:)?Body\b[^>]*>(?:\s|<!--[\s\S]*?-->)*<(?:[\w.-]+:)?([\w.-]+)/.exec(
		envelope,
	);
	return match?.[1] ?? "";
}

/** An imported request as a SOAP call: endpoint, version, SOAPAction, envelope, extra headers, Basic auth. */
export function toSoapCall(found, { browserHeaders = false } = {}) {
	const type = headerOf(found.headers, "content-type") ?? "";
	const envelope = found.body ?? "";
	const version =
		/soap\+xml/i.test(type) || envelope.includes("http://www.w3.org/2003/05/soap-envelope")
			? "1.2"
			: "1.1";
	const action = (
		headerOf(found.headers, "soapaction") ??
		/action\s*=\s*"?([^";]*)"?/i.exec(type)?.[1] ??
		""
	).replace(/^"|"$/g, "");
	let username = found.auth?.type === "basic" ? found.auth.username : "";
	let password = found.auth?.type === "basic" ? found.auth.password : "";
	const headers = {};
	for (const row of found.headers) {
		if (/^(content-type|soapaction)$/i.test(row.key)) continue;
		if (!browserHeaders && isBrowserHeader(row.key)) continue;
		if (/^authorization$/i.test(row.key) && /^basic\s/i.test(row.value) && username === "") {
			try {
				const text = new TextDecoder().decode(
					Uint8Array.from(atob(row.value.slice(6).trim()), (c) => c.charCodeAt(0)),
				);
				const colon = text.indexOf(":");
				if (colon !== -1) {
					username = text.slice(0, colon);
					password = text.slice(colon + 1);
					continue;
				}
			} catch {
				// Not Base64: kept as a header.
			}
		}
		headers[row.key] = row.value;
	}
	return {
		name: operationOf(envelope) || found.name,
		version,
		endpoint: found.url,
		action,
		envelope,
		headers,
		username,
		password,
	};
}

/** What the SOAP client can take from the text: a WSDL, or calls (bare envelopes too). */
export function parseSoapImport(input, options = {}) {
	const text = String(input ?? "")
		.replace(/^﻿/, "")
		.trim();
	if (text === "") return { format: null, calls: [] };
	if (isWsdl(text)) return { format: "wsdl", calls: [], wsdl: text };
	if (text.startsWith("<") && isEnvelope(text))
		return {
			format: "envelope",
			calls: [
				toSoapCall(
					{ name: "", method: "POST", url: "", headers: [], body: text, form: [] },
					options,
				),
			],
		};
	const found = parseImport(text);
	const calls = found.requests
		.filter((each) => isEnvelope(each.body))
		.map((each) => toSoapCall(each, options));
	return {
		format: found.format,
		calls,
		error:
			found.error ?? (found.requests.length > 0 && calls.length === 0 ? "none-soap" : undefined),
	};
}
