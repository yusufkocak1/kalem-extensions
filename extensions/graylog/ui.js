import { el, icon } from "./dom.js";
import { translator } from "./i18n.js";

const kalem = window.kalem;
const t = translator(kalem.language);
const app = document.getElementById("app");

const LEVELS = ["emerg", "alert", "crit", "error", "warn", "notice", "info", "debug"];
const RANGES = [
	["5", "Last 5 minutes"],
	["15", "Last 15 minutes"],
	["60", "Last hour"],
	["240", "Last 4 hours"],
	["1440", "Last day"],
	["10080", "Last 7 days"],
];
const EXAMPLES = ["level:3", "source:api*", '"Exception"', "http_status:[500 TO 599]"];

const remembered = (() => {
	try {
		return JSON.parse(localStorage.getItem("graylog") ?? "{}");
	} catch {
		return {};
	}
})();

let loaded = false;
let searched = false;
let version = "";
const open = new Set();
let defaultFields = [];
let columns = null;
let saved = [];
let splitBy = "";
let trendOn = true;
let zoom = null;
let baseRange = "15";
const fieldCache = new Map();

const shownFields = () => (columns && columns.length > 0 ? columns : defaultFields);
const savePrefs = (prefs) => void kalem.call("setPrefs", prefs).catch(() => undefined);
const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// --- Controls --------------------------------------------------------------------------

const query = el("input", {
	id: "query",
	class: "k-input k-mono",
	type: "search",
	placeholder: "level:3 AND source:api*",
	spellcheck: "false",
	autocomplete: "off",
	"aria-label": "Query",
});
query.value = remembered.query ?? "";
const range = el(
	"select",
	{ id: "range", class: "k-select graylog-range", "aria-label": "Time" },
	RANGES.map(([value, label]) => el("option", { value, text: t(label) })),
);
range.value = baseRange;
const stream = el(
	"select",
	{ id: "stream", class: "k-select graylog-stream", "aria-label": "Stream" },
	[el("option", { value: "", text: t("All streams") })],
);
const go = el("button", { id: "go", class: "k-button primary", type: "submit" }, [
	icon("search"),
	document.createTextNode(t("Search")),
]);
const iconButton = (name, label, onclick, extra = {}) =>
	el(
		"button",
		{
			class: "k-button icon ghost",
			type: "button",
			title: label,
			"aria-label": label,
			onclick,
			...extra,
		},
		[icon(name)],
	);
const saveButton = iconButton("star", t("Save this search"), () => void saveSearch());
const fieldsButton = el(
	"button",
	{ class: "k-button ghost", type: "button", onclick: () => void pickFields() },
	[icon("columns"), document.createTextNode(t("Fields"))],
);
const trendButton = iconButton("chart", t("Trend"), () => {
	trendOn = !trendOn;
	trendButton.setAttribute("aria-pressed", String(trendOn));
	savePrefs({ trend: trendOn });
	trendBox.hidden = !trendOn;
	if (trendOn && searched) void drawTrend();
});
const form = el("form", { id: "form", class: "k-toolbar graylog-bar" }, [
	el("div", { class: "k-search" }, [icon("search"), query]),
	range,
	stream,
	go,
	saveButton,
	fieldsButton,
	trendButton,
]);
range.addEventListener("change", () => {
	if (range.value !== "zoom") {
		zoom = null;
		baseRange = range.value;
	}
	range.querySelector('option[value="zoom"]')?.remove();
});
form.addEventListener("submit", (event) => {
	event.preventDefault();
	void run();
});

const connection = el("span", { class: "graylog-connection" });
const status = el("p", { id: "status", class: "graylog-status", role: "status" });
const levels = el("div", { class: "graylog-levels" });
const summary = el("div", { class: "graylog-summary" }, [
	status,
	levels,
	el("span", { class: "k-spacer" }),
	connection,
]);
const results = el("div", { class: "graylog-results" });
const savedBar = el("div", {
	class: "graylog-saved",
	role: "toolbar",
	"aria-label": t("Saved searches"),
});
const trendBox = el("section", { class: "graylog-trend", "aria-label": t("Trend") });

const say = (text, error = false) => {
	status.textContent = text;
	status.classList.toggle("error", error);
};

function showConnection(ok, detail = "") {
	connection.replaceChildren(
		el("span", { class: `k-dot ${ok ? "ok" : "error"}` }),
		el("span", { text: ok ? `${t("Connected")} · Graylog ${detail}` : t("Not connected") }),
	);
}

