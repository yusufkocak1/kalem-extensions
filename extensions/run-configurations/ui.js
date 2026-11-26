import { icon } from "./dom.js";
import { translator } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const kalem = window.kalem;
const t = translator(kalem.language);

const TYPE_MARKS = {
	command: "$",
	npm: "N",
	maven: "M",
	gradle: "G",
	application: "J",
	jar: "J",
	tomcat: "T",
	compound: "⧉",
};

const view = {
	selected: $("selected"),
	run: $("run"),
	stop: $("stop"),
	edit: $("edit"),
	clear: $("clear"),
	message: $("message"),
	console: $("console"),
	tabs: $("tabs"),
	output: $("output"),
	editor: $("editor"),
	add: $("add"),
	copy: $("copy"),
	remove: $("remove"),
	configs: $("configs"),
	form: $("form"),
	problems: $("problems"),
	cancel: $("cancel"),
	save: $("save"),
};

let state = { folder: null, configurations: [], selected: null, types: {}, sessions: [] };
let current = null;
const outputs = new Map();
let draft = null;
let draftIndex = 0;

const el = (tag, props = {}, children = []) => {
	const element = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === "class") element.className = value;
		else if (key === "text") element.textContent = value;
		else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
		else if (value !== undefined && value !== null && value !== false)
			element.setAttribute(key, value === true ? "" : value);
	}
	element.append(...children);
	return element;
};

const say = (text, error = false) => {
	view.message.textContent = text;
	view.message.classList.toggle("error", error);
};

const attempt = async (work) => {
	try {
		say("");
		return await work();
	} catch (error) {
		say(error.message, true);
		return undefined;
	}
};

// --- Output, with the colours of ANSI escapes ----------------------------------------

const ESC = String.fromCharCode(27);
const SGR_SPLIT = new RegExp(`(${ESC}\\[[0-9;]*m)`);
const SGR = new RegExp(`^${ESC}\\[([0-9;]*)m$`);
const OTHER_ESCAPES = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

const COLORS = ["#555", "#c33", "#2a8a2a", "#b58900", "#2f6fd0", "#a3a", "#1a9a9a", "#888"];
const BRIGHT = ["#777", "#e55", "#3c3", "#d9a400", "#59f", "#c6c", "#2bb", "#aaa"];
let style = { color: null, bold: false };

/** Programs write their logs to stderr too (Tomcat does): only errors are red there. */
function levelOf(line) {
	if (/\b(?:SEVERE|ERROR|FATAL)\b|Exception\b|^\s+at |^Caused by:|\bnpm ERR!/.test(line))
		return "stderr";
	if (/\bWARN(?:ING)?\b/.test(line)) return "warning";
	return "plain";
}

function appendText(target, stream, text) {
	const parts = text.split(SGR_SPLIT);
	for (const part of parts) {
		const sgr = SGR.exec(part);
		if (sgr !== null) {
			for (const code of (sgr[1] || "0").split(";").map(Number)) {
				if (code === 0) style = { color: null, bold: false };
				else if (code === 1) style.bold = true;
				else if (code === 22) style.bold = false;
				else if (code === 39) style.color = null;
				else if (code >= 30 && code <= 37) style.color = COLORS[code - 30];
				else if (code >= 90 && code <= 97) style.color = BRIGHT[code - 90];
			}
			continue;
		}
		const clean = part.replace(OTHER_ESCAPES, "").replace(/\r(?!\n)/g, "");
		if (clean === "") continue;
		const pieces = stream === "stderr" ? clean.split(/(?<=\n)/) : [clean];
		for (const piece of pieces) {
			const kind = stream === "stderr" ? levelOf(piece) : stream;
			const span = el("span", {
				class: [kind, style.bold ? "bold" : ""].join(" ").trim(),
				text: piece,
			});
			if (style.color !== null && kind !== "stderr") span.style.color = style.color;
			target.append(span);
		}
	}
}

function showOutput() {
	const chunks = current === null ? [] : (outputs.get(current) ?? []);
	view.output.replaceChildren();
	style = { color: null, bold: false };
	if (current === null) {
		view.output.append(
			el("span", {
				class: "empty",
				text:
					state.configurations.length === 0
						? t("No run configurations yet: Edit Configurations… adds one.")
						: t("Run a configuration: its output shows here."),
			}),
		);
		return;
	}
	for (const chunk of chunks) appendText(view.output, chunk.stream, chunk.text);
	view.output.scrollTop = view.output.scrollHeight;
}

