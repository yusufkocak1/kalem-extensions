import { el, formatSize, highlightXml, icon, prettyXml, renderBody } from "./highlight.js";
import { translator } from "./i18n.js";
import { parseSoapImport } from "./import.js";

const kalem = window.kalem;
const t = translator(kalem.language);
const app = document.getElementById("app");

let wsdl = null;
let recent = [];
let envelopes = {};
let chosen = null;
let requestTab = "envelope";
let responseTab = "body";
let pretty = true;
let response = null;
let sending = false;
let extraHeaders = [];
const auth = { username: "", password: "" };
let filter = "";

const IMPORTED = "kalem:imported";
const keyOf = (selection) =>
	`${wsdl?.url}#${selection.port.name}#${selection.operation.id ?? selection.operation.name}`;
const nameOf = (item) => (item.url === IMPORTED ? t("Imported requests") : item.name);
const serviceName = (service) => (wsdl?.url === IMPORTED ? t("Imported") : service.name);

/** Picks an operation; an imported one brings its own headers and Basic auth. */
function select(selection) {
	chosen = selection;
	response = null;
	const { operation } = selection;
	if (operation.id !== undefined) {
		extraHeaders = Object.entries(operation.headers ?? {}).map(([key, value]) => ({
			key,
			value,
			on: true,
		}));
		auth.username = operation.username ?? "";
		auth.password = operation.password ?? "";
	}
}
const statusKind = (status) =>
	status < 300 ? "ok" : status < 400 ? "info" : status < 500 ? "warn" : "error";

// --- Sidebar ---------------------------------------------------------------------------

const wsdlInput = el("input", {
	class: "k-input k-mono",
	placeholder: "https://…/Service?wsdl",
	spellcheck: "false",
	"aria-label": t("WSDL address"),
});
wsdlInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter") void load(wsdlInput.value);
});
const loadButton = el(
	"button",
	{
		class: "k-button primary",
		onclick: () => void load(wsdlInput.value, wsdl?.url === wsdlInput.value.trim()),
	},
	[document.createTextNode(t("Load"))],
);
const tree = el("div", { class: "soap-tree" });
const sideNotice = el("div", { class: "soap-side-notice", hidden: true });
const opFilter = el("input", {
	class: "k-input",
	type: "search",
	placeholder: t("Filter"),
	"aria-label": t("Filter"),
});
opFilter.addEventListener("input", () => {
	filter = opFilter.value.trim().toLocaleLowerCase(kalem.language);
	drawTree();
});

async function load(url, force = false) {
	sideNotice.hidden = true;
	loadButton.disabled = true;
	loadButton.replaceChildren(el("span", { class: "k-spinner" }));
	try {
		show(await kalem.call("load", { url, force }));
		recent = await kalem.call("recent");
		draw();
	} catch (error) {
		sideNotice.replaceChildren(
			el("div", { class: "k-notice error" }, [icon("alert"), el("span", { text: error.message })]),
		);
		sideNotice.hidden = false;
	} finally {
		loadButton.disabled = false;
		loadButton.replaceChildren(document.createTextNode(t("Load")));
	}
}

function show(next, pick = null) {
	wsdl = next;
	wsdlInput.value = wsdl.url === IMPORTED || wsdl.url.startsWith("text:") ? "" : wsdl.url;
	chosen = null;
	response = null;
	for (const service of wsdl.services)
		for (const port of service.ports)
			for (const operation of port.operations)
				if (chosen === null && (pick === null || pick(operation)))
					select({ service, port, operation });
}