// --- Results ---------------------------------------------------------------------------

const cellText = (value) =>
	value === null || value === undefined
		? ""
		: typeof value === "string"
			? value
			: JSON.stringify(value);

function timeText(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return cellText(value);
	const pad = (number, size = 2) => String(number).padStart(size, "0");
	return `${date.toLocaleDateString(navigator.language)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

const levelKind = (level) =>
	level <= 3 ? "error" : level === 4 ? "warn" : level <= 6 ? "info" : "";

function levelBadge(value) {
	const level = Number(value);
	if (!Number.isInteger(level)) return el("span", { text: cellText(value) });
	const kind = levelKind(level);
	return el("span", {
		class: `k-badge ${kind} level-${kind === "warn" ? "warning" : kind}`,
		text: LEVELS[level] ?? String(level),
	});
}

function empty() {
	return el("div", { class: "k-empty" }, [
		el("span", { class: "k-empty-icon" }, [icon("search")]),
		el("strong", { text: t("Search Graylog") }),
		el("p", { text: t("Write a query, or start from one of these:") }),
		el(
			"div",
			{ class: "graylog-examples" },
			EXAMPLES.map((example) =>
				el(
					"button",
					{
						type: "button",
						class: "k-button small graylog-example",
						onclick: () => {
							query.value = example;
							void run();
						},
					},
					[el("code", { text: example })],
				),
			),
		),
	]);
}

function show(result) {
	const counts = new Map();
	for (const row of result.rows) {
		const kind = levelKind(Number(row.level));
		if (kind !== "") counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	levels.replaceChildren(
		...["error", "warn", "info"]
			.filter((kind) => counts.has(kind))
			.map((kind) => el("span", { class: `k-badge ${kind}`, text: `${counts.get(kind)} ${kind}` })),
	);
	if (result.rows.length === 0) {
		results.replaceChildren(
			el("div", { class: "k-empty" }, [
				el("span", { class: "k-empty-icon" }, [icon("search")]),
				el("strong", { text: t("No messages matched") }),
				el("p", { text: t("Widen the time, or loosen the query.") }),
			]),
		);
		return;
	}
	open.clear();
	const body = el("tbody");
	result.rows.forEach((row, index) => {
		const line = el(
			"tr",
			{ class: "row", "data-index": String(index) },
			result.fields.map((field) => {
				if (field === "timestamp")
					return el("td", { class: "graylog-time k-mono", text: timeText(row[field]) });
				if (field === "level") return el("td", {}, [levelBadge(row[field])]);
				if (field === "message")
					return el("td", { class: "message k-mono", text: cellText(row[field]) });
				return el("td", { class: "graylog-cell", text: cellText(row[field]) });
			}),
		);
		line.addEventListener("click", () => {
			const next = line.nextElementSibling;
			if (next?.classList.contains("detail")) {
				next.remove();
				line.removeAttribute("aria-expanded");
				return;
			}
			line.setAttribute("aria-expanded", "true");
			const copy = el(
				"button",
				{
					class: "k-button ghost small",
					onclick: async (event) => {
						event.stopPropagation();
						try {
							await navigator.clipboard.writeText(JSON.stringify(row, null, 2));
						} catch {}
						copy.replaceChildren(icon("check"), document.createTextNode(t("Copied")));
					},
				},
				[icon("copy"), document.createTextNode(t("Copy"))],
			);
			line.after(
				el("tr", { class: "detail" }, [
					el("td", { colspan: String(result.fields.length) }, [
						el("div", { class: "graylog-detail" }, [
							el(
								"dl",
								{ class: "graylog-kv" },
								Object.entries(row).flatMap(([key, value]) => [
									el("dt", {}, [
										el("button", {
											type: "button",
											class: "graylog-field-name",
											text: key,
											onclick: (event) => {
												event.stopPropagation();
												fieldMenu(event, key);
											},
										}),
									]),
									el("dd", { class: "k-mono" }, [
										key === "timestamp" || cellText(value) === ""
											? el("span", { text: cellText(value) })
											: el("button", {
													type: "button",
													class: "graylog-value",
													text: cellText(value),
													onclick: (event) => {
														event.stopPropagation();
														fieldMenu(event, key, value);
													},
												}),
									]),
								]),
							),
							copy,
						]),
					]),
				]),
			);
		});
		body.append(line);
	});
	results.replaceChildren(
		el("table", { id: "table", class: "k-table graylog-table" }, [
			el("thead", {}, [
				el(
					"tr",
					{},
					result.fields.map((field) =>
						el("th", {}, [
							el("button", {
								type: "button",
								class: "graylog-field-name",
								text: field,
								onclick: (event) => fieldMenu(event, field),
							}),
						]),
					),
				),
			]),
			body,
		]),
	);
}

// --- Searching -------------------------------------------------------------------------

async function loadInfo() {
	const info = await kalem.call("info");
	stream.replaceChildren(
		el("option", { value: "", text: t("All streams") }),
		...info.streams.map((each) => el("option", { value: each.id, text: each.title })),
	);
	if (remembered.stream) stream.value = remembered.stream;
	defaultFields =
		info.fields.length > 0 ? info.fields : ["timestamp", "source", "level", "message"];
	loaded = true;
	version = info.version;
	showConnection(true, version);
	return info;
}

async function run() {
	try {
		localStorage.setItem(
			"graylog",
			JSON.stringify({ query: query.value, range: baseRange, stream: stream.value }),
		);
	} catch {}
	searched = true;
	go.disabled = true;
	levels.replaceChildren();
	status.replaceChildren(
		el("span", { class: "k-spinner" }),
		document.createTextNode(` ${t("Searching")}`),
	);
	try {
		if (!loaded) await loadInfo();
		const result = await kalem.call("search", { ...searchInput(), fields: shownFields() });
		show(result);
		trendBox.hidden = !trendOn;
		if (trendOn) void drawTrend();
		say(
			result.rows.length === 0
				? ""
				: `${t("{0} of {1} messages", result.rows.length, result.total)} · ${t("{0} ms", result.took)}`,
		);
	} catch (error) {
		results.replaceChildren(
			el("div", { class: "graylog-error" }, [
				el("div", { class: "k-notice error" }, [
					icon("alert"),
					el("span", { text: error.message }),
				]),
			]),
		);
		say("");
		showConnection(false);
	} finally {
		go.disabled = false;
	}
}

const connect = () =>
	loadInfo().then(
		() => {
			if (!searched) say("");
		},
		(error) => {
			showConnection(false);
			if (!searched) say(error.message, true);
		},
	);

// --- Narrowing from a value ----------------------------------------------------------

function quoted(value) {
	const text = cellText(value);
	return /^[\w.@:-]+$/.test(text) && !/^(AND|OR|NOT|TO)$/.test(text)
		? text
		: `"${text.replace(/(["\\])/g, "\\$1")}"`;
}