async function choose(id) {
	current = id;
	if (id !== null && !outputs.has(id)) outputs.set(id, (await kalem.call("output", id)) ?? []);
	renderTabs();
	showOutput();
	renderButtons();
}

function renderTabs() {
	view.tabs.replaceChildren(
		...state.sessions.map((session) =>
			el(
				"button",
				{
					class: "tab",
					type: "button",
					role: "tab",
					"aria-selected": String(session.id === current),
					"data-session": session.id,
					title:
						session.status === "running"
							? t("Running")
							: t("{0}, exit code {1}", t(session.status), session.code),
					onclick: () => void choose(session.id),
				},
				[
					el("span", { class: "dot", "data-status": session.status }),
					el("span", { text: session.name }),
					...(session.status === "running"
						? []
						: [
								el("span", {
									class: "close",
									role: "button",
									title: t("Close"),
									text: "×",
									onclick: (event) => {
										event.stopPropagation();
										void forget(session.id);
									},
								}),
							]),
				],
			),
		),
	);
}

async function forget(id) {
	await kalem.call("forget", id);
	state.sessions = state.sessions.filter((each) => each.id !== id);
	outputs.delete(id);
	if (current === id) current = state.sessions.at(-1)?.id ?? null;
	renderTabs();
	showOutput();
}

function renderButtons() {
	const name = view.selected.value;
	const busy = state.sessions.some((each) => each.name === name && each.status === "running");
	view.run.disabled = name === "";
	view.run.replaceChildren(
		icon(busy ? "refresh" : "play"),
		document.createTextNode(busy ? t("Rerun") : t("Run")),
	);
	view.stop.disabled = !busy;
	view.edit.disabled = state.folder === null;
}

function renderSelect() {
	view.selected.replaceChildren(
		...state.configurations.map((config) =>
			el("option", {
				value: config.name,
				text: `${config.name} — ${t(state.types[config.type]?.title ?? config.type)}`,
			}),
		),
	);
	if (state.selected !== null) view.selected.value = state.selected;
	view.selected.disabled = state.configurations.length === 0;
	if (state.folder === null)
		say(
			t(
				"Open a folder (File › Open Folder): its run configurations are kept in it, in .kalem/run.json.",
			),
		);
	renderButtons();
}

async function refresh() {
	const next = await attempt(() => kalem.call("state"));
	if (next === undefined) return;
	state = next;
	renderSelect();
	renderTabs();
	if (current === null && state.sessions.length > 0) await choose(state.sessions.at(-1).id);
	else showOutput();
}

kalem.onMessage((message) => {
	if (message.type === "session") {
		const at = state.sessions.findIndex((each) => each.id === message.session.id);
		if (at === -1) {
			state.sessions.push(message.session);
			outputs.set(message.session.id, []);
			if (message.session.parent === null || current === null) current = message.session.id;
			renderTabs();
			showOutput();
		} else {
			state.sessions[at] = message.session;
			renderTabs();
		}
		renderButtons();
	} else if (message.type === "output") {
		const chunks = outputs.get(message.session);
		if (chunks === undefined) return;
		chunks.push({ stream: message.stream, text: message.text });
		if (message.session === current) {
			const atEnd =
				view.output.scrollHeight - view.output.scrollTop - view.output.clientHeight < 40;
			if (view.output.querySelector(".empty")) view.output.replaceChildren();
			appendText(view.output, message.stream, message.text);
			if (atEnd) view.output.scrollTop = view.output.scrollHeight;
		}
	} else if (message.type === "edit") {
		void openEditor();
	}
});

view.selected.addEventListener("change", () => {
	state.selected = view.selected.value;
	void kalem.call("select", view.selected.value);
	renderButtons();
});
view.run.addEventListener(
	"click",
	() => void attempt(() => kalem.call("run", view.selected.value)),
);
view.stop.addEventListener("click", () => {
	const session = state.sessions.find(
		(each) => each.name === view.selected.value && each.status === "running",
	);
	if (session !== undefined) void attempt(() => kalem.call("stop", session.id));
});
view.clear.addEventListener("click", () => {
	if (current !== null) outputs.set(current, []);
	showOutput();
});
view.edit.addEventListener("click", () => void openEditor());