function drawTree() {
	if (wsdl === null) {
		tree.replaceChildren(
			el("div", { class: "k-empty soap-side-empty" }, [
				el("span", { class: "k-empty-icon" }, [icon("file")]),
				el("strong", { text: t("Load a WSDL") }),
				el("p", {
					text: t(
						"Its services and operations show here, each with a sample request made from its schema.",
					),
				}),
			]),
			...(recent.length === 0
				? []
				: [
						el("p", { class: "k-section-title soap-recent-title", text: t("Recent") }),
						el(
							"ul",
							{ class: "k-list" },
							recent.map((item) =>
								el(
									"li",
									{ class: "k-list-item", title: item.url, onclick: () => void load(item.url) },
									[
										icon(
											item.url === IMPORTED
												? "download"
												: item.url.startsWith("text:")
													? "file"
													: "history",
										),
										el("span", { class: "k-name", text: nameOf(item) }),
										el("span", { class: "k-actions" }, [
											el(
												"button",
												{
													class: "k-button ghost icon small",
													title: t("Forget"),
													"aria-label": t("Forget"),
													onclick: async (event) => {
														event.stopPropagation();
														recent = await kalem.call("forget", item.url);
														drawTree();
													},
												},
												[icon("close")],
											),
										]),
									],
								),
							),
						),
					]),
		);
		return;
	}
	const groups = [];
	for (const service of wsdl.services) {
		for (const port of service.ports) {
			const operations = port.operations.filter(
				(operation) =>
					filter === "" || operation.name.toLocaleLowerCase(kalem.language).includes(filter),
			);
			groups.push(
				el("section", { class: "soap-port" }, [
					el("header", { class: "soap-port-head", title: port.endpoint }, [
						el("span", { class: "soap-port-name", text: `${serviceName(service)} › ${port.name}` }),
						el("span", {
							class: `k-badge ${port.version === "1.2" ? "info" : ""}`,
							text: `SOAP ${port.version}`,
						}),
					]),
					el(
						"ul",
						{ class: "k-list soap-ops" },
						operations.map((operation) =>
							el(
								"li",
								{
									class: "k-list-item",
									"aria-selected": String(chosen?.operation === operation),
									"data-operation": operation.name,
									title: operation.documentation || operation.action,
									onclick: () => {
										select({ service, port, operation });
										draw();
									},
								},
								[
									el("span", { class: "soap-op-icon", text: "ƒ" }),
									el("span", { class: "k-name", text: operation.name }),
									...(operation.id === undefined
										? []
										: [
												el("span", { class: "k-actions" }, [
													el(
														"button",
														{
															class: "k-button ghost icon small",
															title: t("Delete"),
															"aria-label": t("Delete"),
															onclick: async (event) => {
																event.stopPropagation();
																const keptId = chosen?.operation.id;
																show(
																	await kalem.call("forgetImported", operation.id),
																	(each) => each.id === keptId,
																);
																if (wsdl.services.length === 0) wsdl = null;
																else if (chosen === null) show(wsdl);
																recent = await kalem.call("recent");
																draw();
															},
														},
														[icon("trash")],
													),
												]),
											]),
								],
							),
						),
					),
				]),
			);
		}
	}
	tree.replaceChildren(
		el("div", { class: "soap-wsdl-head" }, [
			el("strong", { text: nameOf(wsdl) }),
			el("span", {
				class: "k-muted k-small",
				text: `${wsdl.services.reduce((n, service) => n + service.ports.reduce((m, port) => m + port.operations.length, 0), 0)} ${t("operations")}`,
			}),
		]),
		el("div", { class: "k-search soap-filter" }, [icon("search"), opFilter]),
		...groups,
	);
}

// --- Request ---------------------------------------------------------------------------

const title = el("div", { class: "soap-title" });
const versionSelect = el("select", { class: "k-select soap-version", "aria-label": "SOAP" }, [
	el("option", { value: "1.1", text: "SOAP 1.1" }),
	el("option", { value: "1.2", text: "SOAP 1.2" }),
]);
const endpointInput = el("input", {
	class: "k-input k-mono",
	spellcheck: "false",
	placeholder: "https://…/Service",
	"aria-label": t("Endpoint"),
});
const sendButton = el(
	"button",
	{ class: "k-button primary soap-send", onclick: () => void send() },
	[icon("send"), document.createTextNode(t("Send"))],
);
const actionLine = el("div", { class: "soap-action k-mono" });
const resetButton = el(
	"button",
	{
		class: "k-button ghost small",
		onclick: () => {
			if (chosen === null) return;
			editor.value = chosen.operation.sample;
			void kalem.call("keepEnvelope", { key: keyOf(chosen), text: "" });
			delete envelopes[keyOf(chosen)];
			paint();
		},
	},
	[icon("refresh"), document.createTextNode(t("Reset to sample"))],
);
const formatButton = el(
	"button",
	{
		class: "k-button ghost small",
		onclick: () => {
			const formatted = prettyXml(editor.value);
			if (formatted !== null) {
				editor.value = formatted;
				keep();
				paint();
			}
		},
	},
	[icon("code"), document.createTextNode(t("Format"))],
);