function narrow(field, value, exclude) {
	addTerm(`${exclude ? "NOT " : ""}${field}:${quoted(value)}`);
}

function searchInput() {
	return {
		query: query.value,
		stream: stream.value || undefined,
		...(zoom
			? { from: new Date(zoom.from).toISOString(), to: new Date(zoom.to).toISOString() }
			: { minutes: Number(range.value) }),
	};
}

// --- Field and value menus -------------------------------------------------------------

function menu(event, items) {
	document.querySelector(".graylog-menu")?.remove();
	const list = el("div", { class: "graylog-menu", role: "menu" });
	for (const item of items) {
		if (item === "-") {
			list.append(el("div", { class: "graylog-menu-line", role: "separator" }));
			continue;
		}
		if (item.heading) {
			list.append(el("div", { class: "graylog-menu-heading k-mono", text: item.heading }));
			continue;
		}
		list.append(
			el(
				"button",
				{
					type: "button",
					role: "menuitem",
					class: "graylog-menu-item",
					onclick: () => {
						list.remove();
						item.run();
					},
				},
				[icon(item.icon), el("span", { text: item.text })],
			),
		);
	}
	document.body.append(list);
	const box = list.getBoundingClientRect();
	list.style.left = `${Math.max(4, Math.min(event.clientX, innerWidth - box.width - 6))}px`;
	list.style.top = `${Math.max(4, Math.min(event.clientY + 4, innerHeight - box.height - 6))}px`;
	list.querySelector("button")?.focus();
	const away = (other) => {
		if (other.type === "keydown" && other.key !== "Escape") return;
		if (other.type === "pointerdown" && list.contains(other.target)) return;
		list.remove();
		removeEventListener("pointerdown", away, true);
		removeEventListener("keydown", away, true);
	};
	addEventListener("pointerdown", away, true);
	addEventListener("keydown", away, true);
}