// --- The configurations' editor --------------------------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value));

function uniqueName(base) {
	const names = new Set(draft.map((each) => each.name));
	if (!names.has(base)) return base;
	for (let i = 2; ; i++) if (!names.has(`${base} (${i})`)) return `${base} (${i})`;
}

function newConfig(type) {
	const config = { name: uniqueName(t(state.types[type].title)), type };
	for (const field of state.types[type].fields)
		if (field.default !== undefined) config[field.key] = field.default;
	return config;
}

async function openEditor() {
	await refresh();
	artifactCache = null;
	if (state.folder === null) return;
	draft = clone(state.configurations);
	draftIndex = Math.max(
		0,
		draft.findIndex((each) => each.name === view.selected.value),
	);
	view.add.replaceChildren(
		el("option", { value: "", text: t("+ Add…") }),
		...Object.entries(state.types).map(([id, type]) =>
			el("option", { value: id, text: t(type.title) }),
		),
	);
	view.problems.textContent = "";
	view.console.hidden = true;
	view.editor.hidden = false;
	view.clear.hidden = true;
	renderList();
	renderForm();
}

function closeEditor() {
	draft = null;
	view.editor.hidden = true;
	view.console.hidden = false;
	view.clear.hidden = false;
}

function renderList() {
	view.configs.replaceChildren(
		...draft.map((config, index) =>
			el(
				"li",
				{
					"data-selected": index === draftIndex,
					onclick: () => {
						draftIndex = index;
						renderList();
						renderForm();
					},
				},
				[
					el("span", {
						class: "type-badge",
						"data-type": config.type,
						text: TYPE_MARKS[config.type] ?? "?",
					}),
					el("span", { class: "config-text" }, [
						el("span", { class: "config-name", text: config.name || t("(no name)") }),
						el("small", { text: t(state.types[config.type]?.title ?? config.type) }),
					]),
				],
			),
		),
	);
	view.copy.disabled = view.remove.disabled = draft.length === 0;
}

function field(label, control, id) {
	return [el("label", { class: "title", for: id, text: label }), control];
}

let fieldCount = 0;

function renderForm() {
	view.form.replaceChildren();
	const config = draft[draftIndex];
	if (config === undefined) {
		view.form.append(el("p", { class: "empty", text: t("Add a configuration with + Add…") }));
		return;
	}
	const type = state.types[config.type];
	const set = (key, value) => {
		config[key] = value;
		if (key === "name") renderList();
	};

	const input = (key, attrs = {}) => {
		const id = `f${++fieldCount}`;
		const control = el("input", { id, name: key, type: "text", spellcheck: "false", ...attrs });
		control.value = config[key] ?? "";
		control.addEventListener("input", () =>
			set(key, attrs.type === "number" ? Number(control.value) : control.value),
		);
		return [id, control];
	};

	const [nameId, name] = input("name");
	view.form.append(...field(t("Name"), el("div", { class: "field" }, [name]), nameId));

	if (config.type === "tomcat") renderTomcat(config, set, input);
	else
		for (const spec of type.fields) {
			let id;
			let control;
			if (spec.kind === "checkbox") {
				[id, control] = input(spec.key, { type: "checkbox" });
				control.checked = config[spec.key] ?? spec.default ?? false;
				control.addEventListener("change", () => set(spec.key, control.checked));
				view.form.append(
					el("span"),
					el("label", { class: "field" }, [control, el("span", { text: t(spec.label) })]),
				);
				continue;
			}
			if (spec.kind === "textarea" || spec.kind === "env") {
				id = `f${++fieldCount}`;
				control = el("textarea", {
					id,
					name: spec.key,
					spellcheck: "false",
					placeholder: t(spec.placeholder ?? ""),
				});
				control.value = config[spec.key] ?? "";
				control.addEventListener("input", () => set(spec.key, control.value));
			} else if (spec.kind === "select") {
				id = `f${++fieldCount}`;
				control = el(
					"select",
					{ id, name: spec.key },
					spec.options.map((option) => el("option", { value: option, text: option })),
				);
				control.value = config[spec.key] ?? spec.default ?? spec.options[0];
				control.addEventListener("change", () => set(spec.key, control.value));
			} else if (spec.kind === "configurations") {
				id = `f${++fieldCount}`;
				control = checklist(config, spec.key, id);
			} else {
				[id, control] = input(spec.key, {
					type: spec.kind === "number" ? "number" : "text",
					placeholder: t(spec.placeholder ?? ""),
					...(spec.kind === "script" ? { list: `scripts-${fieldCount + 1}` } : {}),
				});
			}
			const children = [control];
			if (spec.kind === "folder" || spec.kind === "file") {
				children.push(
					el("button", {
						type: "button",
						text: "…",
						title: t("Browse"),
						onclick: async () => {
							const path = await attempt(() =>
								kalem.call("pick", { folder: spec.kind === "folder", title: t(spec.label) }),
							);
							if (path) {
								control.value = path;
								set(spec.key, path);
							}
						},
					}),
				);
			}
			if (spec.kind === "script") {
				const list = el("datalist", { id: control.getAttribute("list") });
				children.push(list);
				void kalem.call("scripts", { workingDir: config.workingDir }).then((scripts) => {
					list.replaceChildren(...scripts.map((script) => el("option", { value: script })));
				});
			}
			view.form.append(
				...field(
					t(spec.label) + (spec.required ? " *" : ""),
					el("div", { class: "field" }, children),
					id,
				),
			);
		}

	if (config.type !== "compound") {
		view.form.append(el("h3", { text: t("Before launch") }));
		const id = `f${++fieldCount}`;
		view.form.append(...field(t("Run first"), checklist(config, "beforeLaunch", id), id));
	}
}