const requestTabs = el("div", { class: "k-tabs", role: "tablist" });
for (const [id, label] of [
	["envelope", t("Envelope")],
	["headers", t("Headers")],
	["auth", t("Auth")],
]) {
	requestTabs.append(
		el(
			"button",
			{
				class: "k-tab",
				role: "tab",
				"data-tab": id,
				onclick: () => {
					requestTab = id;
					drawRequest();
				},
			},
			[document.createTextNode(label)],
		),
	);
}
const requestBody = el("div", { class: "soap-pane-body" });

/** The envelope, editable, with its colours drawn underneath. */
const editor = el("textarea", {
	class: "soap-editor-input",
	spellcheck: "false",
	"aria-label": t("Envelope"),
});
const shade = el("pre", { class: "k-code soap-editor-shade", "aria-hidden": "true" });
const editorBox = el("div", { class: "soap-editor" }, [shade, editor]);
const paint = () => {
	shade.replaceChildren(highlightXml(`${editor.value}\n`));
	shade.scrollTop = editor.scrollTop;
	shade.scrollLeft = editor.scrollLeft;
};
let keepTimer = 0;
const keep = () => {
	if (chosen === null) return;
	envelopes[keyOf(chosen)] = editor.value;
	clearTimeout(keepTimer);
	keepTimer = setTimeout(
		() => void kalem.call("keepEnvelope", { key: keyOf(chosen), text: editor.value }),
		400,
	);
};
editor.addEventListener("input", () => {
	paint();
	keep();
});
editor.addEventListener("scroll", () => {
	shade.scrollTop = editor.scrollTop;
	shade.scrollLeft = editor.scrollLeft;
});
editor.addEventListener("keydown", (event) => {
	if (event.key === "Tab") {
		event.preventDefault();
		const { selectionStart: start, selectionEnd: end } = editor;
		editor.setRangeText("   ", start, end, "end");
		paint();
		keep();
	}
	if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void send();
});

function kvEditor() {
	const grid = el("div", { class: "k-kv" }, [
		el("span"),
		el("span", { class: "k-kv-head", text: t("Key") }),
		el("span", { class: "k-kv-head", text: t("Value") }),
		el("span"),
	]);
	const rows = [...extraHeaders, { key: "", value: "", on: true, blank: true }];
	rows.forEach((row, index) => {
		const commit = () => {
			extraHeaders = rows
				.filter((each) => !each.blank || each.key !== "")
				.map(({ blank, ...rest }) => rest);
		};
		const check = el("input", { type: "checkbox" });
		check.checked = row.on;
		check.disabled = row.blank === true;
		check.addEventListener("change", () => {
			row.on = check.checked;
			commit();
		});
		const key = el("input", {
			class: "k-input",
			value: row.key,
			placeholder: "X-Correlation-Id",
			spellcheck: "false",
		});
		const value = el("input", {
			class: "k-input",
			value: row.value,
			placeholder: t("Value"),
			spellcheck: "false",
		});
		key.addEventListener("input", () => {
			const grew = row.blank && row.key === "";
			row.key = key.value;
			commit();
			if (grew) {
				drawRequest();
				requestBody.querySelectorAll(".k-kv .k-input")[index * 2]?.focus();
			}
		});
		value.addEventListener("input", () => {
			row.value = value.value;
			commit();
		});
		const remove = el(
			"button",
			{
				class: "k-button ghost icon small",
				"aria-label": t("Remove"),
				onclick: () => {
					rows.splice(index, 1);
					commit();
					drawRequest();
				},
			},
			[icon("close")],
		);
		remove.hidden = row.blank === true;
		grid.append(check, key, value, remove);
	});
	return grid;
}