function fieldMenu(event, field, value) {
	const shown = shownFields().includes(field);
	const hasValue = value !== undefined && cellText(value) !== "";
	menu(
		event,
		[
			{ heading: hasValue ? `${field}: ${cellText(value).slice(0, 60)}` : field },
			...(hasValue
				? [
						{ text: t("Add to query"), icon: "plus", run: () => narrow(field, value, false) },
						{
							text: t("Exclude from results"),
							icon: "minus",
							run: () => narrow(field, value, true),
						},
					]
				: [
						{
							text: t("Only messages with this field"),
							icon: "plus",
							run: () => addTerm(`_exists_:${field}`),
						},
					]),
			{ text: t("Show top values"), icon: "chart", run: () => void showTopValues(field) },
			"-",
			field === "timestamp"
				? null
				: shown
					? {
							text: t("Remove column"),
							icon: "close",
							run: () => setColumns(shownFields().filter((each) => each !== field)),
						}
					: {
							text: t("Add as column"),
							icon: "columns",
							run: () => setColumns([...shownFields(), field]),
						},
			{
				text: t("Split the trend by this field"),
				icon: "chart",
				run: () => {
					splitBy = field;
					savePrefs({ splitBy });
					if (!trendOn) trendButton.click();
					else void drawTrend();
				},
			},
			...(hasValue
				? [
						{
							text: t("Copy value"),
							icon: "copy",
							run: () => void navigator.clipboard.writeText(cellText(value)).catch(() => undefined),
						},
					]
				: []),
		].filter(Boolean),
	);
}

function setColumns(next) {
	columns = next.includes("timestamp") ? next : ["timestamp", ...next];
	savePrefs({ columns });
	if (searched) void run();
}

function addTerm(term) {
	const current = query.value.trim();
	query.value = current === "" || current === "*" ? term : `(${current}) AND ${term}`;
	void run();
}

async function showTopValues(field) {
	const dialog = el("dialog", {
		class: "graylog-dialog wide",
		"aria-label": t("Top values of {0}", field),
	});
	const close = () => {
		dialog.close();
		dialog.remove();
	};
	const body = el("div", { class: "graylog-top" }, [el("span", { class: "k-spinner" })]);
	dialog.append(
		el("div", { class: "graylog-dialog-body" }, [
			el("h2", { text: t("Top values of {0}", field) }),
			el("p", {
				class: "k-muted",
				text: `${query.value.trim() || "*"} · ${range.selectedOptions[0]?.textContent ?? ""}`,
			}),
			body,
			el("div", { class: "graylog-dialog-actions" }, [
				el("button", { type: "button", class: "k-button ghost", text: t("Close"), onclick: close }),
			]),
		]),
	);
	dialog.addEventListener("cancel", close);
	document.body.append(dialog);
	dialog.showModal();
	let values;
	try {
		values = await kalem.call("topValues", { ...searchInput(), field, limit: 10 });
	} catch (error) {
		body.replaceChildren(
			el("div", { class: "k-notice error" }, [icon("alert"), el("span", { text: error.message })]),
		);
		return;
	}
	if (values.length === 0) {
		body.replaceChildren(el("p", { class: "k-muted", text: t("No messages matched") }));
		return;
	}
	const most = Math.max(...values.map((each) => each.count));
	const sum = values.reduce((total, each) => total + each.count, 0);
	body.replaceChildren(
		...values.map((each) =>
			el("div", { class: "graylog-top-row", "data-value": cellText(each.value) }, [
				el("span", {
					class: "graylog-top-value k-mono",
					text:
						field === "level" && LEVEL_NAMES.has(String(each.value))
							? `${each.value} · ${LEVEL_NAMES.get(String(each.value))}`
							: cellText(each.value) || "—",
				}),
				el("span", { class: "graylog-top-bar" }, [
					el("span", { style: `width:${(each.count / most) * 100}%` }),
				]),
				el("span", {
					class: "graylog-top-count",
					text: `${each.count.toLocaleString(kalem.language)} · ${Math.round((each.count / sum) * 100)}%`,
				}),
				iconButton(
					"plus",
					t("Add to query"),
					() => {
						close();
						narrow(field, each.value, false);
					},
					{ class: "k-button icon small ghost" },
				),
				iconButton(
					"minus",
					t("Exclude from results"),
					() => {
						close();
						narrow(field, each.value, true);
					},
					{ class: "k-button icon small ghost" },
				),
			]),
		),
	);
}

// --- Saved searches ---------------------------------------------------------------------