// --- Tomcat, laid out as IntelliJ IDEA's Run/Debug Configurations dialog --------------

let tomcatTab = "server";
let deploySelected = 0;
let artifactCache = null;
const versions = new Map();

let lastScan = { artifacts: [], poms: [], roots: [] };

/** The web artifacts of the configuration's working directory and the open folders. */
async function artifacts(config, force = false) {
	if (artifactCache === null || force) {
		lastScan = (await attempt(() =>
			kalem.call("artifacts", { workingDir: config?.workingDir ?? "" }),
		)) ?? { artifacts: [], poms: [], roots: [] };
		artifactCache = lastScan.artifacts;
	}
	return artifactCache;
}

const contextOf = (artifact) =>
	`/${artifact.path
		.split("/")
		.pop()
		.replace(/\.war$/i, "")}`;

const deploymentOf = (artifact) => ({
	artifact: artifact.path,
	id: artifact.id,
	kind: artifact.kind,
	module: artifact.module,
	...(artifact.project ? { project: artifact.project } : {}),
	build: artifact.build,
	context: contextOf(artifact),
});

/** The artifact IntelliJ would fix "No artifacts marked for deployment" with: an exploded WAR first. */
const bestArtifact = (list) => list.find((each) => each.kind === "exploded") ?? list[0] ?? null;

function tomcatDeployments(config) {
	if (!Array.isArray(config.deployments)) {
		config.deployments =
			String(config.artifact ?? "").trim() === ""
				? []
				: [{ artifact: config.artifact, context: config.contextPath ?? "/" }];
		delete config.artifact;
		delete config.contextPath;
	}
	return config.deployments;
}

const deployIcon = (deployment) =>
	el("span", { class: `ij-artifact-icon ${deployment.kind ?? "external"}` }, [
		icon(deployment.kind === "exploded" ? "folder" : deployment.kind === "war" ? "globe" : "file"),
	]);

function ijRow(label, control, id) {
	return el("div", { class: "ij-row" }, [
		el("label", { class: "ij-label", for: id, text: label }),
		control,
	]);
}

function ijGroup(title, children) {
	return el("div", { class: "ij-group" }, [
		el("div", { class: "ij-group-title" }, [el("span", { text: title })]),
		el("div", { class: "ij-group-body" }, children),
	]);
}

