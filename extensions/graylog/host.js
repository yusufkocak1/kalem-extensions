const MAX_LIMIT = 1000;
const MAX_TOOL_TEXT = 40_000;
const collator = new Intl.Collator(navigator.language);

const clamp = (value, low, high, fallback) => {
	const number = Number(value);
	return Number.isFinite(number) ? Math.min(Math.max(Math.round(number), low), high) : fallback;
};

const fieldList = (text) =>
	String(text ?? "")
		.split(",")
		.map((field) => field.trim())
		.filter((field) => /^[\w.@-]{1,100}$/.test(field));

export function createGraylog(kalem) {
	async function request(path, { method = "GET", body } = {}) {
		const base = String((await kalem.settings.get("url")) ?? "")
			.trim()
			.replace(/\/+$/, "");
		if (base === "") throw new Error("Set the Graylog address in Settings › Extensions › Graylog.");
		const token = await kalem.secrets.get("token");
		if (!token) throw new Error("Save a Graylog access token in Settings › Extensions › Graylog.");
		const api = /\/api$/.test(base) ? base : `${base}/api`;
		const response = await kalem.http.fetch(`${api}${path}`, {
			method,
			headers: {
				Authorization: `Basic ${btoa(`${token}:token`)}`,
				Accept: "application/json",
				"X-Requested-By": "kalem",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? null : JSON.stringify(body),
			timeoutMs: 60_000,
		});
		if (response.status === 401) throw new Error("Graylog did not accept the token (401).");
		if (response.status === 403)
			throw new Error("The token's user may not do this in Graylog (403).");
		let json = null;
		try {
			json = response.body === "" ? null : JSON.parse(response.body);
		} catch {
			if (response.ok)
				throw new Error(`Graylog's answer is not JSON. Is ${base} Graylog's address?`);
		}
		return { status: response.status, ok: response.ok, json };
	}

	const failure = (answer) =>
		new Error(
			`Graylog answered ${answer.status}: ${answer.json?.message ?? answer.json?.type ?? "no details"}`,
		);

	const timerangeOf = (options) =>
		options.from && options.to
			? {
					type: "absolute",
					from: new Date(options.from).toISOString(),
					to: new Date(options.to).toISOString(),
				}
			: { type: "relative", range: clamp(options.minutes, 1, 60 * 24 * 90, 15) * 60 };

	async function settings() {
		return {
			fields: fieldList(await kalem.settings.get("fields")),
			limit: clamp(await kalem.settings.get("limit"), 1, MAX_LIMIT, 100),
		};
	}

	async function info() {
		const [system, streams] = await Promise.all([request("/system"), request("/streams")]);
		if (!system.ok) throw failure(system);
		return {
			version: String(system.json?.version ?? "").replace(/\+.*/, ""),
			streams: (streams.ok ? (streams.json?.streams ?? []) : [])
				.filter((stream) => !stream.disabled)
				.map((stream) => ({ id: stream.id, title: stream.title }))
				.sort((a, b) => collator.compare(a.title, b.title)),
			...(await settings()),
		};
	}

	async function search(options = {}) {
		const defaults = await settings();
		const query = String(options.query ?? "").trim() || "*";
		const fields = fieldList(
			Array.isArray(options.fields) ? options.fields.join(",") : options.fields,
		);
		const wanted =
			fields.length > 0
				? fields
				: defaults.fields.length > 0
					? defaults.fields
					: ["timestamp", "source", "message"];
		if (!wanted.includes("timestamp")) wanted.unshift("timestamp");
		const size = clamp(options.limit, 1, MAX_LIMIT, defaults.limit);
		const streams = options.stream ? [String(options.stream)] : [];
		const timerange = timerangeOf(options);
		const started = Date.now();

		const body = { query, timerange, fields: wanted, size, streams };
		let answer = await request("/search/messages", {
			method: "POST",
			body: { ...body, sort: "timestamp", sort_order: "Descending" },
		});
		// A version that reads the sort differently: Graylog's own order (newest first) is kept.
		if (answer.status === 400) answer = await request("/search/messages", { method: "POST", body });
		if (answer.ok) {
			const columns = (answer.json?.schema ?? []).map((column) => column.field ?? column.name);
			const rows = (answer.json?.datarows ?? []).map((row) =>
				Object.fromEntries(columns.map((column, index) => [column, row[index]])),
			);
			return {
				fields: wanted,
				rows,
				total: rows.length,
				took: Date.now() - started,
				api: "search/messages",
			};
		}
		if (answer.status !== 404 && answer.status !== 405) throw failure(answer);

		const params = new URLSearchParams({
			query,
			limit: String(size),
			fields: wanted.join(","),
			sort: "timestamp:desc",
		});
		if (streams.length > 0) params.set("filter", `streams:${streams[0]}`);
		let path = "/search/universal/relative";
		if (timerange.type === "absolute") {
			path = "/search/universal/absolute";
			params.set("from", timerange.from);
			params.set("to", timerange.to);
		} else {
			params.set("range", String(timerange.range));
		}
		const legacy = await request(`${path}?${params}`);
		if (!legacy.ok) throw failure(legacy);
		const rows = (legacy.json?.messages ?? []).map((each) =>
			Object.fromEntries(wanted.map((field) => [field, each.message?.[field] ?? null])),
		);
		return {
			fields: wanted,
			rows,
			total: legacy.json?.total_results ?? rows.length,
			took: Date.now() - started,
			api: "search/universal",
		};
	}

	async function topValues(options = {}) {
		const field = fieldList(options.field)[0];
		if (field === undefined) throw new Error("Give a field, e.g. source.");
		const query = String(options.query ?? "").trim() || "*";
		const limit = clamp(options.limit, 1, 100, 10);
		const timerange = timerangeOf(options);
		const answer = await request("/search/aggregate", {
			method: "POST",
			body: {
				query,
				timerange,
				group_by: [{ field, limit }],
				metrics: [{ function: "count" }],
				...(options.stream ? { streams: [String(options.stream)] } : {}),
			},
		});
		if (answer.ok) {
			return (answer.json?.datarows ?? []).map((row) => ({
				value: row[0],
				count: row[row.length - 1],
			}));
		}
		if (answer.status !== 404 && answer.status !== 405) throw failure(answer);
		const params = new URLSearchParams({ field, query, size: String(limit) });
		if (timerange.type === "absolute") {
			params.set("from", timerange.from);
			params.set("to", timerange.to);
		} else {
			params.set("range", String(timerange.range));
		}
		const legacy = await request(
			`/search/universal/${timerange.type === "absolute" ? "absolute" : "relative"}/terms?${params}`,
		);
		if (!legacy.ok) throw failure(legacy);
		return Object.entries(legacy.json?.terms ?? {})
			.map(([value, count]) => ({ value, count }))
			.sort((a, b) => b.count - a.count);
	}

	/** Every field Graylog knows in the stream (or all streams), with its type; older servers give names only. */
	async function fieldNames(options = {}) {
		const streams = options.stream ? [String(options.stream)] : [];
		const answer = await request("/views/fields", { method: "POST", body: { streams } });
		let fields;
		if (answer.ok && Array.isArray(answer.json)) {
			fields = answer.json.map((each) => ({
				name: String(each?.name ?? ""),
				type: String(each?.type?.type ?? ""),
			}));
		} else {
			if (!answer.ok && ![400, 404, 405].includes(answer.status)) throw failure(answer);
			const legacy = await request("/system/fields");
			if (!legacy.ok) throw failure(legacy);
			fields = (legacy.json?.fields ?? []).map((name) => ({ name: String(name), type: "" }));
		}
		const seen = new Set();
		return fields
			.filter(
				(each) => fieldList(each.name).length === 1 && !seen.has(each.name) && seen.add(each.name),
			)
			.sort((a, b) => internal(a.name) - internal(b.name) || collator.compare(a.name, b.name));
	}

	/** Message counts over time, in about 60 bars; split by the top values of a field when one is given. */
	async function histogram(options = {}) {
		const query = String(options.query ?? "").trim() || "*";
		const timerange = timerangeOf(options);
		const to = timerange.type === "absolute" ? Date.parse(timerange.to) : Date.now();
		const from =
			timerange.type === "absolute" ? Date.parse(timerange.from) : to - timerange.range * 1000;
		const [step, unit] = intervalFor((to - from) / 1000, clamp(options.bars, 10, 200, 60));
		const splitBy = fieldList(options.splitBy)[0] ?? null;
		const limit = clamp(options.splitLimit, 1, 10, 5);
		const body = {
			queries: [
				{
					id: "q",
					timerange,
					query: { type: "elasticsearch", query_string: query },
					...(options.stream
						? { filter: { type: "or", filters: [{ type: "stream", id: String(options.stream) }] } }
						: {}),
					search_types: [
						{
							id: "trend",
							type: "pivot",
							row_groups: [
								{
									type: "time",
									fields: ["timestamp"],
									interval: { type: "timeunit", timeunit: unit },
								},
							],
							column_groups: splitBy ? [{ type: "values", fields: [splitBy], limit }] : [],
							series: [{ type: "count", id: "count()" }],
							sort: [],
							rollup: true,
						},
					],
				},
			],
		};
		const answer = await request("/views/search/sync", { method: "POST", body });
		let points;
		let approximate = false;
		if (answer.ok) {
			const result = answer.json?.results?.q;
			const problem = [...(answer.json?.errors ?? []), ...(result?.errors ?? [])][0];
			if (problem)
				throw new Error(
					`Graylog: ${problem.description ?? problem.message ?? "the search failed"}`,
				);
			points = pivotPoints(result?.search_types?.trend?.rows ?? []);
		} else if ([404, 405].includes(answer.status)) {
			// No views API: counted from the newest messages instead.
			const found = await search({
				...options,
				query,
				limit: MAX_LIMIT,
				fields: ["timestamp", ...(splitBy ? [splitBy] : [])],
			});
			points = found.rows.map((row) => ({
				time: Date.parse(row.timestamp),
				total: 1,
				split: splitBy ? { [cellValue(row[splitBy])]: 1 } : {},
			}));
			approximate = found.total > found.rows.length;
		} else {
			throw failure(answer);
		}
		return bucketize(points, from, to, step, splitBy, limit, approximate);
	}

	return { info, search, topValues, fieldNames, histogram };
}

const internal = (name) => (name.startsWith("gl2_") || name.startsWith("_") ? 1 : 0);
const cellValue = (value) =>
	value === null || value === undefined
		? ""
		: typeof value === "string"
			? value
			: JSON.stringify(value);

const STEPS = [
	[60, "1m"],
	[300, "5m"],
	[600, "10m"],
	[900, "15m"],
	[1800, "30m"],
	[3600, "1h"],
	[10800, "3h"],
	[21600, "6h"],
	[43200, "12h"],
	[86400, "1d"],
	[604800, "1w"],
];

export function intervalFor(seconds, bars = 60) {
	return STEPS.find(([step]) => seconds / step <= bars * 1.5) ?? STEPS[STEPS.length - 1];
}

/** A pivot's rows (time, then the split's values) as `{ time, total, split }`. */
export function pivotPoints(rows) {
	const points = [];
	for (const row of rows) {
		const time = Date.parse(row?.key?.[0]);
		if (!Array.isArray(row?.key) || row.key.length === 0 || Number.isNaN(time)) continue;
		let total = null;
		const split = {};
		for (const value of row.values ?? []) {
			const count = Number(value?.value) || 0;
			const key = value?.key ?? [];
			if (value?.rollup || key.length <= 1) total = count;
			else split[String(key[0])] = count;
		}
		points.push({
			time,
			total: total ?? Object.values(split).reduce((sum, each) => sum + each, 0),
			split,
		});
	}
	return points;
}

/** Points into even bars from `from` to `to` (empty ones kept), with the split's top values and the rest. */
export function bucketize(points, from, to, step, splitBy, limit, approximate) {
	const size = step * 1000;
	const start = Math.floor(from / size) * size;
	const bars = new Map();
	for (let time = start; time <= to; time += size) bars.set(time, { time, total: 0, split: {} });
	const sums = new Map();
	for (const point of points) {
		if (point.time < start || point.time > to) continue;
		const time = Math.floor(point.time / size) * size;
		const bar = bars.get(time) ?? bars.set(time, { time, total: 0, split: {} }).get(time);
		bar.total += point.total;
		for (const [value, count] of Object.entries(point.split)) {
			bar.split[value] = (bar.split[value] ?? 0) + count;
			sums.set(value, (sums.get(value) ?? 0) + count);
		}
	}
	const series = [...sums.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([value]) => value);
	const buckets = [...bars.values()].sort((a, b) => a.time - b.time);
	for (const bar of buckets) {
		const kept = Object.fromEntries(series.map((value) => [value, bar.split[value] ?? 0]));
		const other = bar.total - Object.values(kept).reduce((sum, each) => sum + each, 0);
		bar.split = splitBy && other > 0 ? { ...kept, "": other } : kept;
	}
	const total = buckets.reduce((sum, bar) => sum + bar.total, 0);
	const peak = buckets.reduce((best, bar) => (bar.total > (best?.total ?? -1) ? bar : best), null);
	return { from, to, step, splitBy, series, buckets, total, peak, approximate };
}

export function trendText(trend) {
	const time = (ms) => new Date(ms).toISOString().replace(":00.000Z", "Z");
	const busy = trend.buckets.filter((bar) => bar.total > 0);
	const lines = [
		`${trend.total} message(s) from ${time(trend.from)} to ${time(trend.to)}, in bars of ${trend.step / 60} minute(s)${trend.approximate ? " (approximate: counted from the newest 1000 messages)" : ""}.`,
	];
	if (trend.peak && trend.peak.total > 0)
		lines.push(`Peak: ${trend.peak.total} at ${time(trend.peak.time)}.`);
	if (trend.splitBy)
		lines.push(
			`Split by ${trend.splitBy}: ${trend.series.join(", ")}${trend.buckets.some((bar) => "" in bar.split) ? ", (other)" : ""}`,
		);
	for (const bar of busy.slice(-150)) {
		const parts = trend.splitBy
			? ` (${Object.entries(bar.split)
					.filter(([, count]) => count > 0)
					.map(([value, count]) => `${value || "(other)"}=${count}`)
					.join(", ")})`
			: "";
		lines.push(`${time(bar.time)} ${bar.total}${parts}`);
	}
	if (busy.length === 0) lines.push("No messages in this time.");
	return lines.join("\n");
}

export function asText(result) {
	if (result.rows.length === 0) return "No messages matched.";
	const lines = [
		`${result.rows.length} message(s), newest first. Fields: ${result.fields.join(" | ")}`,
	];
	let size = lines[0].length;
	for (const row of result.rows) {
		const line = result.fields
			.map((field) => {
				const value = row[field];
				const text =
					value === null || value === undefined
						? ""
						: typeof value === "string"
							? value
							: JSON.stringify(value);
				return text.replace(/\s+/g, " ").slice(0, field === "message" ? 1000 : 200);
			})
			.join(" | ");
		size += line.length + 1;
		if (size > MAX_TOOL_TEXT) {
			lines.push(
				`… ${result.rows.length - lines.length + 1} more not shown; narrow the query or the time.`,
			);
			break;
		}
		lines.push(line);
	}
	return lines.join("\n");
}

const TIME_PARAMETERS = {
	minutes: {
		type: "integer",
		description:
			"How far back to look, in minutes (default 15). Ignored when from and to are given.",
	},
	from: { type: "string", description: "Start of an absolute time range (ISO 8601)." },
	to: { type: "string", description: "End of an absolute time range (ISO 8601)." },
	stream: {
		type: "string",
		description: "A stream's id, from graylog_streams, to search only it.",
	},
};

export async function activate(kalem) {
	const graylog = createGraylog(kalem);

	await kalem.ui.handle("info", () => graylog.info());
	await kalem.ui.handle("search", (input) => graylog.search(input ?? {}));
	await kalem.ui.handle("topValues", (input) => graylog.topValues(input ?? {}));
	await kalem.ui.handle("fields", (input) => graylog.fieldNames(input ?? {}));
	await kalem.ui.handle("histogram", (input) => graylog.histogram(input ?? {}));
	await kalem.ui.handle("prefs", async () => ({
		saved: (await kalem.storage.get("saved")) ?? [],
		columns: (await kalem.storage.get("columns")) ?? null,
		splitBy: (await kalem.storage.get("splitBy")) ?? "",
		trend: (await kalem.storage.get("trend")) ?? true,
	}));
	await kalem.ui.handle("setPrefs", async (input) => {
		for (const key of ["saved", "columns", "splitBy", "trend"]) {
			if (input && Object.hasOwn(input, key)) await kalem.storage.set(key, input[key]);
		}
		return true;
	});
	await kalem.commands.register("open", () => kalem.ui.showPane("search"));

	await kalem.assistant.registerTool(
		{
			name: "graylog_search",
			description:
				'Searches the logs in Graylog with Graylog\'s query language (Lucene: `level:3 AND source:api*`, `"OutOfMemoryError"`, `http_status:[500 TO 599]`) and returns the matching messages, newest first.',
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "The Graylog query; * for everything." },
					...TIME_PARAMETERS,
					limit: {
						type: "integer",
						description: "At most this many messages (default as set, at most 1000).",
					},
					fields: {
						type: "array",
						items: { type: "string" },
						description: "Fields to return; the configured ones when missing.",
					},
				},
				required: ["query"],
			},
		},
		async (input) => asText(await graylog.search(input ?? {})),
	);

	await kalem.assistant.registerTool(
		{
			name: "graylog_top_values",
			description:
				"Counts the messages matching a Graylog query by the values of one field (which sources, which errors, which hosts occur most), for an overview before reading messages.",
			parameters: {
				type: "object",
				properties: {
					field: { type: "string", description: "The field to count by, e.g. source." },
					query: { type: "string", description: "The Graylog query; * for everything." },
					...TIME_PARAMETERS,
					limit: { type: "integer", description: "How many values (default 10)." },
				},
				required: ["field"],
			},
		},
		async (input) => {
			const values = await graylog.topValues(input ?? {});
			return values.length === 0
				? "Nothing matched."
				: values.map((each) => `${each.value}: ${each.count}`).join("\n");
		},
	);

	await kalem.assistant.registerTool(
		{
			name: "graylog_trend",
			description:
				"How many messages matched a Graylog query over time, in about 60 bars (busy bars listed, with the peak), optionally split by the top values of a field (level, source…). For trends: when errors rose, whether a source got noisier, how today compares with the hour before.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "The Graylog query; * for everything." },
					...TIME_PARAMETERS,
					splitBy: {
						type: "string",
						description: "A field to split the counts by, e.g. level or source.",
					},
				},
				required: ["query"],
			},
		},
		async (input) => trendText(await graylog.histogram(input ?? {})),
	);

	await kalem.assistant.registerTool(
		{
			name: "graylog_fields",
			description:
				"Lists the fields Graylog's messages have (name and type), to choose what to search, show or count by.",
			parameters: {
				type: "object",
				properties: { stream: TIME_PARAMETERS.stream },
				required: [],
			},
		},
		async (input) =>
			(await graylog.fieldNames(input ?? {}))
				.map((field) => (field.type ? `${field.name} (${field.type})` : field.name))
				.join("\n") || "No fields.",
	);

	await kalem.assistant.registerTool(
		{
			name: "graylog_saved_searches",
			description:
				"The searches the user saved in the Graylog pane (name, query, stream, time), to run one with graylog_search or graylog_trend when the user names it.",
			parameters: { type: "object", properties: {}, required: [] },
		},
		async () => {
			const saved = (await kalem.storage.get("saved")) ?? [];
			return saved.length === 0
				? "No saved searches."
				: saved
						.map(
							(each) =>
								`${each.name}: ${each.query}${each.stream ? ` (stream ${each.stream})` : ""}, last ${each.minutes} minute(s)`,
						)
						.join("\n");
		},
	);

	await kalem.assistant.registerTool(
		{
			name: "graylog_streams",
			description: "Lists Graylog's streams (id and title) and its version.",
			parameters: { type: "object", properties: {}, required: [] },
		},
		async () => {
			const info = await graylog.info();
			return [
				`Graylog ${info.version}`,
				...info.streams.map((stream) => `${stream.id}: ${stream.title}`),
			].join("\n");
		},
	);
}