function drawSaved() {
	savedBar.hidden = saved.length === 0;
	savedBar.replaceChildren(
		el("span", { class: "graylog-saved-label" }, [icon("star"), el("span", { text: t("Saved") })]),
		...saved.map((each) =>
			el("span", { class: "graylog-chip", "data-saved": each.name }, [
				el("button", {
					type: "button",
					class: "graylog-chip-run",
					title: each.query,
					text: each.name,
					onclick: () => applySaved(each),
				}),
				el(
					"button",
					{
						type: "button",
						class: "graylog-chip-remove",
						title: t("Remove"),
						"aria-label": `${t("Remove")} ${each.name}`,
						onclick: () => {
							saved = saved.filter((other) => other.id !== each.id);
							savePrefs({ saved });
							drawSaved();
						},
					},
					[icon("close")],
				),
			]),
		),
	);
}

function applySaved(each) {
	query.value = each.query;
	zoom = null;
	range.querySelector('option[value="zoom"]')?.remove();
	range.value = each.range ?? "15";
	if ([...stream.options].some((option) => option.value === (each.stream ?? "")))
		stream.value = each.stream ?? "";
	if (each.columns) {
		columns = each.columns;
		savePrefs({ columns });
	}
	if (each.splitBy !== undefined) {
		splitBy = each.splitBy;
		savePrefs({ splitBy });
	}
	void run();
}

function saveSearch() {
	const name = el("input", {
		class: "k-input",
		value: query.value.slice(0, 40),
		"aria-label": t("Name"),
	});
	const withFields = el("input", { type: "checkbox", checked: true });
	const dialog = el("dialog", { class: "graylog-dialog", "aria-label": t("Save this search") });
	const close = () => {
		dialog.close();
		dialog.remove();
	};
	const keep = () => {
		const title = name.value.trim();
		if (title === "") return;
		const entry = {
			id: newId(),
			name: title,
			query: query.value.trim() || "*",
			range: zoom ? baseRange : range.value,
			stream: stream.value,
			minutes: Number(zoom ? baseRange : range.value),
			splitBy,
			...(withFields.checked ? { columns: shownFields() } : {}),
		};
		saved = [...saved.filter((each) => each.name !== title), entry];
		savePrefs({ saved });
		drawSaved();
		close();
	};
	const formBox = el("form", { class: "graylog-dialog-body" }, [
		el("h2", { text: t("Save this search") }),
		el("p", { class: "k-muted", text: query.value.trim() || "*" }),
		el("label", { class: "graylog-field" }, [el("span", { text: t("Name") }), name]),
		el("label", { class: "k-check" }, [withFields, el("span", { text: t("With these fields") })]),
		el("div", { class: "graylog-dialog-actions" }, [
			el("button", { type: "button", class: "k-button ghost", text: t("Cancel"), onclick: close }),
			el("button", { type: "submit", class: "k-button primary", text: t("Save") }),
		]),
	]);
	formBox.addEventListener("submit", (event) => {
		event.preventDefault();
		keep();
	});
	dialog.addEventListener("cancel", close);
	dialog.append(formBox);
	document.body.append(dialog);
	dialog.showModal();
	name.select();
}

// --- Fields -----------------------------------------------------------------------------

async function allFields() {
	const key = stream.value;
	if (!fieldCache.has(key)) fieldCache.set(key, kalem.call("fields", { stream: key || undefined }));
	try {
		return await fieldCache.get(key);
	} catch (error) {
		fieldCache.delete(key);
		throw error;
	}
}