function renderTomcat(config, set, input) {
	const deployments = tomcatDeployments(config);
	const urlPlaceholder = () => {
		const path = String(deployments[0]?.context ?? "/").replace(/^\/+|\/+$/g, "");
		return `http://localhost:${Number(config.httpPort) || 8080}/${path === "" ? "" : `${path}/`}`;
	};
	const tabs = el(
		"div",
		{ class: "ij-tabs", role: "tablist" },
		[
			["server", t("Server")],
			["deployment", t("Deployment")],
			["startup", t("Startup/Connection")],
		].map(([id, label]) =>
			el("button", {
				type: "button",
				role: "tab",
				class: "ij-tab",
				"data-tab": id,
				"aria-selected": String(tomcatTab === id),
				text: label,
				onclick: () => {
					tomcatTab = id;
					renderForm();
				},
			}),
		),
	);
	const panel = el("div", { class: "ij-panel", role: "tabpanel" });
	view.form.append(el("div", { class: "ij-wrap" }, [tabs, panel]));

	const browse = (control, key, folder, title) =>
		el(
			"button",
			{
				type: "button",
				class: "ij-browse",
				title: t("Browse"),
				"aria-label": `${t("Browse")}: ${title}`,
				onclick: async () => {
					const path = await attempt(() => kalem.call("pick", { folder, title }));
					if (path) {
						control.value = path;
						set(key, path);
						control.dispatchEvent(new Event("change"));
					}
				},
			},
			[icon("folder")],
		);

	if (tomcatTab === "server") {
		const [homeId, home] = input("tomcatHome", { placeholder: "C:/tools/apache-tomcat-11.0" });
		const version = el("span", { class: "ij-version" });
		const showVersion = async () => {
			const path = home.value.trim();
			if (path === "") {
				version.textContent = "";
				return;
			}
			if (!versions.has(path))
				versions.set(path, await kalem.call("tomcatVersion", { home: path }).catch(() => null));
			const found = versions.get(path);
			version.textContent = found ? `Tomcat ${found}` : t("Not a Tomcat folder");
			version.classList.toggle("bad", !found);
			const defaultName = t(state.types.tomcat.title);
			if (
				found &&
				(config.name === defaultName || /^Tomcat [\d.]+(-M\d+)?( \(\d+\))?$/.test(config.name))
			) {
				const before = config.name;
				config.name = "";
				config.name = uniqueName(`Tomcat ${found}`);
				if (config.name !== before && draft?.[draftIndex] === config) {
					const current = view.form.querySelector('input[name="name"]');
					if (current) current.value = config.name;
					renderList();
				}
			}
		};
		home.addEventListener("change", () => void showVersion());
		home.addEventListener("blur", () => void showVersion());
		void showVersion();
		const configure = el("button", {
			type: "button",
			class: "ij-button",
			text: t("Configure…"),
			onclick: () => browse(home, "tomcatHome", true, t("Tomcat folder")).click(),
		});
		const [openId, open] = input("openBrowser", { type: "checkbox" });
		open.checked = config.openBrowser ?? true;
		const [urlId, url] = input("url", { placeholder: urlPlaceholder(), class: "ij-mono" });
		url.disabled = !open.checked;
		open.addEventListener("change", () => {
			set("openBrowser", open.checked);
			url.disabled = !open.checked;
		});
		const [vmId, vm] = input("vmOptions", {
			placeholder: "-Xmx1g -Dspring.profiles.active=dev",
			class: "ij-mono",
		});
		const [jreId, jre] = input("javaHome", {
			placeholder: t("Default (JAVA_HOME, or java on the PATH)"),
		});
		const port = (key, placeholder = "") => {
			const [id, control] = input(key, { type: "number", min: "0", max: "65535", placeholder });
			if (config[key] === undefined || config[key] === 0) control.value = "";
			control.addEventListener("input", () => {
				if (control.value === "") delete config[key];
				url.placeholder = urlPlaceholder();
			});
			return [id, control];
		};
		const [httpId, http] = port("httpPort", "8080");
		const [ajpId, ajp] = port("ajpPort");
		const [jmxId, jmx] = port("jmxPort");
		panel.append(
			ijRow(
				t("Application server:"),
				el("div", { class: "ij-line" }, [
					el("div", { class: "ij-combo" }, [
						home,
						version,
						browse(home, "tomcatHome", true, t("Tomcat folder")),
					]),
					configure,
				]),
				homeId,
			),
			ijGroup(t("Open browser"), [
				el("div", { class: "ij-line" }, [
					el("label", { class: "ij-check", for: openId }, [
						open,
						el("span", { text: t("After launch") }),
					]),
				]),
				ijRow(t("URL:"), url, urlId),
			]),
			ijRow(t("VM options:"), vm, vmId),
			ijRow(
				t("JRE:"),
				el("div", { class: "ij-combo" }, [jre, browse(jre, "javaHome", true, t("JRE"))]),
				jreId,
			),
			ijGroup(t("Tomcat Server Settings"), [
				el("div", { class: "ij-ports" }, [
					ijRow(t("HTTP port:"), http, httpId),
					ijRow(t("AJP port:"), ajp, ajpId),
					ijRow(t("JMX port:"), jmx, jmxId),
				]),
			]),
		);
		if (deployments.length === 0) {
			panel.append(
				el("div", { class: "ij-warning" }, [
					icon("alert"),
					el("span", { text: t("Warning: No artifacts marked for deployment") }),
					el("button", {
						type: "button",
						class: "ij-button ij-fix",
						text: t("Fix"),
						onclick: async () => {
							const best = bestArtifact(await artifacts(config, true));
							if (best !== null) deployments.push(deploymentOf(best));
							tomcatTab = "deployment";
							deploySelected = 0;
							renderForm();
							if (best === null)
								say(
									t("No WAR artifact was found in the folder: add one as an external source."),
									true,
								);
						},
					}),
				]),
			);
		}
	} else if (tomcatTab === "deployment") {
		deploySelected = Math.max(0, Math.min(deploySelected, deployments.length - 1));
		const move = (by) => {
			const to = deploySelected + by;
			if (to < 0 || to >= deployments.length) return;
			[deployments[deploySelected], deployments[to]] = [
				deployments[to],
				deployments[deploySelected],
			];
			deploySelected = to;
			renderForm();
		};
		const menu = el("div", { class: "ij-menu", hidden: true }, [
			el("button", {
				type: "button",
				text: t("Artifact…"),
				onclick: () => {
					menu.hidden = true;
					void pickArtifacts(config);
				},
			}),
			el("button", {
				type: "button",
				text: t("External Source…"),
				onclick: async () => {
					menu.hidden = true;
					const path = await attempt(() =>
						kalem.call("pick", { folder: false, title: t("A WAR file") }),
					);
					if (!path) return;
					deployments.push({
						artifact: path,
						context: `/${path
							.split(/[\\/]/)
							.pop()
							.replace(/\.war$/i, "")}`,
					});
					deploySelected = deployments.length - 1;
					renderForm();
				},
			}),
			el("button", {
				type: "button",
				text: t("External Folder (exploded)…"),
				onclick: async () => {
					menu.hidden = true;
					const path = await attempt(() =>
						kalem.call("pick", { folder: true, title: t("An exploded web application") }),
					);
					if (!path) return;
					deployments.push({
						artifact: path,
						kind: "exploded",
						context: `/${path.split(/[\\/]/).pop()}`,
					});
					deploySelected = deployments.length - 1;
					renderForm();
				},
			}),
		]);
		const tool = (mark, label, onclick, disabled = false) =>
			el(
				"button",
				{
					type: "button",
					class: `ij-tool ${mark}`,
					title: label,
					"aria-label": label,
					disabled,
					onclick,
				},
				[icon(mark)],
			);
		const toolbar = el("div", { class: "ij-toolbar" }, [
			tool("plus", t("Add"), (event) => {
				event.stopPropagation();
				menu.hidden = !menu.hidden;
				if (!menu.hidden)
					setTimeout(() =>
						document.addEventListener("click", () => (menu.hidden = true), { once: true }),
					);
			}),
			tool(
				"minus",
				t("Remove"),
				() => {
					deployments.splice(deploySelected, 1);
					renderForm();
				},
				deployments.length === 0,
			),
			tool("up", t("Move up"), () => move(-1), deploySelected === 0),
			tool("down", t("Move down"), () => move(1), deploySelected >= deployments.length - 1),
			menu,
		]);
		const list = el(
			"ul",
			{ class: "ij-list", role: "listbox", "aria-label": t("Deploy at the server startup") },
			deployments.length === 0
				? [el("li", { class: "ij-empty", text: t("Nothing to deploy") })]
				: deployments.map((deployment, index) =>
						el(
							"li",
							{
								role: "option",
								"aria-selected": String(index === deploySelected),
								title: deployment.artifact,
								onclick: () => {
									deploySelected = index;
									renderForm();
								},
							},
							[deployIcon(deployment), el("span", { text: deployment.id ?? deployment.artifact })],
						),
					),
		);
		const chosen = deployments[deploySelected];
		const contextId = `f${++fieldCount}`;
		const context = el("input", {
			id: contextId,
			type: "text",
			spellcheck: "false",
			placeholder: "/",
			disabled: chosen === undefined,
		});
		context.value = chosen?.context ?? "";
		context.addEventListener("input", () => {
			if (chosen) chosen.context = context.value;
		});
		const [buildId, build] = input("buildArtifacts", { type: "checkbox" });
		build.checked = config.buildArtifacts ?? true;
		build.addEventListener("change", () => set("buildArtifacts", build.checked));
		panel.append(
			ijGroup(t("Deploy at the server startup"), [toolbar, list]),
			ijRow(t("Application context:"), context, contextId),
			el("label", { class: "ij-check", for: buildId }, [
				build,
				el("span", { text: t("Build the artifacts before launch (Maven package / Gradle war)") }),
			]),
		);
	} else {
		const [dirId, dir] = input("workingDir", { placeholder: t("The open folder") });
		dir.addEventListener("change", async () => {
			artifactCache = null;
			if (deployments.length > 0) return;
			const best = bestArtifact(await artifacts(config, true));
			if (best === null || deployments.length > 0) return;
			deployments.push(deploymentOf(best));
			if (draft?.[draftIndex] === config && tomcatTab !== "startup") renderForm();
		});
		const envId = `f${++fieldCount}`;
		const env = el("textarea", {
			id: envId,
			spellcheck: "false",
			placeholder: t("NAME=value, one per line"),
		});
		env.value = config.env ?? "";
		env.addEventListener("input", () => set("env", env.value));
		panel.append(
			ijRow(
				t("Working directory:"),
				el("div", { class: "ij-combo" }, [
					dir,
					browse(dir, "workingDir", true, t("Working directory")),
				]),
				dirId,
			),
			ijRow(t("Environment variables:"), env, envId),
		);
	}
}