function drawRequest() {
	for (const tab of requestTabs.children)
		tab.setAttribute("aria-selected", String(tab.dataset.tab === requestTab));
	if (requestTab === "envelope") {
		requestBody.replaceChildren(editorBox);
		paint();
	} else if (requestTab === "headers") {
		requestBody.replaceChildren(
			el("div", { class: "soap-pad" }, [
				el("p", { class: "k-section-title", text: t("Extra headers") }),
				kvEditor(),
			]),
		);
	} else {
		const user = el("input", { class: "k-input", value: auth.username, autocomplete: "off" });
		const pass = el("input", {
			class: "k-input",
			value: auth.password,
			type: "password",
			autocomplete: "new-password",
		});
		user.addEventListener("input", () => (auth.username = user.value));
		pass.addEventListener("input", () => (auth.password = pass.value));
		requestBody.replaceChildren(
			el("div", { class: "soap-pad soap-auth" }, [
				el("p", {
					class: "k-muted k-small",
					text: t("Basic authentication, sent with each call."),
				}),
				el("label", { class: "soap-field" }, [el("span", { text: t("Username") }), user]),
				el("label", { class: "soap-field" }, [el("span", { text: t("Password") }), pass]),
			]),
		);
	}
}

// --- Response --------------------------------------------------------------------------

const responseHead = el("div", { class: "soap-response-head" });
const responseTabs = el("div", { class: "k-tabs", role: "tablist" });
const responseBody = el("div", { class: "soap-pane-body k-scroll" });

async function copy(text, button) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		// Not allowed: nothing is copied.
	}
	const before = [...button.childNodes];
	button.replaceChildren(icon("check"), document.createTextNode(t("Copied")));
	setTimeout(() => button.replaceChildren(...before), 1200);
}

function drawResponse() {
	responseTabs.hidden = response === null || response.error !== undefined || sending;
	if (sending) {
		responseHead.replaceChildren(
			el("span", { class: "k-spinner" }),
			el("span", { class: "k-muted", text: t("Sending") }),
		);
		responseBody.replaceChildren();
		return;
	}
	if (response === null) {
		responseHead.replaceChildren(el("span", { class: "k-section-title", text: t("Response") }));
		responseBody.replaceChildren(
			el("div", { class: "k-empty" }, [
				el("span", { class: "k-empty-icon" }, [icon("send")]),
				el("strong", { text: t("Send the request") }),
				el("p", { text: t("The response shows here, with any SOAP fault.") }),
			]),
		);
		return;
	}
	if (response.error !== undefined) {
		responseHead.replaceChildren(el("span", { class: "k-badge error", text: t("Request failed") }));
		responseBody.replaceChildren(
			el("div", { class: "soap-pad" }, [
				el("div", { class: "k-notice error" }, [
					icon("alert"),
					el("span", { text: response.error }),
				]),
			]),
		);
		return;
	}
	const copyButton = el(
		"button",
		{ class: "k-button ghost small", onclick: () => void copy(response.body, copyButton) },
		[icon("copy"), document.createTextNode(t("Copy"))],
	);
	responseHead.replaceChildren(
		el("span", {
			class: `k-badge ${statusKind(response.status)} soap-status`,
			text: `${response.status} ${response.statusText}`.trim(),
		}),
		...(response.fault ? [el("span", { class: "k-badge error", text: t("SOAP fault") })] : []),
		el("span", { class: "soap-metric" }, [
			el("span", { class: "k-muted", text: "Time " }),
			el("strong", { text: `${response.time} ms` }),
		]),
		el("span", { class: "soap-metric" }, [
			el("span", { class: "k-muted", text: "Size " }),
			el("strong", { text: formatSize(response.size) }),
		]),
		el("span", { class: "k-spacer" }),
		el(
			"div",
			{ class: "k-segmented" },
			["pretty", "raw"].map((mode) =>
				el(
					"button",
					{
						type: "button",
						"aria-pressed": String((mode === "pretty") === pretty),
						onclick: () => {
							pretty = mode === "pretty";
							drawResponse();
						},
					},
					[document.createTextNode(t(mode === "pretty" ? "Pretty" : "Raw"))],
				),
			),
		),
		copyButton,
	);
	responseTabs.replaceChildren(
		...[
			["body", t("Body")],
			["headers", t("Headers")],
		].map(([id, label]) =>
			el(
				"button",
				{
					class: "k-tab",
					role: "tab",
					"aria-selected": String(responseTab === id),
					onclick: () => {
						responseTab = id;
						drawResponse();
					},
				},
				[document.createTextNode(label)],
			),
		),
	);
	if (responseTab === "headers") {
		const table = (rows) =>
			el("table", { class: "k-table" }, [
				el(
					"tbody",
					{},
					Object.entries(rows).map(([name, value]) =>
						el("tr", {}, [
							el("td", { class: "k-mono soap-header-name", text: name }),
							el("td", { class: "k-mono", text: value }),
						]),
					),
				),
			]);
		responseBody.replaceChildren(
			table(response.headers),
			el("p", { class: "k-section-title soap-sent-title", text: t("Sent headers") }),
			table(response.sentHeaders),
		);
		return;
	}
	const parts = [];
	if (response.fault) {
		parts.push(
			el("div", { class: "k-notice error soap-fault" }, [
				icon("alert"),
				el("div", {}, [
					el("strong", { text: response.fault.code || t("SOAP fault") }),
					el("div", { text: response.fault.message }),
				]),
			]),
		);
	}
	const pre = el("pre", { class: "k-code wrap soap-response" });
	if (pretty) renderBody(pre, response.body, "xml");
	else pre.textContent = response.body;
	parts.push(pre);
	responseBody.replaceChildren(...parts);
}