async function pickFields() {
	const chosen = [...shownFields()];
	const filter = el("input", {
		class: "k-input",
		type: "search",
		placeholder: t("Filter fields"),
		"aria-label": t("Filter fields"),
	});
	const list = el("div", { class: "graylog-field-list", role: "group", "aria-label": t("Fields") });
	const count = el("span", { class: "k-muted k-small" });
	const dialog = el("dialog", { class: "graylog-dialog wide", "aria-label": t("Fields") });
	const close = () => {
		dialog.close();
		dialog.remove();
	};
	let fields = [];
	const draw = () => {
		const words = filter.value.trim().toLocaleLowerCase(kalem.language);
		const visible = fields.filter((field) =>
			field.name.toLocaleLowerCase(kalem.language).includes(words),
		);
		const ordered = [
			...chosen
				.map(
					(name) =>
						visible.find((field) => field.name === name) ??
						(words === "" || name.includes(words) ? { name, type: "" } : null),
				)
				.filter(Boolean),
			...visible.filter((field) => !chosen.includes(field.name)),
		];
		count.textContent = t("{0} of {1} fields shown", chosen.length, fields.length);
		list.replaceChildren(
			...ordered.map((field) => {
				const box = el("input", { type: "checkbox", "aria-label": field.name });
				box.checked = chosen.includes(field.name);
				box.disabled = field.name === "timestamp";
				box.addEventListener("change", () => {
					if (box.checked) chosen.push(field.name);
					else chosen.splice(chosen.indexOf(field.name), 1);
					draw();
				});
				return el("label", { class: "graylog-field-item", "data-field": field.name }, [
					box,
					el("span", { class: "k-mono", text: field.name }),
					field.type ? el("span", { class: "k-badge", text: field.type }) : null,
				]);
			}),
		);
		if (ordered.length === 0)
			list.append(el("p", { class: "k-muted", text: t("No field matches.") }));
	};
	filter.addEventListener("input", draw);
	dialog.append(
		el("div", { class: "graylog-dialog-body" }, [
			el("h2", { text: t("Fields") }),
			el("p", {
				class: "k-muted",
				text: t("Every field Graylog has in this stream. Pick the columns to show."),
			}),
			filter,
			list,
			el("div", { class: "graylog-dialog-actions" }, [
				count,
				el("span", { class: "k-spacer" }),
				el("button", {
					type: "button",
					class: "k-button ghost",
					text: t("Back to the defaults"),
					onclick: () => {
						chosen.splice(0, chosen.length, ...defaultFields);
						draw();
					},
				}),
				el("button", {
					type: "button",
					class: "k-button ghost",
					text: t("Cancel"),
					onclick: close,
				}),
				el("button", {
					type: "button",
					class: "k-button primary",
					text: t("Show"),
					onclick: () => {
						columns = chosen.includes("timestamp") ? [...chosen] : ["timestamp", ...chosen];
						savePrefs({ columns });
						close();
						if (searched) void run();
					},
				}),
			]),
		]),
	);
	dialog.addEventListener("cancel", close);
	document.body.append(dialog);
	dialog.showModal();
	list.replaceChildren(el("span", { class: "k-spinner" }));
	try {
		fields = await allFields();
		if (!fields.some((field) => field.name === "timestamp"))
			fields.unshift({ name: "timestamp", type: "date" });
	} catch (error) {
		list.replaceChildren(
			el("div", { class: "k-notice error" }, [icon("alert"), el("span", { text: error.message })]),
		);
		return;
	}
	draw();
	filter.focus();
}

// --- Trend ------------------------------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => {
	const node = document.createElementNS(SVG, tag);
	for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
	return node;
};
const LEVEL_NAMES = new Map(LEVELS.map((name, index) => [String(index), name]));
const seriesName = (value) =>
	value === ""
		? t("other")
		: splitBy === "level" && LEVEL_NAMES.has(value)
			? LEVEL_NAMES.get(value)
			: value;
const seriesKind = (value, index) => {
	if (value === "") return "other";
	if (splitBy === "level" && /^\d$/.test(value)) {
		const kind = levelKind(Number(value));
		return kind === "" ? `s${index % 6}` : kind;
	}
	return `s${index % 6}`;
};

function clock(ms, step) {
	const date = new Date(ms);
	const pad = (number) => String(number).padStart(2, "0");
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return step >= 86400
		? date.toLocaleDateString(kalem.language)
		: step >= 3600
			? `${date.toLocaleDateString(kalem.language, { day: "numeric", month: "short" })} ${time}`
			: time;
}