const artifactDialog = el("dialog", { class: "ij-dialog" });
document.body.append(artifactDialog);

async function pickArtifacts(config) {
	const deployments = tomcatDeployments(config);
	const picked = new Set();
	const draw = (list) => {
		const free = list.filter(
			(each) => !deployments.some((deployment) => deployment.artifact === each.path),
		);
		const items = el(
			"ul",
			{ class: "ij-list ij-pick", role: "listbox", "aria-multiselectable": "true" },
			free.length === 0
				? [
						list.length === 0
							? el("li", { class: "ij-empty ij-scan" }, [
									el("strong", {
										text: t(
											"No WAR artifact was found (a Maven module with <packaging>war</packaging>, a Gradle build with the war plugin, an IntelliJ artifact in .idea/artifacts, or a built .war or exploded folder).",
										),
									}),
									el("span", {
										text: `${t("Looked in:")} ${lastScan.roots.join(", ") || t("no open folder")}`,
									}),
									el("span", {
										text:
											lastScan.poms.length === 0
												? t(
														"No pom.xml was found there. Set the project folder as the Working directory (Startup/Connection).",
													)
												: `${t("Maven projects seen:")} ${lastScan.poms
														.slice(0, 12)
														.map((pom) => `${pom.artifactId || pom.path} (${pom.packaging})`)
														.join(", ")}${lastScan.poms.length > 12 ? "…" : ""}`,
									}),
								])
							: el("li", { class: "ij-empty", text: t("All of them are deployed already.") }),
					]
				: free.map((artifact) =>
						el(
							"li",
							{
								role: "option",
								"data-artifact": artifact.id,
								"aria-selected": String(picked.has(artifact)),
								title: artifact.path,
								onclick: (event) => {
									if (!(event.ctrlKey || event.metaKey || event.shiftKey)) picked.clear();
									if (picked.has(artifact)) picked.delete(artifact);
									else picked.add(artifact);
									draw(list);
								},
								ondblclick: () => {
									picked.clear();
									picked.add(artifact);
									ok();
								},
							},
							[
								deployIcon(artifact),
								el("span", { text: artifact.id }),
								...(artifact.built
									? []
									: [el("small", { class: "ij-unbuilt", text: t("not built yet") })]),
							],
						),
					),
		);
		const ok = () => {
			for (const artifact of free.filter((each) => picked.has(each)))
				deployments.push(deploymentOf(artifact));
			deploySelected = deployments.length - 1;
			artifactDialog.close();
			renderForm();
		};
		artifactDialog.replaceChildren(
			el("header", { class: "ij-dialog-head" }, [
				el("strong", { text: t("Select Artifacts to Deploy") }),
				el(
					"button",
					{
						type: "button",
						class: "ij-close",
						"aria-label": t("Close"),
						onclick: () => artifactDialog.close(),
					},
					[icon("close")],
				),
			]),
			el("p", {
				class: "ij-dialog-hint",
				text: t("Selected artifacts will be deployed at server startup"),
			}),
			items,
			el("footer", { class: "ij-dialog-foot" }, [
				el(
					"button",
					{
						type: "button",
						class: "ij-button ij-refresh",
						onclick: async () => draw(await artifacts(config, true)),
					},
					[icon("refresh"), document.createTextNode(t("Refresh"))],
				),
				el("span", { class: "spacer" }),
				el("button", {
					type: "button",
					class: "k-button primary",
					text: t("OK"),
					disabled: picked.size === 0,
					onclick: ok,
				}),
				el("button", {
					type: "button",
					class: "k-button ghost",
					text: t("Cancel"),
					onclick: () => artifactDialog.close(),
				}),
			]),
		);
	};
	draw(artifactCache ?? []);
	if (!artifactDialog.open) artifactDialog.showModal();
	draw(await artifacts(config, true));
}