async function send() {
	if (sending || chosen === null) return;
	sending = true;
	sendButton.disabled = true;
	drawResponse();
	try {
		response = await kalem.call("call", {
			version: versionSelect.value,
			endpoint: endpointInput.value,
			action: chosen.operation.action,
			envelope: editor.value,
			headers: Object.fromEntries(
				extraHeaders.filter((row) => row.on && row.key !== "").map((row) => [row.key, row.value]),
			),
			username: auth.username,
			password: auth.password,
		});
	} catch (error) {
		response = { error: error.message };
	} finally {
		sending = false;
		sendButton.disabled = false;
		drawResponse();
	}
}

// --- Import ---------------------------------------------------------------------------

const FORMATS = {
	curl: "cURL",
	fetch: "fetch",
	powershell: "PowerShell",
	http: "HTTP",
	har: "HAR",
	wsdl: "WSDL",
	envelope: "SOAP envelope",
};

const importButton = el(
	"button",
	{
		class: "k-button icon",
		title: t("Import"),
		"aria-label": t("Import"),
		onclick: () => openImport(),
	},
	[icon("download")],
);
const dialog = el("dialog", { class: "soap-dialog" });

/** Finds the loaded WSDL's operation an imported call is for: by SOAPAction, else by name. */
function matchingOperation(call) {
	if (wsdl === null || wsdl.url === IMPORTED) return null;
	const all = wsdl.services.flatMap((service) =>
		service.ports.flatMap((port) =>
			port.operations.map((operation) => ({ service, port, operation })),
		),
	);
	const sameVersion = (each) => each.port.version === call.version;
	const byAction = all.filter(
		(each) => call.action !== "" && each.operation.action === call.action,
	);
	const byName = all.filter((each) => each.operation.name === call.name);
	return byAction.find(sameVersion) ?? byAction[0] ?? byName.find(sameVersion) ?? byName[0] ?? null;
}

async function useCalls(calls) {
	const match = calls.length === 1 ? matchingOperation(calls[0]) : null;
	if (match !== null) {
		const [call] = calls;
		select(match);
		const formatted = prettyXml(call.envelope) ?? call.envelope;
		envelopes[keyOf(match)] = formatted;
		void kalem.call("keepEnvelope", { key: keyOf(match), text: formatted });
		extraHeaders = Object.entries(call.headers).map(([key, value]) => ({ key, value, on: true }));
		auth.username = call.username;
		auth.password = call.password;
		draw();
		if (call.endpoint !== "") endpointInput.value = call.endpoint;
		return;
	}
	const tidy = calls.map((call) => ({
		...call,
		envelope: prettyXml(call.envelope) ?? call.envelope,
	}));
	const { workspace, ids } = await kalem.call("importCalls", { calls: tidy });
	show(workspace, (operation) => operation.id === ids[0]);
	recent = await kalem.call("recent");
	draw();
}