async function drawTrend() {
	const splitSelect = el(
		"select",
		{ class: "k-select graylog-split", "aria-label": t("Split by") },
		[el("option", { value: "", text: t("No split") })],
	);
	const head = el("div", { class: "graylog-trend-head" }, [
		el("strong", {}, [icon("chart"), document.createTextNode(t("Trend"))]),
		el("span", { class: "graylog-trend-info k-muted", text: "" }),
		el("span", { class: "k-spacer" }),
		zoom
			? el(
					"button",
					{
						type: "button",
						class: "k-button small ghost",
						onclick: () => {
							zoom = null;
							range.querySelector('option[value="zoom"]')?.remove();
							range.value = baseRange;
							void run();
						},
					},
					[
						icon("zoomOut"),
						document.createTextNode(
							t(
								"Back to {0}",
								t(RANGES.find(([value]) => value === baseRange)?.[1] ?? "Last 15 minutes"),
							),
						),
					],
				)
			: null,
		el("label", { class: "graylog-split-label" }, [
			el("span", { text: t("Split by") }),
			splitSelect,
		]),
	]);
	const chart = el("div", { class: "graylog-chart" }, [el("span", { class: "k-spinner" })]);
	trendBox.replaceChildren(head, chart);
	const known = new Set([
		"level",
		"source",
		...shownFields().filter((field) => field !== "timestamp" && field !== "message"),
	]);
	for (const name of known) splitSelect.append(el("option", { value: name, text: name }));
	allFields()
		.then((fields) => {
			for (const field of fields) {
				if (!known.has(field.name) && field.name !== "timestamp") {
					known.add(field.name);
					splitSelect.append(el("option", { value: field.name, text: field.name }));
				}
			}
			splitSelect.value = splitBy;
		})
		.catch(() => undefined);
	if (!known.has(splitBy) && splitBy !== "")
		splitSelect.append(el("option", { value: splitBy, text: splitBy }));
	splitSelect.value = splitBy;
	splitSelect.addEventListener("change", () => {
		splitBy = splitSelect.value;
		savePrefs({ splitBy });
		void drawTrend();
	});
	let trend;
	try {
		trend = await kalem.call("histogram", { ...searchInput(), splitBy: splitBy || undefined });
	} catch (error) {
		chart.replaceChildren(
			el("div", { class: "k-notice error" }, [icon("alert"), el("span", { text: error.message })]),
		);
		return;
	}
	const info = head.querySelector(".graylog-trend-info");
	info.textContent = [
		t("{0} messages", trend.total.toLocaleString(kalem.language)),
		trend.peak && trend.peak.total > 0
			? t("peak {0} at {1}", trend.peak.total, clock(trend.peak.time, trend.step))
			: "",
		t("bars of {0}", trend.step >= 3600 ? `${trend.step / 3600} h` : `${trend.step / 60} min`),
		trend.approximate ? t("approximate") : "",
	]
		.filter(Boolean)
		.join(" · ");
	renderChart(chart, trend);
}