function checklist(config, key, id) {
	const others = draft.filter((each) => each !== config);
	if (others.length === 0)
		return el("span", { id, class: "empty", text: t("No other configurations.") });
	const chosen = new Set(config[key] ?? []);
	return el(
		"div",
		{ id, class: "checks" },
		others.map((other) => {
			const box = el("input", { type: "checkbox", value: other.name });
			box.checked = chosen.has(other.name);
			box.addEventListener("change", () => {
				const names = new Set(config[key] ?? []);
				if (box.checked) names.add(other.name);
				else names.delete(other.name);
				config[key] = others.map((each) => each.name).filter((name) => names.has(name));
			});
			return el("label", {}, [box, el("span", { text: ` ${other.name}` })]);
		}),
	);
}

view.add.addEventListener("change", () => {
	if (view.add.value === "") return;
	const added = newConfig(view.add.value);
	if (added.type === "tomcat") {
		added.deployments = [];
		tomcatTab = "server";
		void artifacts(added, true).then((list) => {
			const best = bestArtifact(list);
			if (best === null || added.deployments.length > 0) return;
			added.deployments.push(deploymentOf(best));
			if (draft?.[draftIndex] === added) renderForm();
		});
	}
	draft.push(added);
	draftIndex = draft.length - 1;
	view.add.value = "";
	renderList();
	renderForm();
	view.form.querySelector("input")?.select();
});
view.copy.addEventListener("click", () => {
	const source = draft[draftIndex];
	if (source === undefined) return;
	draft.push({ ...clone(source), name: uniqueName(source.name) });
	draftIndex = draft.length - 1;
	renderList();
	renderForm();
});
view.remove.addEventListener("click", () => {
	const removed = draft.splice(draftIndex, 1)[0];
	if (removed !== undefined) {
		for (const config of draft) {
			for (const key of ["beforeLaunch", "configurations"]) {
				if (Array.isArray(config[key]))
					config[key] = config[key].filter((name) => name !== removed.name);
			}
		}
	}
	draftIndex = Math.max(0, Math.min(draftIndex, draft.length - 1));
	renderList();
	renderForm();
});
view.cancel.addEventListener("click", closeEditor);
view.save.addEventListener("click", async () => {
	view.problems.textContent = "";
	try {
		state = await kalem.call("save", {
			configurations: draft,
			selected: draft[draftIndex]?.name ?? null,
		});
		closeEditor();
		renderSelect();
		showOutput();
	} catch (error) {
		view.problems.textContent = error.message;
	}
});

kalem.onSettingsChanged(() => void refresh());
void refresh();
window.addEventListener("focus", () => {
	if (draft === null) void refresh();
});

for (const [id, text, mark] of [
	["run", "Run", "play"],
	["stop", "Stop", "stop"],
	["edit", "Edit Configurations…", "settings"],
	["clear", "Clear", "trash"],
	["copy", "Copy", "copy"],
	["remove", "Remove", "trash"],
	["cancel", "Cancel", null],
	["save", "Save", "check"],
]) {
	$(id).replaceChildren(...(mark === null ? [] : [icon(mark)]), document.createTextNode(t(text)));
}
$("clear").title = t("Clear the output");
$("selected").setAttribute("aria-label", t("Configuration"));