function openImport() {
	let browserHeaders = false;
	const input = el("textarea", {
		class: "k-textarea k-mono soap-import-input",
		spellcheck: "false",
		"aria-label": t("Text to import"),
		placeholder: `curl 'https://…/Service' -H 'SOAPAction: "…"' --data-raw '<soapenv:Envelope …>'`,
	});
	const preview = el("div", { class: "soap-import-preview k-scroll" });
	const openButton = el("button", { class: "k-button primary" });
	const fileInput = el("input", {
		type: "file",
		hidden: true,
		accept: ".wsdl,.xml,.har,.json,.txt,.sh",
		"aria-label": t("Choose a file"),
	});
	let fileName = "";
	const readFile = async (file) => {
		fileName = file.name.replace(/\.(wsdl|xml)$/i, "");
		input.value = await file.text();
		update();
	};
	fileInput.addEventListener("change", () => {
		if (fileInput.files?.[0]) void readFile(fileInput.files[0]);
	});
	input.addEventListener("dragover", (event) => event.preventDefault());
	input.addEventListener("drop", (event) => {
		const file = event.dataTransfer?.files?.[0];
		if (!file) return;
		event.preventDefault();
		void readFile(file);
	});
	const keepBox = el("input", { type: "checkbox" });
	keepBox.addEventListener("change", () => {
		browserHeaders = keepBox.checked;
		update();
	});
	const failure = el("div", { class: "k-notice error", hidden: true });

	let found = { format: null, calls: [] };
	function update() {
		found = parseSoapImport(input.value, { browserHeaders });
		failure.hidden = true;
		const count = found.calls.length;
		openButton.hidden = found.format !== "wsdl" && count === 0;
		const match = count === 1 ? matchingOperation(found.calls[0]) : null;
		openButton.replaceChildren(
			document.createTextNode(
				found.format === "wsdl"
					? t("Open the WSDL")
					: match !== null
						? t("Open in {name}").replace("{name}", match.operation.name)
						: count > 1
							? t("Add {n} requests").replace("{n}", String(count))
							: t("Open"),
			),
		);
		if (input.value.trim() === "") {
			preview.replaceChildren(
				el("p", {
					class: "k-muted k-small",
					text: t(
						"In the browser's DevTools, Network tab: right-click the call › Copy › Copy as cURL, then paste it here. A WSDL's text or a bare envelope works too.",
					),
				}),
			);
			return;
		}
		if (found.format === "wsdl") {
			preview.replaceChildren(
				el("div", { class: "soap-import-found" }, [
					el("span", { class: "k-badge ok", text: "WSDL" }),
					el("span", {
						class: "k-muted k-small",
						text: t("Its services and operations open as if loaded from an address."),
					}),
				]),
			);
			return;
		}
		if (count === 0) {
			preview.replaceChildren(
				el("div", { class: "k-notice warn" }, [
					icon("alert"),
					el("span", {
						text:
							found.error === "none-soap"
								? t("No SOAP call here: the requests found carry no SOAP envelope.")
								: (found.error ?? t("This is not a SOAP call or a WSDL Kalem can read.")),
					}),
				]),
			);
			return;
		}
		preview.replaceChildren(
			el("div", { class: "soap-import-found" }, [
				el("span", { class: "k-badge ok", text: FORMATS[found.format] ?? found.format }),
				el("span", {
					class: "k-muted k-small",
					text:
						match !== null
							? t("Opens in the loaded WSDL's {name} operation.").replace(
									"{name}",
									match.operation.name,
								)
							: t("Kept under Imported requests."),
				}),
			]),
			el(
				"ul",
				{ class: "k-list soap-import-list" },
				found.calls.map((call) =>
					el("li", { class: "k-list-item", title: call.endpoint }, [
						el("span", { class: "soap-op-icon", text: "ƒ" }),
						el("span", { class: "k-name", text: call.name }),
						el("span", {
							class: "k-muted k-small soap-import-meta",
							text: [`SOAP ${call.version}`, call.endpoint || t("no endpoint")].join(" · "),
						}),
					]),
				),
			),
		);
	}
	input.addEventListener("input", update);
	openButton.addEventListener("click", async () => {
		openButton.disabled = true;
		try {
			if (found.format === "wsdl") {
				show(await kalem.call("loadText", { text: found.wsdl, name: fileName }));
				recent = await kalem.call("recent");
				draw();
			} else await useCalls(found.calls);
			dialog.close();
		} catch (error) {
			failure.replaceChildren(icon("alert"), el("span", { text: error.message }));
			failure.hidden = false;
		} finally {
			openButton.disabled = false;
		}
	});

	dialog.replaceChildren(
		el("header", { class: "soap-dialog-head" }, [
			el("strong", { text: t("Import") }),
			el("span", {
				class: "k-muted k-small",
				text: t(
					"cURL (bash or cmd), fetch, PowerShell, a raw HTTP request, HAR, a WSDL or an envelope.",
				),
			}),
		]),
		el("div", { class: "soap-import-body" }, [
			input,
			el("div", { class: "soap-import-options" }, [
				el("button", { class: "k-button small", onclick: () => fileInput.click() }, [
					icon("file"),
					document.createTextNode(t("Choose file…")),
				]),
				fileInput,
				el("label", { class: "soap-import-check" }, [
					keepBox,
					el("span", { text: t("Keep the browser's own headers (sec-*, user-agent…)") }),
				]),
			]),
			preview,
			failure,
		]),
		el("footer", { class: "soap-dialog-foot" }, [
			el("button", { class: "k-button ghost", onclick: () => dialog.close() }, [
				document.createTextNode(t("Cancel")),
			]),
			openButton,
		]),
	);
	update();
	if (!dialog.open) dialog.showModal();
	input.focus();
}