function renderChart(chart, trend) {
	const width = 1000;
	const height = 150;
	const left = 44;
	const bottom = 20;
	const top = 8;
	const bars = trend.buckets;
	const max = Math.max(1, ...bars.map((bar) => bar.total));
	const nice = niceMax(max);
	const plotWidth = width - left - 8;
	const slot = plotWidth / Math.max(1, bars.length);
	const scale = (height - bottom - top) / nice;
	const series = trend.splitBy
		? [...trend.series, ...(bars.some((bar) => "" in bar.split) ? [""] : [])]
		: [null];
	const canvas = svg("svg", {
		viewBox: `0 0 ${width} ${height}`,
		preserveAspectRatio: "none",
		class: "graylog-svg",
		role: "img",
		"aria-label": t("Trend"),
	});
	for (const fraction of [0, 0.5, 1]) {
		const y = height - bottom - nice * fraction * scale;
		canvas.append(svg("line", { x1: left, x2: width - 8, y1: y, y2: y, class: "graylog-grid" }));
	}
	const labels = el(
		"div",
		{ class: "graylog-axis-y" },
		[0, 0.5, 1].map((fraction) =>
			el("span", {
				style: `bottom:${((bottom + nice * fraction * scale) / height) * 100}%`,
				text: formatCount(nice * fraction),
			}),
		),
	);
	bars.forEach((bar, index) => {
		let y = height - bottom;
		const group = svg("g", {
			class: "graylog-bar",
			"data-time": bar.time,
			"data-total": bar.total,
		});
		for (const [position, value] of series.entries()) {
			const count = value === null ? bar.total : (bar.split[value] ?? 0);
			if (count <= 0) continue;
			const barHeight = Math.max(1, count * scale);
			y -= barHeight;
			group.append(
				svg("rect", {
					x: left + index * slot + slot * 0.12,
					y,
					width: Math.max(1, slot * 0.76),
					height: barHeight,
					class: `graylog-fill ${value === null ? "total" : seriesKind(value, position)}`,
				}),
			);
		}
		group.append(
			svg("rect", {
				x: left + index * slot,
				y: top,
				width: slot,
				height: height - bottom - top,
				class: "graylog-hit",
			}),
		);
		canvas.append(group);
	});
	const ticks = el("div", { class: "graylog-axis-x" });
	const every = Math.max(1, Math.ceil(bars.length / 6));
	bars.forEach((bar, index) => {
		if (index % every === 0)
			ticks.append(
				el("span", {
					style: `left:${((left + index * slot + slot / 2) / width) * 100}%`,
					text: clock(bar.time, trend.step),
				}),
			);
	});
	const tip = el("div", { class: "graylog-tip", hidden: true });
	const selection = el("div", { class: "graylog-selection", hidden: true });
	const plot = el("div", { class: "graylog-plot" }, [canvas, labels, ticks, selection, tip]);
	const legend = trend.splitBy
		? el(
				"div",
				{ class: "graylog-legend" },
				series.map((value, position) =>
					el("span", { class: "graylog-legend-item" }, [
						el("span", { class: `graylog-swatch ${seriesKind(value, position)}` }),
						el("span", { text: seriesName(value) }),
					]),
				),
			)
		: null;
	chart.replaceChildren(...[plot, legend].filter(Boolean));

	const barAt = (clientX) => {
		const box = canvas.getBoundingClientRect();
		const x = ((clientX - box.left) / box.width) * width;
		return Math.min(bars.length - 1, Math.max(0, Math.floor((x - left) / slot)));
	};
	const xOf = (index) => {
		const box = canvas.getBoundingClientRect();
		return ((left + index * slot) / width) * box.width;
	};
	let dragFrom = null;
	plot.addEventListener("pointermove", (event) => {
		const index = barAt(event.clientX);
		const bar = bars[index];
		if (dragFrom !== null) {
			const [a, b] = [Math.min(dragFrom, index), Math.max(dragFrom, index)];
			selection.hidden = false;
			selection.style.left = `${xOf(a)}px`;
			selection.style.width = `${xOf(b + 1) - xOf(a)}px`;
		}
		tip.hidden = false;
		tip.replaceChildren(
			el("strong", {
				text: `${clock(bar.time, trend.step)} – ${clock(bar.time + trend.step * 1000, trend.step)}`,
			}),
			el("div", { text: t("{0} messages", bar.total) }),
			...(trend.splitBy
				? series
						.filter((value) => (bar.split[value] ?? 0) > 0)
						.map((value) =>
							el("div", { class: "graylog-tip-row" }, [
								el("span", { class: `graylog-swatch ${seriesKind(value, series.indexOf(value))}` }),
								el("span", { text: `${seriesName(value)}: ${bar.split[value]}` }),
							]),
						)
				: []),
		);
		const box = plot.getBoundingClientRect();
		const x = event.clientX - box.left;
		tip.style.left = `${Math.min(x + 12, box.width - tip.offsetWidth - 4)}px`;
	});
	plot.addEventListener("pointerleave", () => {
		tip.hidden = true;
	});
	plot.addEventListener("pointerdown", (event) => {
		dragFrom = barAt(event.clientX);
		plot.setPointerCapture(event.pointerId);
	});
	plot.addEventListener("pointerup", (event) => {
		if (dragFrom === null) return;
		const index = barAt(event.clientX);
		const [a, b] = [Math.min(dragFrom, index), Math.max(dragFrom, index)];
		dragFrom = null;
		selection.hidden = true;
		zoomTo(bars[a].time, bars[b].time + trend.step * 1000);
	});
}

function zoomTo(from, to) {
	zoom = { from, to };
	let option = range.querySelector('option[value="zoom"]');
	if (!option) {
		option = el("option", { value: "zoom" });
		range.append(option);
	}
	option.textContent = `${clock(from, 60)} – ${clock(to, 60)}`;
	range.value = "zoom";
	void run();
}

function niceMax(max) {
	const power = 10 ** Math.floor(Math.log10(max));
	return (
		[1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((each) => each * power).find((each) => each >= max) ??
		max
	);
}

function formatCount(value) {
	return value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(Math.round(value));
}

app.append(
	form,
	savedBar,
	summary,
	el("div", { class: "k-scroll k-grow graylog-body" }, [trendBox, results]),
);
trendBox.hidden = true;
kalem.call("prefs").then((prefs) => {
	saved = Array.isArray(prefs.saved) ? prefs.saved : [];
	columns = Array.isArray(prefs.columns) ? prefs.columns : null;
	splitBy = typeof prefs.splitBy === "string" ? prefs.splitBy : "";
	trendOn = prefs.trend !== false;
	trendButton.setAttribute("aria-pressed", String(trendOn));
	drawSaved();
});
results.append(empty());
kalem.onSettingsChanged(connect);
void connect();