// --- The page --------------------------------------------------------------------------

const main = el("main", { class: "soap-main" });
const workspace = el("div", { class: "soap-workspace" }, [
	el("div", { class: "k-toolbar soap-toolbar" }, [
		title,
		el("span", { class: "k-spacer" }),
		formatButton,
		resetButton,
	]),
	el("div", { class: "soap-line" }, [
		el("div", { class: "k-group" }, [versionSelect, endpointInput, sendButton]),
		actionLine,
	]),
	el("div", { class: "k-split soap-split" }, [
		el("section", { class: "soap-pane" }, [requestTabs, requestBody]),
		el("section", { class: "soap-pane soap-response-pane" }, [
			responseHead,
			responseTabs,
			responseBody,
		]),
	]),
]);
const nothing = el("div", { class: "k-empty" }, [
	el("span", { class: "k-empty-icon" }, [icon("list")]),
	el("strong", { text: t("Pick an operation") }),
	el("p", { text: t("Its request opens here, ready to fill in and send.") }),
]);

function draw() {
	drawTree();
	if (chosen === null) {
		main.replaceChildren(nothing);
		return;
	}
	main.replaceChildren(workspace);
	title.replaceChildren(
		el("strong", { class: "soap-op-name", text: chosen.operation.name }),
		el("span", {
			class: "k-muted k-small",
			text: `${serviceName(chosen.service)} › ${chosen.port.name}`,
		}),
	);
	versionSelect.value = chosen.port.version;
	endpointInput.value = chosen.port.endpoint;
	actionLine.replaceChildren(
		el("span", { class: "k-muted", text: "SOAPAction " }),
		document.createTextNode(chosen.operation.action || "—"),
	);
	editor.value = envelopes[keyOf(chosen)] ?? chosen.operation.sample;
	drawRequest();
	drawResponse();
}

app.append(
	el("div", { class: "soap-layout" }, [
		el("aside", { class: "k-sidebar soap-side" }, [
			el("div", { class: "soap-load" }, [wsdlInput, loadButton, importButton]),
			sideNotice,
			el("div", { class: "k-scroll k-grow" }, [tree]),
		]),
		main,
	]),
	dialog,
);

[recent, envelopes] = await Promise.all([kalem.call("recent"), kalem.call("envelopes")]);
draw();
