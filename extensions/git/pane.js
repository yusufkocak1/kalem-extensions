/** The Git tool window: Local Changes, Shelf, Stash, Log and Console, as in IntelliJ IDEA. */
import { el, fill, icon } from "./dom.js";
import { graphRows } from "./parse.js";
import {
	closeMenu,
	dateTime,
	dialog,
	errorText,
	KIND_LETTER,
	menuAt,
	menuBelow,
	notice,
	relativeTime,
	showMenu,
	splitPath,
} from "./widgets.js";

const TABS = ["changes", "shelf", "stash", "log", "console"];
const PAGE = 200;
const LANE = 12;
const ROW = 24;
const COLORS = ["#2f80ed", "#27ae60", "#eb5757", "#9b51e0", "#f2994a", "#00a3a3", "#d6336c", "#828282"];

const stored = (key, fallback) => {
	try {
		const value = localStorage.getItem(`kalem.git.${key}`);
		return value === null ? fallback : JSON.parse(value);
	} catch {
		return fallback;
	}
};
const store = (key, value) => {
	try {
		localStorage.setItem(`kalem.git.${key}`, JSON.stringify(value));
	} catch {}
};

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const area = el("textarea", { class: "g-offscreen" });
		area.value = text;
		document.body.append(area);
		area.select();
		document.execCommand("copy");
		area.remove();
	}
}

export function startPane(kalem, t, app) {
	const call = (name, input = {}) => kalem.call(name, input);

	let repos = [];
	let plainFolders = [];
	let settings = {};
	let root = stored("root", null);
	let state = null;
	let tab = stored("tab", "changes");
	let busy = null;
	let consoleEntries = [];

	// Local Changes
	const selected = new Set();
	let anchor = null;
	const checked = new Set();
	const known = new Set();
	const collapsed = new Set(stored("collapsed", []));
	let amend = false;

	// Log
	let log = { commits: [], rows: [], graph: { lanes: [] }, done: false, loading: false, key: "" };
	let logFilter = { text: "", author: "", branch: "HEAD", path: "" };
	const logSelected = new Set();
	let logAnchor = null;
	let detail = null;
	let branchesCache = null;

	// Shelf and stash
	let shelves = [];
	let shelfSelected = null;
	let stashes = [];
	let stashSelected = null;
	let stashFiles = [];

	app.classList.add("gp");
	const header = el("div", { class: "k-toolbar gp-head" });
	const banner = el("div", { class: "gp-banner", hidden: true });
	const tabs = el("div", { class: "k-tabs gp-tabs", role: "tablist" });
	const content = el("div", { class: "gp-content" });
	fill(app, header, banner, tabs, content);

	const repo = () => repos.find((each) => each.root === root) ?? null;
	const message = () => stored(`message:${root}`, "");
	const setMessage = (text) => store(`message:${root}`, text);

	// --- Doing things ------------------------------------------------------------------------

	async function run(label, work, options = {}) {
		const { refresh = true, quiet = false } = options;
		if (busy !== null) {
			notice(t("Wait until {0} is done.", busy));
			return undefined;
		}
		busy = label;
		renderHeader();
		try {
			const value = await work();
			if (!quiet) notice(t("{0}: done.", label), "ok");
			return value;
		} catch (error) {
			const text = errorText(error);
			if (text.startsWith("diverged:")) {
				busy = null;
				return pullDiverged();
			}
			if (text.startsWith("overwritten:") && options.retry) {
				busy = null;
				const answer = await dialog({
					title: t("Smart Checkout"),
					text: t("Your local changes would be overwritten by the checkout. Smart Checkout stashes them, checks out and puts them back.\n\n{0}", text.slice(12).trim()),
					ok: t("Smart Checkout"),
					cancel: t("Cancel"),
				});
				if (answer !== null) return run(label, options.retry);
				return undefined;
			}
			notice(`${label}: ${text}`, "error");
			return undefined;
		} finally {
			busy = null;
			if (refresh) await refreshAll();
			else renderHeader();
		}
	}

	async function pullDiverged() {
		const answer = await dialog({
			title: t("The branches have diverged"),
			text: t("Your branch and its upstream have different commits. How should they be brought together?"),
			fields: [
				{
					key: "how",
					type: "select",
					label: t("Update with"),
					value: "rebase",
					options: [
						{ value: "rebase", label: t("Rebase (put your commits on top)") },
						{ value: "merge", label: t("Merge (a merge commit)") },
					],
				},
			],
			ok: t("Update"),
			cancel: t("Cancel"),
		});
		if (answer !== null) await run(t("Update Project"), () => call("pull", { root, how: answer.how }));
	}

	// --- Loading -------------------------------------------------------------------------------

	async function loadRepos() {
		const info = await call("state");
		repos = info.repos;
		plainFolders = info.plainFolders;
		settings = info.settings ?? {};
		consoleEntries = info.console ?? [];
		if (!repos.some((each) => each.root === root)) root = repos[0]?.root ?? null;
		store("root", root);
	}

	async function refreshStatus() {
		const current = repo();
		if (current === null || !current.trusted) {
			state = null;
			return;
		}
		try {
			const next = await call("status", { root });
			const headChanged = state?.head !== next.head || state?.branch !== next.branch;
			state = next;
			for (const file of state.files) {
				if (!known.has(file.path)) {
					known.add(file.path);
					if (file.kind !== "untracked" && file.kind !== "conflict") checked.add(file.path);
				}
			}
			const present = new Set(state.files.map((file) => file.path));
			for (const path of [...known]) if (!present.has(path)) known.delete(path);
			for (const path of [...checked]) if (!present.has(path)) checked.delete(path);
			for (const path of [...selected]) if (!present.has(path)) selected.delete(path);
			if (headChanged) {
				branchesCache = null;
				if (tab === "log") void reloadLog();
			}
		} catch (error) {
			state = null;
			notice(errorText(error), "error");
		}
	}

	async function refreshAll() {
		await loadRepos().catch((error) => notice(errorText(error), "error"));
		await refreshStatus();
		if (tab === "shelf") await loadShelves();
		if (tab === "stash") await loadStashes();
		if (tab === "log" && log.commits.length === 0) await reloadLog();
		render();
	}

	// --- Header ----------------------------------------------------------------------------------

	const tool = (iconName, title, onclick, extra = {}) =>
		el(
			"button",
			{ class: `k-button small ghost${extra.text ? "" : " icon"}`, type: "button", title, "aria-label": title, onclick, ...extra.attrs },
			[icon(iconName), extra.text ? el("span", { text: extra.text }) : null],
		);

	function renderHeader() {
		const current = repo();
		const picker =
			repos.length > 1
				? el(
						"select",
						{
							class: "k-select gp-repo",
							"aria-label": t("Repository"),
							onchange: async (event) => {
								root = event.target.value;
								store("root", root);
								resetRepoState();
								await refreshAll();
							},
						},
						repos.map((each) => el("option", { value: each.root, text: each.name, selected: each.root === root ? true : undefined })),
					)
				: current
					? el("span", { class: "gp-repo-name", text: current.name, title: current.root })
					: null;
		const branchName = state ? (state.branch ?? `${t("Detached")} ${state.head?.slice(0, 8) ?? ""}`) : "";
		const branchButton =
			state !== null
				? el(
						"button",
						{
							class: "k-button small ghost gp-branch",
							type: "button",
							title: t("Branches"),
							onclick: (event) => void branchPopup(event.currentTarget),
						},
						[icon("branch"), el("span", { text: branchName }), icon("down")],
					)
				: null;
		const counts = [];
		if (state?.ahead) counts.push(el("span", { class: "gp-count", title: t("{0} to push", state.ahead), text: `↑${state.ahead}` }));
		if (state?.behind) counts.push(el("span", { class: "gp-count", title: t("{0} to pull", state.behind), text: `↓${state.behind}` }));
		const enabled = state !== null && busy === null;
		fill(header, 
			icon("branch"),
			picker,
			branchButton,
			...counts,
			el("span", { class: "gp-sep" }),
			tool("pull", t("Update Project…"), () => void updateProject(), { attrs: { disabled: enabled ? undefined : true } }),
			tool("commit", t("Commit…"), () => switchTab("changes"), { attrs: { disabled: enabled ? undefined : true } }),
			tool("push", t("Push…"), () => void pushDialog(), { attrs: { disabled: enabled ? undefined : true } }),
			tool("refresh", t("Fetch"), () => void run(t("Fetch"), () => call("fetch", { root })), { attrs: { disabled: enabled ? undefined : true } }),
			busy !== null ? el("span", { class: "gp-busy" }, [el("span", { class: "k-spinner" }), el("span", { text: busy })]) : null,
			el("span", { class: "k-spacer" }),
			tool("more", t("More"), (event) => menuBelow(event.currentTarget, moreMenu())),
		);
		renderBanner();
	}

	function moreMenu() {
		return [
			{ label: t("Clone Repository…"), icon: "download", run: () => void cloneDialog() },
			{ label: t("Add a Repository…"), icon: "folder", run: () => void addRepo() },
			...plainFolders.map((folder) => ({
				label: t("Create Git Repository in {0}", splitPath(folder.replace(/\\/g, "/")).name),
				run: () => void initRepo(folder),
			})),
			null,
			{ label: t("Refresh"), icon: "refresh", run: () => void refreshAll() },
			{ label: t("Stash Changes…"), icon: "stash", disabled: state === null, run: () => void stashDialog() },
			{ label: t("Apply a Patch…"), disabled: state === null, run: () => void run(t("Apply a Patch…"), () => call("applyPatch", { root })) },
			null,
			{
				label: t("Forget this repository"),
				disabled: repo() === null,
				run: async () => {
					await call("removeRepo", { root });
					await refreshAll();
				},
			},
		];
	}

	function renderBanner() {
		const current = repo();
		if (current !== null && !current.trusted) {
			banner.hidden = false;
			banner.className = "gp-banner warn";
			fill(banner, 
				el("span", { text: t("Git does not run in {0} until you trust it: a repository's own settings can run programs.", current.root) }),
				el("button", { class: "k-button small primary", type: "button", text: t("Trust…"), onclick: () => void trustRepo() }),
			);
			return;
		}
		if (state?.operation) {
			const conflicts = state.files.filter((file) => file.kind === "conflict").length;
			banner.hidden = false;
			banner.className = `gp-banner ${conflicts > 0 ? "error" : "warn"}`;
			fill(banner, 
				el("span", {
					text: `${t("{0} in progress", t(state.operation))}${conflicts > 0 ? ` · ${t("{0} conflicts", conflicts)}` : ""}`,
				}),
				el("button", {
					class: "k-button small primary",
					type: "button",
					text: t("Continue"),
					disabled: conflicts > 0 ? true : undefined,
					onclick: () => void run(t("Continue"), () => call("operation", { root, action: "continue" })),
				}),
				el("button", {
					class: "k-button small",
					type: "button",
					text: t("Abort"),
					onclick: () => void confirmThen(t("Abort the {0}?", t(state.operation)), t("Abort"), () => call("operation", { root, action: "abort" })),
				}),
			);
			return;
		}
		banner.hidden = true;
	}

	async function confirmThen(text, ok, work, { danger = true, label = ok } = {}) {
		const answer = await dialog({ title: label, text, ok, cancel: t("Cancel"), danger });
		if (answer !== null) return run(label, work);
		return undefined;
	}

	async function trustRepo() {
		const current = repo();
		const answer = await dialog({
			title: t("Trust this repository?"),
			text: t(
				"{0}\n\nA repository's own git settings (hooks, filters, fsmonitor) can run programs on this computer. Trust it only if you know where it came from.",
				current.root,
			),
			ok: t("Trust"),
			cancel: t("Cancel"),
			danger: true,
		});
		if (answer === null) return;
		await call("trust", { root: current.root });
		await refreshAll();
	}

	async function cloneDialog() {
		const answer = await dialog({
			title: t("Clone Repository"),
			fields: [{ key: "url", label: t("URL"), placeholder: "https://github.com/…/….git" }],
			ok: t("Clone…"),
			cancel: t("Cancel"),
			check: (values) => (values.url === "" ? t("Give the repository's address.") : null),
		});
		if (answer === null) return;
		const folder = await run(t("Clone"), () => call("clone", { url: answer.url }), { quiet: true });
		if (folder) {
			notice(t("Cloned into {0}.", folder), "ok");
			root = folder;
			store("root", root);
			await refreshAll();
		}
	}

	async function addRepo() {
		try {
			await call("addRepo");
			await refreshAll();
		} catch (error) {
			notice(errorText(error), "error");
		}
	}

	async function initRepo(folder) {
		await run(t("Create Git Repository"), () => call("init", { folder }));
		root = repos.find((each) => each.root.replace(/[\\/]+$/, "") === folder.replace(/[\\/]+$/, ""))?.root ?? root;
		await refreshAll();
	}

	function resetRepoState() {
		state = null;
		selected.clear();
		checked.clear();
		known.clear();
		log = { commits: [], rows: [], graph: { lanes: [] }, done: false, loading: false, key: "" };
		logSelected.clear();
		detail = null;
		branchesCache = null;
		shelves = [];
		stashes = [];
		stashFiles = [];
		amend = false;
	}

	// --- Update and push --------------------------------------------------------------------------

	async function updateProject() {
		const answer = await dialog({
			title: t("Update Project"),
			fields: [
				{
					key: "how",
					type: "select",
					label: t("Update type"),
					value: stored("pullHow", "merge"),
					options: [
						{ value: "merge", label: t("Merge the incoming changes into the current branch") },
						{ value: "rebase", label: t("Rebase the current branch on top of the incoming changes") },
					],
				},
			],
			ok: t("OK"),
			cancel: t("Cancel"),
		});
		if (answer === null) return;
		store("pullHow", answer.how);
		await run(t("Update Project"), () => call("pull", { root, how: answer.how }));
	}

	async function pushDialog() {
		let outgoing;
		try {
			outgoing = await call("outgoing", { root });
		} catch (error) {
			notice(errorText(error), "error");
			return;
		}
		if (outgoing.branch === null) {
			notice(t("Check out a branch to push."), "error");
			return;
		}
		const list = el(
			"div",
			{ class: "gp-push-list" },
			outgoing.commits.length === 0
				? [el("p", { class: "k-muted", text: t("No commits to push; the branch is pushed as it is.") })]
				: outgoing.commits.map((commit) =>
						el("div", { class: "gp-push-row" }, [
							el("span", { class: "k-mono gp-hash", text: commit.hash.slice(0, 8) }),
							el("span", { class: "gp-push-subject", text: commit.subject }),
							el("span", { class: "k-muted", text: commit.author }),
						]),
					),
		);
		const answer = await dialog({
			title: t("Push Commits to {0}", outgoing.upstream ?? `origin/${outgoing.branch}`),
			text: outgoing.upstream ? "" : t("The branch is new: it is pushed to origin and follows it from then on."),
			extra: list,
			fields: [{ key: "force", type: "checkbox", label: t("Force push (with lease)"), value: false }],
			ok: t("Push"),
			cancel: t("Cancel"),
		});
		if (answer === null) return;
		await run(t("Push"), () => call("push", { root, force: answer.force }));
	}

	// --- Tabs ----------------------------------------------------------------------------------

	const TAB_LABELS = {
		changes: () => t("Local Changes"),
		shelf: () => t("Shelf"),
		stash: () => t("Stash"),
		log: () => t("Log"),
		console: () => t("Console"),
	};

	function renderTabs() {
		fill(tabs, 
			...TABS.map((name) => {
				const count =
					name === "changes" ? (state?.files.length ?? 0) : name === "stash" ? (state?.stashCount ?? 0) : name === "shelf" ? shelves.length : 0;
				return el(
					"button",
					{
						class: "k-tab",
						type: "button",
						role: "tab",
						"aria-selected": String(tab === name),
						"data-tab": name,
						onclick: () => switchTab(name),
					},
					[el("span", { text: TAB_LABELS[name]() }), count > 0 ? el("span", { class: "k-tab-count", text: String(count) }) : null],
				);
			}),
		);
	}

	async function switchTab(name) {
		tab = TABS.includes(name) ? name : "changes";
		store("tab", tab);
		render();
		if (tab === "shelf") await loadShelves();
		if (tab === "stash") await loadStashes();
		if (tab === "log") await reloadLog(log.commits.length > 0);
		render();
	}

	function render() {
		closeMenu();
		renderHeader();
		renderTabs();
		const current = repo();
		if (current === null) {
			fill(content, emptyState());
			return;
		}
		if (tab === "console") {
			fill(content, renderConsole());
			return;
		}
		if (!current.trusted || state === null) {
			fill(content, el("div", { class: "k-empty", text: current.trusted ? t("Loading…") : t("Trust the repository to see its changes.") }));
			return;
		}
		const scroll = content.querySelector(".gp-scroll")?.scrollTop ?? 0;
		const page =
			tab === "changes" ? renderChanges() : tab === "shelf" ? renderShelf() : tab === "stash" ? renderStash() : renderLog();
		fill(content, page);
		const area = content.querySelector(".gp-scroll");
		if (area && tab !== "log") area.scrollTop = scroll;
	}

	function emptyState() {
		return el("div", { class: "k-empty gp-empty" }, [
			el("div", { class: "k-empty-icon" }, [icon("branch")]),
			el("p", { text: t("No git repository is open. Open a folder that is one, or:") }),
			el("div", { class: "gp-empty-actions" }, [
				el("button", { class: "k-button primary", type: "button", text: t("Clone Repository…"), onclick: () => void cloneDialog() }),
				el("button", { class: "k-button", type: "button", text: t("Add a Repository…"), onclick: () => void addRepo() }),
				...plainFolders.map((folder) =>
					el("button", {
						class: "k-button",
						type: "button",
						text: t("Create Git Repository in {0}", splitPath(folder.replace(/\\/g, "/")).name),
						onclick: () => void initRepo(folder),
					}),
				),
			]),
		]);
	}

	// --- Local Changes ---------------------------------------------------------------------------

	const fileIcon = (kind) => el("span", { class: `gp-kind ${kind}`, text: KIND_LETTER[kind] ?? "M", title: t(kind) });

	function localSides(file) {
		const head = state.head ? state.head.slice(0, 8) : "";
		return {
			path: file.path,
			oldPath: file.oldPath,
			kind: file.kind,
			left: file.kind === "untracked" || (file.kind === "added" && !file.oldPath) || state.head === null ? { empty: true } : { ref: "HEAD", path: file.oldPath ?? file.path },
			right: file.kind === "deleted" ? { empty: true } : { worktree: true, path: file.path },
			leftLabel: state.head ? `HEAD (${head})` : t("(none)"),
			rightLabel: t("Your version"),
		};
	}

	function groups() {
		const conflicts = state.files.filter((file) => file.kind === "conflict");
		const changes = state.files.filter((file) => file.kind !== "conflict" && file.kind !== "untracked");
		const untracked = state.files.filter((file) => file.kind === "untracked");
		return [
			{ id: "conflicts", title: t("Merge Conflicts"), files: conflicts },
			{ id: "changes", title: t("Changes"), files: changes },
			{ id: "untracked", title: t("Unversioned Files"), files: untracked },
		].filter((group) => group.files.length > 0 || group.id === "changes");
	}

	async function showDiff(files, at) {
		if (files.length === 0) return;
		try {
			await call("openDiff", {
				root,
				files: files.map(localSides),
				index: at,
				editable: true,
				key: `local:${root}`,
				title: t("Diff: {0}", splitPath(files[at].path).name),
			});
		} catch (error) {
			notice(errorText(error), "error");
		}
	}

	const selectedFiles = () => state.files.filter((file) => selected.has(file.path));

	function selectRow(path, event, order) {
		if (event.shiftKey && anchor !== null) {
			const from = order.indexOf(anchor);
			const to = order.indexOf(path);
			if (!event.ctrlKey && !event.metaKey) selected.clear();
			for (let i = Math.min(from, to); i <= Math.max(from, to); i++) selected.add(order[i]);
		} else if (event.ctrlKey || event.metaKey) {
			if (selected.has(path)) selected.delete(path);
			else selected.add(path);
			anchor = path;
		} else {
			selected.clear();
			selected.add(path);
			anchor = path;
		}
	}

	function changeMenu(file) {
		const files = selectedFiles();
		const paths = files.map((each) => each.path);
		const untracked = files.filter((each) => each.kind === "untracked");
		const conflicts = files.filter((each) => each.kind === "conflict");
		const tracked = files.filter((each) => each.kind !== "untracked" && each.kind !== "conflict");
		const groupFiles = groups().find((group) => group.files.includes(file))?.files ?? [file];
		return [
			{ label: t("Show Diff"), icon: "diff", shortcut: "Ctrl+D", run: () => void showDiff(groupFiles, groupFiles.indexOf(file)) },
			{
				label: t("Commit File…"),
				icon: "commit",
				disabled: conflicts.length > 0,
				run: () => {
					checked.clear();
					for (const path of paths) checked.add(path);
					render();
					content.querySelector(".gp-message")?.focus();
				},
			},
			null,
			{
				label: t("Rollback…"),
				icon: "undo",
				disabled: tracked.length === 0,
				run: () =>
					void confirmThen(
						t("Roll back the changes of {0} files? They go back to the last commit's version; new files are deleted.", tracked.length),
						t("Rollback"),
						() => call("rollback", { root, paths: tracked.map((each) => each.path) }),
					),
			},
			{ label: t("Shelve Changes…"), icon: "shelf", disabled: tracked.length + untracked.length === 0, run: () => void shelveDialog([...tracked, ...untracked]) },
			{ label: t("Stash Changes…"), icon: "stash", disabled: tracked.length === 0, run: () => void stashDialog(tracked.map((each) => each.path)) },
			null,
			{ label: t("Add to VCS"), disabled: untracked.length === 0, run: () => void run(t("Add to VCS"), () => call("add", { root, paths: untracked.map((each) => each.path) })) },
			{ label: t("Add to .gitignore"), disabled: untracked.length === 0, run: () => void run(t("Add to .gitignore"), () => call("ignore", { root, paths: untracked.map((each) => each.path) })) },
			{
				label: t("Delete…"),
				danger: true,
				disabled: untracked.length === 0,
				run: () =>
					void confirmThen(t("Delete {0} unversioned files? This cannot be undone.", untracked.length), t("Delete"), () =>
						call("deleteUntracked", { root, paths: untracked.map((each) => each.path) }),
					),
			},
			...(conflicts.length > 0
				? [
						null,
						{ label: t("Accept Yours"), run: () => void run(t("Accept Yours"), () => call("resolve", { root, paths: conflicts.map((each) => each.path), take: "ours" })) },
						{ label: t("Accept Theirs"), run: () => void run(t("Accept Theirs"), () => call("resolve", { root, paths: conflicts.map((each) => each.path), take: "theirs" })) },
						{ label: t("Mark as Resolved"), run: () => void run(t("Mark as Resolved"), () => call("resolve", { root, paths: conflicts.map((each) => each.path) })) },
					]
				: []),
			null,
			{ label: t("Copy Path"), run: () => void copyText(paths.join("\n")) },
		];
	}

	function renderChanges() {
		const all = groups();
		const order = all.flatMap((group) => (collapsed.has(group.id) ? [] : group.files.map((file) => file.path)));
		const rows = [];
		for (const group of all) {
			const total = group.files.length;
			const on = group.files.filter((file) => checked.has(file.path)).length;
			const box = el("input", { type: "checkbox", "aria-label": group.title, disabled: group.id === "conflicts" ? true : undefined });
			box.checked = total > 0 && on === total;
			box.indeterminate = on > 0 && on < total;
			box.addEventListener("change", () => {
				for (const file of group.files) {
					if (box.checked) checked.add(file.path);
					else checked.delete(file.path);
				}
				render();
			});
			const open = !collapsed.has(group.id);
			rows.push(
				el(
					"div",
					{
						class: "gp-group",
						role: "treeitem",
						"aria-expanded": String(open),
						onclick: (event) => {
							if (event.target === box) return;
							if (open) collapsed.add(group.id);
							else collapsed.delete(group.id);
							store("collapsed", [...collapsed]);
							render();
						},
					},
					[
						el("span", { class: `gp-twisty${open ? " open" : ""}` }, [icon("chevron")]),
						box,
						el("span", { class: "gp-group-title", text: group.title }),
						el("span", { class: "k-muted", text: t("{0} files", total) }),
					],
				),
			);
			if (!open) continue;
			group.files.forEach((file, at) => {
				const { name, folder } = splitPath(file.path);
				const fileBox = el("input", { type: "checkbox", "aria-label": file.path, disabled: file.kind === "conflict" ? true : undefined });
				fileBox.checked = checked.has(file.path);
				fileBox.addEventListener("change", () => {
					if (fileBox.checked) checked.add(file.path);
					else checked.delete(file.path);
					render();
				});
				const row = el(
					"div",
					{
						class: `gp-file ${file.kind}${selected.has(file.path) ? " selected" : ""}`,
						role: "treeitem",
						tabindex: "-1",
						"aria-selected": String(selected.has(file.path)),
						"data-path": file.path,
						title: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
					},
					[
						fileBox,
						fileIcon(file.kind),
						el("span", { class: "gp-file-name", text: name }),
						el("span", { class: "gp-file-folder", text: file.oldPath ? `${folder}  ← ${file.oldPath}` : folder }),
					],
				);
				row.addEventListener("click", (event) => {
					if (event.target === fileBox) return;
					selectRow(file.path, event, order);
					render();
					content.querySelector(`.gp-file[data-path="${CSS.escape(file.path)}"]`)?.focus();
				});
				row.addEventListener("dblclick", () => void showDiff(group.files, at));
				row.addEventListener("contextmenu", (event) => {
					if (!selected.has(file.path)) {
						selected.clear();
						selected.add(file.path);
						anchor = file.path;
						render();
					}
					menuAt(event, changeMenu(file));
				});
				row.addEventListener("keydown", (event) => {
					const index = order.indexOf(file.path);
					if (event.key === "Enter" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d")) {
						event.preventDefault();
						void showDiff(group.files, at);
					} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						const next = order[index + (event.key === "ArrowDown" ? 1 : -1)];
						if (next === undefined) return;
						selectRow(next, event, order);
						render();
						content.querySelector(`.gp-file[data-path="${CSS.escape(next)}"]`)?.focus();
					} else if (event.key === " ") {
						event.preventDefault();
						fileBox.click();
					}
				});
				rows.push(row);
			});
			if (group.id === "changes" && total === 0) rows.push(el("div", { class: "gp-none k-muted", text: t("No changes.") }));
		}

		const chosen = state.files.filter((file) => checked.has(file.path));
		const box = el("textarea", { class: "k-textarea gp-message", placeholder: t("Commit Message"), spellcheck: "true", "aria-label": t("Commit Message") });
		box.value = message();
		box.addEventListener("input", () => setMessage(box.value));
		box.addEventListener("keydown", (event) => {
			if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
				event.preventDefault();
				void doCommit(false);
			}
		});
		const amendBox = el("input", { type: "checkbox" });
		amendBox.checked = amend;
		amendBox.addEventListener("change", async () => {
			amend = amendBox.checked;
			if (amend && box.value.trim() === "") {
				const last = await call("headMessage", { root }).catch(() => "");
				box.value = last;
				setMessage(last);
			}
		});
		const suggest = el(
			"button",
			{
				class: "k-button small ghost",
				type: "button",
				title: t("Write a commit message with the assistant from the chosen files' changes"),
				disabled: chosen.length === 0 ? true : undefined,
				onclick: async (event) => {
					const button = event.currentTarget;
					button.disabled = true;
					button.classList.add("busy");
					try {
						const text = await call("suggestMessage", { root, paths: chosen.map((file) => file.path) });
						if (text) {
							box.value = text;
							setMessage(text);
						}
					} catch (error) {
						notice(t("The assistant could not write a message: {0}", errorText(error)), "error");
					} finally {
						button.disabled = false;
						button.classList.remove("busy");
					}
				},
			},
			[icon("sparkle"), el("span", { text: t("Suggest") })],
		);
		const canCommit = (chosen.length > 0 || amend) && busy === null;
		const changeTools = el("div", { class: "k-toolbar gp-subtools" }, [
			tool("refresh", t("Refresh"), () => void refreshAll()),
			tool("undo", t("Rollback…"), () => {
				const files = selectedFiles().filter((file) => file.kind !== "untracked" && file.kind !== "conflict");
				if (files.length === 0) return notice(t("Select the files to roll back."));
				void confirmThen(t("Roll back the changes of {0} files? They go back to the last commit's version; new files are deleted.", files.length), t("Rollback"), () =>
					call("rollback", { root, paths: files.map((file) => file.path) }),
				);
			}),
			tool("diff", t("Show Diff (Ctrl+D)"), () => {
				const first = selectedFiles()[0] ?? state.files[0];
				if (!first) return;
				const group = groups().find((each) => each.files.includes(first));
				void showDiff(group.files, group.files.indexOf(first));
			}),
			tool("shelf", t("Shelve Changes…"), () => {
				const files = selectedFiles().length > 0 ? selectedFiles() : state.files.filter((file) => checked.has(file.path));
				void shelveDialog(files.filter((file) => file.kind !== "conflict"));
			}),
			tool("stash", t("Stash Changes…"), () => void stashDialog()),
			el("span", { class: "k-spacer" }),
			el("span", { class: "k-muted gp-small", text: t("{0} of {1} chosen", chosen.length, state.files.length) }),
		]);
		return el("div", { class: "gp-changes" }, [
			changeTools,
			el("div", { class: "gp-scroll gp-tree", role: "tree", "aria-label": t("Local Changes") }, rows),
			el("div", { class: "gp-commit" }, [
				el("div", { class: "gp-commit-head" }, [
					el("label", { class: "gp-check" }, [amendBox, el("span", { text: t("Amend") })]),
					el("span", { class: "k-spacer" }),
					suggest,
				]),
				box,
				el("div", { class: "gp-commit-actions" }, [
					el("button", { class: "k-button primary", type: "button", text: t("Commit"), disabled: canCommit ? undefined : true, onclick: () => void doCommit(false) }),
					el("button", { class: "k-button", type: "button", text: t("Commit and Push…"), disabled: canCommit ? undefined : true, onclick: () => void doCommit(true) }),
				]),
			]),
		]);
	}

	async function doCommit(push) {
		const text = message().trim();
		const paths = state.files.filter((file) => checked.has(file.path) && file.kind !== "conflict").map((file) => file.path);
		if (text === "" && !amend) {
			notice(t("Write a commit message."), "error");
			content.querySelector(".gp-message")?.focus();
			return;
		}
		if (paths.length === 0 && !amend) {
			notice(t("Choose the files to commit."), "error");
			return;
		}
		const done = await run(amend ? t("Amend Commit") : t("Commit"), () => call("commit", { root, message: text, paths, amend }));
		if (done !== undefined) {
			setMessage("");
			amend = false;
			render();
			if (push) await pushDialog();
		}
	}

	async function shelveDialog(files) {
		if (files.length === 0) {
			notice(t("Choose the files to shelve."));
			return;
		}
		const answer = await dialog({
			title: t("Shelve Changes"),
			text: t("{0} files are put on the shelf and rolled back here.", files.length),
			fields: [{ key: "name", label: t("Name"), value: message().split("\n")[0] ?? "" }],
			ok: t("Shelve"),
			cancel: t("Cancel"),
		});
		if (answer === null) return;
		await run(t("Shelve Changes"), () => call("shelve", { root, paths: files.map((file) => file.path), name: answer.name }));
		await loadShelves();
		render();
	}

	async function stashDialog(paths = []) {
		const answer = await dialog({
			title: t("Stash Changes"),
			text: paths.length > 0 ? t("Only the {0} chosen files are stashed.", paths.length) : "",
			fields: [
				{ key: "message", label: t("Message"), value: "" },
				{ key: "keepIndex", type: "checkbox", label: t("Keep index"), value: false },
				{ key: "untracked", type: "checkbox", label: t("Include unversioned files"), value: false },
			],
			ok: t("Create Stash"),
			cancel: t("Cancel"),
		});
		if (answer === null) return;
		await run(t("Stash Changes"), () => call("stash", { root, ...answer, paths }));
		await loadStashes();
		render();
	}

	// --- Shelf -----------------------------------------------------------------------------------

	async function loadShelves() {
		if (state === null) return;
		shelves = await call("shelves", { root }).catch(() => []);
		if (!shelves.some((each) => each.id === shelfSelected)) shelfSelected = shelves[0]?.id ?? null;
	}

	function shelfSides(shelf, file) {
		return {
			path: file.path,
			oldPath: file.oldPath,
			kind: file.kind,
			left: file.kind === "added" ? { empty: true } : { ref: shelf.base, path: file.oldPath ?? file.path },
			right: file.kind === "deleted" ? { empty: true } : { shelf: shelf.id, path: file.path },
			leftLabel: `${t("Base")} (${shelf.base.slice(0, 8)})`,
			rightLabel: t("Shelved version"),
		};
	}

	function renderShelf() {
		const shelf = shelves.find((each) => each.id === shelfSelected) ?? null;
		const act = (label, work, refreshShelves = true) => async () => {
			if (shelf === null) return;
			await run(label, work);
			if (refreshShelves) await loadShelves();
			render();
		};
		const toolsRow = el("div", { class: "k-toolbar gp-subtools" }, [
			tool("refresh", t("Refresh"), async () => {
				await loadShelves();
				render();
			}),
			el("button", { class: "k-button small", type: "button", text: t("Unshelve"), disabled: shelf ? undefined : true, onclick: act(t("Unshelve"), () => call("unshelve", { root, id: shelf.id })) }),
			el("button", {
				class: "k-button small",
				type: "button",
				text: t("Apply and Keep"),
				disabled: shelf ? undefined : true,
				onclick: act(t("Apply and Keep"), () => call("unshelve", { root, id: shelf.id, keep: true })),
			}),
			el("button", {
				class: "k-button small",
				type: "button",
				text: t("Rename…"),
				disabled: shelf ? undefined : true,
				onclick: async () => {
					const answer = await dialog({ title: t("Rename"), fields: [{ key: "name", label: t("Name"), value: shelf.name }], ok: t("Rename"), cancel: t("Cancel") });
					if (answer === null) return;
					shelves = await call("renameShelf", { root, id: shelf.id, name: answer.name });
					render();
				},
			}),
			el("button", {
				class: "k-button small stop",
				type: "button",
				text: t("Delete…"),
				disabled: shelf ? undefined : true,
				onclick: async () => {
					const answer = await dialog({ title: t("Delete"), text: t("Delete the shelf {0}?", shelf.name), ok: t("Delete"), cancel: t("Cancel"), danger: true });
					if (answer === null) return;
					shelves = await call("dropShelf", { root, id: shelf.id });
					shelfSelected = shelves[0]?.id ?? null;
					render();
				},
			}),
		]);
		if (shelves.length === 0) {
			return el("div", { class: "gp-changes" }, [
				toolsRow,
				el("div", { class: "k-empty", text: t("Nothing is shelved. Shelve changes from Local Changes to put them aside without committing.") }),
			]);
		}
		const rows = [];
		for (const each of shelves) {
			const open = each.id === shelfSelected;
			rows.push(
				el(
					"div",
					{
						class: `gp-group gp-shelf${open ? " selected" : ""}`,
						role: "treeitem",
						"aria-expanded": String(open),
						onclick: () => {
							shelfSelected = each.id;
							render();
						},
						oncontextmenu: (event) => {
							shelfSelected = each.id;
							render();
							menuAt(event, [
								{ label: t("Unshelve"), run: act(t("Unshelve"), () => call("unshelve", { root, id: each.id })) },
								{ label: t("Apply and Keep"), run: act(t("Apply and Keep"), () => call("unshelve", { root, id: each.id, keep: true })) },
								{ label: t("Show Diff"), icon: "diff", run: () => void openShelfDiff(each, 0) },
							]);
						},
					},
					[
						el("span", { class: `gp-twisty${open ? " open" : ""}` }, [icon("chevron")]),
						icon("shelf"),
						el("span", { class: "gp-group-title", text: each.name }),
						el("span", { class: "k-muted", text: `${t("{0} files", each.files.length)} · ${relativeTime(each.time, kalem.language)}${each.branch ? ` · ${each.branch}` : ""}` }),
					],
				),
			);
			if (!open) continue;
			each.files.forEach((file, at) => {
				const { name, folder } = splitPath(file.path);
				rows.push(
					el(
						"div",
						{ class: `gp-file ${file.kind} indented`, role: "treeitem", tabindex: "-1", ondblclick: () => void openShelfDiff(each, at), onkeydown: (event) => event.key === "Enter" && void openShelfDiff(each, at) },
						[fileIcon(file.kind), el("span", { class: "gp-file-name", text: name }), el("span", { class: "gp-file-folder", text: folder })],
					),
				);
			});
		}
		return el("div", { class: "gp-changes" }, [toolsRow, el("div", { class: "gp-scroll gp-tree", role: "tree" }, rows)]);
	}

	async function openShelfDiff(shelf, at) {
		await call("openDiff", {
			root,
			files: shelf.files.map((file) => shelfSides(shelf, file)),
			index: at,
			key: `shelf:${root}:${shelf.id}`,
			title: t("Shelf: {0}", shelf.name),
		}).catch((error) => notice(errorText(error), "error"));
	}

	// --- Stash ----------------------------------------------------------------------------------

	async function loadStashes() {
		if (state === null) return;
		stashes = await call("stashes", { root }).catch(() => []);
		if (!stashes.some((each) => each.ref === stashSelected)) stashSelected = stashes[0]?.ref ?? null;
		stashFiles = stashSelected ? await call("stashFiles", { root, ref: stashSelected }).catch(() => []) : [];
	}

	function stashSides(ref, file) {
		return {
			path: file.path,
			oldPath: file.oldPath,
			kind: file.kind,
			left: file.kind === "added" || file.kind === "untracked" ? { empty: true } : { ref: `${ref}^1`, path: file.oldPath ?? file.path },
			right: file.kind === "deleted" ? { empty: true } : file.kind === "untracked" ? { ref: `${ref}^3`, path: file.path } : { ref, path: file.path },
			leftLabel: t("Base"),
			rightLabel: ref,
		};
	}

	function renderStash() {
		const chosen = stashes.find((each) => each.ref === stashSelected) ?? null;
		const act = (label, work, ask = null) => async () => {
			if (chosen === null) return;
			if (ask !== null) {
				const answer = await dialog({ title: label, text: ask, ok: label, cancel: t("Cancel"), danger: true });
				if (answer === null) return;
			}
			await run(label, work);
			await loadStashes();
			render();
		};
		const toolsRow = el("div", { class: "k-toolbar gp-subtools" }, [
			tool("stash", t("Stash Changes…"), () => void stashDialog()),
			tool("refresh", t("Refresh"), async () => {
				await loadStashes();
				render();
			}),
			el("button", { class: "k-button small", type: "button", text: t("Apply"), disabled: chosen ? undefined : true, onclick: act(t("Apply Stash"), () => call("stashApply", { root, ref: chosen.ref })) }),
			el("button", { class: "k-button small", type: "button", text: t("Pop"), disabled: chosen ? undefined : true, onclick: act(t("Pop Stash"), () => call("stashApply", { root, ref: chosen.ref, pop: true })) }),
			el("button", {
				class: "k-button small",
				type: "button",
				text: t("Unstash as Branch…"),
				disabled: chosen ? undefined : true,
				onclick: async () => {
					const answer = await dialog({ title: t("Unstash as Branch"), fields: [{ key: "branch", label: t("New branch name") }], ok: t("Create"), cancel: t("Cancel") });
					if (answer === null || answer.branch === "") return;
					await run(t("Unstash as Branch"), () => call("stashApply", { root, ref: chosen.ref, branch: answer.branch }));
					await loadStashes();
					render();
				},
			}),
			el("button", {
				class: "k-button small stop",
				type: "button",
				text: t("Drop"),
				disabled: chosen ? undefined : true,
				onclick: act(t("Drop Stash"), () => call("stashDrop", { root, ref: chosen.ref }), chosen ? t("Drop {0}? It cannot be brought back.", chosen.ref) : null),
			}),
			el("button", {
				class: "k-button small stop",
				type: "button",
				text: t("Clear"),
				disabled: stashes.length > 0 ? undefined : true,
				onclick: async () => {
					const answer = await dialog({ title: t("Clear Stashes"), text: t("Drop all {0} stashes? They cannot be brought back.", stashes.length), ok: t("Clear"), cancel: t("Cancel"), danger: true });
					if (answer === null) return;
					await run(t("Clear Stashes"), () => call("stashClear", { root }));
					await loadStashes();
					render();
				},
			}),
		]);
		if (stashes.length === 0) {
			return el("div", { class: "gp-changes" }, [toolsRow, el("div", { class: "k-empty", text: t("No stashes.") })]);
		}
		const list = el(
			"div",
			{ class: "gp-scroll gp-list", role: "listbox", "aria-label": t("Stash") },
			stashes.map((each) =>
				el(
					"div",
					{
						class: `gp-stash${each.ref === stashSelected ? " selected" : ""}`,
						role: "option",
						"aria-selected": String(each.ref === stashSelected),
						onclick: async () => {
							stashSelected = each.ref;
							stashFiles = await call("stashFiles", { root, ref: each.ref }).catch(() => []);
							render();
						},
					},
					[
						el("span", { class: "k-mono gp-hash", text: each.ref }),
						el("span", { class: "gp-stash-subject", text: each.subject }),
						el("span", { class: "k-muted", text: relativeTime(each.time, kalem.language) }),
					],
				),
			),
		);
		const files = el(
			"div",
			{ class: "gp-scroll gp-tree", role: "tree" },
			stashFiles.map((file, at) => {
				const { name, folder } = splitPath(file.path);
				return el(
					"div",
					{
						class: `gp-file ${file.kind}`,
						role: "treeitem",
						tabindex: "-1",
						ondblclick: () => void openStashDiff(at),
						onkeydown: (event) => event.key === "Enter" && void openStashDiff(at),
					},
					[fileIcon(file.kind), el("span", { class: "gp-file-name", text: name }), el("span", { class: "gp-file-folder", text: folder })],
				);
			}),
		);
		return el("div", { class: "gp-changes" }, [toolsRow, el("div", { class: "k-split gp-split" }, [list, files])]);
	}

	async function openStashDiff(at) {
		await call("openDiff", {
			root,
			files: stashFiles.map((file) => stashSides(stashSelected, file)),
			index: at,
			key: `stash:${root}:${stashSelected}`,
			title: stashSelected,
		}).catch((error) => notice(errorText(error), "error"));
	}

	// --- Log ------------------------------------------------------------------------------------

	const logKey = () => JSON.stringify([root, logFilter]);

	async function reloadLog(keep = false) {
		if (state === null) return;
		if (keep && log.key === logKey()) return;
		log = { commits: [], rows: [], graph: { lanes: [] }, done: false, loading: false, key: logKey() };
		await loadMoreLog();
	}

	async function loadMoreLog() {
		if (log.loading || log.done || state === null) return;
		log.loading = true;
		const key = log.key;
		try {
			const commits = await call("log", { root, ...logFilter, skip: log.commits.length, limit: PAGE });
			if (key !== log.key) return;
			const graph = graphRows(commits, log.graph);
			log.commits.push(...commits);
			log.rows.push(...graph.rows);
			log.graph = graph.state;
			log.done = commits.length < PAGE;
			if (logSelected.size === 0 && log.commits[0]) {
				logSelected.add(log.commits[0].hash);
				logAnchor = log.commits[0].hash;
				void loadDetail(log.commits[0].hash);
			}
		} catch (error) {
			notice(errorText(error), "error");
			log.done = true;
		} finally {
			log.loading = false;
		}
		if (tab === "log") renderLogTable();
	}

	async function loadDetail(hash) {
		try {
			const next = await call("commit.detail", { root, hash });
			if (logSelected.has(next.hash) || logSelected.size === 0) {
				detail = next;
				renderDetail();
			}
		} catch (error) {
			detail = null;
			notice(errorText(error), "error");
		}
	}

	function graphCell(row, commit) {
		const width = Math.max(1, Math.max(row.before.length, row.after.length, row.node + 1)) * LANE + 4;
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", String(width));
		svg.setAttribute("height", String(ROW));
		svg.setAttribute("class", "gp-graph");
		const x = (lane) => lane * LANE + LANE / 2 + 2;
		const color = (lane) => COLORS[lane % COLORS.length];
		const line = (x1, y1, x2, y2, stroke) => {
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			const mid = (y1 + y2) / 2;
			path.setAttribute("d", x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`);
			path.setAttribute("stroke", stroke);
			path.setAttribute("stroke-width", "1.6");
			path.setAttribute("fill", "none");
			svg.append(path);
		};
		row.before.forEach((hash, lane) => {
			if (hash === null) return;
			if (hash === row.hash) line(x(lane), 0, x(row.node), ROW / 2, color(lane));
			else {
				const to = row.after.indexOf(hash) === -1 ? lane : row.after.indexOf(hash);
				line(x(lane), 0, x(to), ROW, color(to));
			}
		});
		for (const lane of row.parentLanes) line(x(row.node), ROW / 2, x(lane), ROW, color(lane));
		const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		dot.setAttribute("cx", String(x(row.node)));
		dot.setAttribute("cy", String(ROW / 2));
		dot.setAttribute("r", commit.parents.length > 1 ? "3" : "3.6");
		dot.setAttribute("fill", commit.parents.length > 1 ? "var(--k-panel)" : color(row.node));
		dot.setAttribute("stroke", color(row.node));
		dot.setAttribute("stroke-width", "1.6");
		svg.append(dot);
		return svg;
	}

	const refBadge = (ref) =>
		el("span", { class: `gp-ref ${ref.kind}`, title: ref.name }, [ref.kind === "tag" ? icon("tag") : icon("branch"), el("span", { text: ref.name })]);

	let logBody = null;
	let detailBox = null;

	function renderLog() {
		const search = el("input", { class: "k-input gp-log-search", type: "search", placeholder: t("Text or hash"), "aria-label": t("Search the log") });
		search.value = logFilter.text;
		const user = el("input", { class: "k-input gp-log-user", type: "search", placeholder: t("User"), "aria-label": t("User") });
		user.value = logFilter.author;
		let timer = 0;
		const filter = () => {
			clearTimeout(timer);
			timer = setTimeout(async () => {
				logFilter = { ...logFilter, text: search.value.trim(), author: user.value.trim() };
				logSelected.clear();
				detail = null;
				await reloadLog();
			}, 350);
		};
		search.addEventListener("input", filter);
		user.addEventListener("input", filter);
		const branch = el("select", { class: "k-select gp-log-branch", "aria-label": t("Branch") }, [
			el("option", { value: "HEAD", text: t("Branch: {0}", state.branch ?? "HEAD"), selected: logFilter.branch === "HEAD" ? true : undefined }),
			el("option", { value: "--all", text: t("All branches"), selected: logFilter.branch === "--all" ? true : undefined }),
			logFilter.branch !== "HEAD" && logFilter.branch !== "--all"
				? el("option", { value: logFilter.branch, text: logFilter.branch, selected: true })
				: null,
		]);
		void ensureBranches().then((list) => {
			if (list === null) return;
			for (const each of [...list.local.filter((b) => !b.current), ...list.remote]) {
				if (each.name === logFilter.branch) continue;
				branch.append(el("option", { value: each.name, text: each.name, selected: logFilter.branch === each.name ? true : undefined }));
			}
		});
		branch.addEventListener("change", async () => {
			logFilter = { ...logFilter, branch: branch.value };
			logSelected.clear();
			detail = null;
			await reloadLog();
		});
		logBody = el("div", { class: "gp-scroll gp-log-rows", role: "grid", tabindex: "0", "aria-label": t("Log") });
		logBody.addEventListener("scroll", () => {
			if (logBody.scrollTop + logBody.clientHeight > logBody.scrollHeight - 400) void loadMoreLog();
		});
		logBody.addEventListener("keydown", logKeys);
		detailBox = el("div", { class: "gp-detail" });
		renderLogTable();
		renderDetail();
		return el("div", { class: "gp-log" }, [
			el("div", { class: "k-toolbar gp-subtools" }, [
				icon("search"),
				search,
				branch,
				icon("user"),
				user,
				logFilter.path
					? el("span", { class: "k-badge info gp-path-filter", title: logFilter.path }, [
							el("span", { text: splitPath(logFilter.path).name }),
							el("button", {
								class: "k-button small ghost icon",
								type: "button",
								"aria-label": t("Show all files"),
								onclick: async () => {
									logFilter = { ...logFilter, path: "" };
									logSelected.clear();
									detail = null;
									await reloadLog();
									render();
								},
							}, [icon("close")]),
						])
					: null,
				tool("refresh", t("Refresh"), () => void reloadLog()),
				el("span", { class: "k-spacer" }),
				el("span", { class: "k-muted gp-small", text: log.done ? t("{0} commits", log.commits.length) : t("{0}+ commits", log.commits.length) }),
			]),
			el("div", { class: "k-split gp-split gp-log-split" }, [el("div", { class: "gp-log-main" }, [logBody]), detailBox]),
		]);
	}

	function renderLogTable() {
		if (logBody === null) return;
		const top = logBody.scrollTop;
		const rows = log.commits.map((commit, at) => {
			const row = log.rows[at];
			const sel = logSelected.has(commit.hash);
			const isHead = state?.head === commit.hash;
			const element = el(
				"div",
				{
					class: `gp-commit-row${sel ? " selected" : ""}${isHead ? " head" : ""}`,
					role: "row",
					"aria-selected": String(sel),
					"data-hash": commit.hash,
				},
				[
					el("div", { class: "gp-cell gp-cell-graph" }, [graphCell(row, commit)]),
					el("div", { class: "gp-cell gp-cell-subject", title: commit.subject }, [
						...commit.refs.map(refBadge),
						el("span", { class: "gp-subject", text: commit.subject }),
					]),
					el("div", { class: "gp-cell gp-cell-author", text: commit.author, title: commit.email }),
					el("div", { class: "gp-cell gp-cell-date", text: dateTime(commit.time, kalem.language) }),
				],
			);
			element.addEventListener("click", (event) => {
				selectCommit(commit.hash, event);
			});
			element.addEventListener("dblclick", () => void openCommitDiff(commit.hash, 0));
			element.addEventListener("contextmenu", (event) => {
				if (!logSelected.has(commit.hash)) selectCommit(commit.hash, { shiftKey: false, ctrlKey: false, metaKey: false });
				void commitMenu(commit, event.clientX, event.clientY);
				event.preventDefault();
			});
			return element;
		});
		if (log.commits.length === 0 && !log.loading) rows.push(el("div", { class: "k-empty", text: t("No commits match.") }));
		if (log.loading) rows.push(el("div", { class: "gp-loading" }, [el("span", { class: "k-spinner" })]));
		fill(logBody, ...rows);
		logBody.scrollTop = top;
	}

	function selectCommit(hash, event) {
		const order = log.commits.map((commit) => commit.hash);
		if (event.shiftKey && logAnchor !== null) {
			const from = order.indexOf(logAnchor);
			const to = order.indexOf(hash);
			if (!event.ctrlKey && !event.metaKey) logSelected.clear();
			for (let i = Math.min(from, to); i <= Math.max(from, to); i++) logSelected.add(order[i]);
		} else if (event.ctrlKey || event.metaKey) {
			if (logSelected.has(hash)) logSelected.delete(hash);
			else logSelected.add(hash);
			logAnchor = hash;
		} else {
			logSelected.clear();
			logSelected.add(hash);
			logAnchor = hash;
		}
		for (const row of logBody.querySelectorAll(".gp-commit-row")) {
			const on = logSelected.has(row.dataset.hash);
			row.classList.toggle("selected", on);
			row.setAttribute("aria-selected", String(on));
		}
		if (logSelected.size === 1) void loadDetail(hash);
		else {
			detail = null;
			renderDetail();
		}
	}

	function moveTo(hash) {
		if (!hash) return;
		const known = log.commits.some((commit) => commit.hash === hash);
		if (!known) {
			notice(t("That commit is not loaded in this view."));
			return;
		}
		selectCommit(hash, {});
		logBody.querySelector(`[data-hash="${hash}"]`)?.scrollIntoView({ block: "nearest" });
	}

	const childOf = (hash) => log.commits.find((commit) => commit.parents.includes(hash))?.hash;
	const parentOf = (hash) => log.commits.find((commit) => commit.hash === hash)?.parents[0];

	function logKeys(event) {
		const order = log.commits.map((commit) => commit.hash);
		const current = logAnchor ?? order[0];
		const index = order.indexOf(current);
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const next = order[index + (event.key === "ArrowDown" ? 1 : -1)];
			if (next) {
				selectCommit(next, event);
				logBody.querySelector(`[data-hash="${next}"]`)?.scrollIntoView({ block: "nearest" });
			}
		} else if (event.key === "ArrowLeft") {
			event.preventDefault();
			moveTo(childOf(current));
		} else if (event.key === "ArrowRight") {
			event.preventDefault();
			moveTo(parentOf(current));
		} else if (event.key === "Enter") {
			void openCommitDiff(current, 0);
		} else if (event.key === "F2") {
			const commit = log.commits.find((each) => each.hash === current);
			if (commit) void editMessageDialog(commit);
		} else if (event.ctrlKey && event.altKey && event.shiftKey && event.key.toLowerCase() === "c") {
			void copyText([...logSelected].join(" "));
		}
	}

	function commitSides(commitDetail, file) {
		const parent = commitDetail.parents[0] ?? null;
		return {
			path: file.path,
			oldPath: file.oldPath,
			kind: file.kind,
			left: file.kind === "added" || parent === null ? { empty: true } : { ref: parent, path: file.oldPath ?? file.path },
			right: file.kind === "deleted" ? { empty: true } : { ref: commitDetail.hash, path: file.path },
			leftLabel: parent ? parent.slice(0, 8) : t("(none)"),
			rightLabel: commitDetail.hash.slice(0, 8),
		};
	}

	async function openCommitDiff(hash, at) {
		try {
			const info = detail?.hash === hash ? detail : await call("commit.detail", { root, hash });
			if (info.files.length === 0) return notice(t("The commit changes no files."));
			await call("openDiff", {
				root,
				files: info.files.map((file) => commitSides(info, file)),
				index: at,
				key: `commit:${root}:${hash}`,
				title: `${hash.slice(0, 8)} ${info.message.split("\n")[0].slice(0, 40)}`,
			});
		} catch (error) {
			notice(errorText(error), "error");
		}
	}

	function renderDetail() {
		if (detailBox === null) return;
		if (detail === null) {
			fill(detailBox, 
				el("div", { class: "k-empty", text: logSelected.size > 1 ? t("{0} commits selected", logSelected.size) : t("Select a commit to see its changes.") }),
			);
			return;
		}
		const files = el(
			"div",
			{ class: "gp-detail-files", role: "tree" },
			detail.files.map((file, at) => {
				const { name, folder } = splitPath(file.path);
				return el(
					"div",
					{
						class: `gp-file ${file.kind}`,
						role: "treeitem",
						tabindex: "-1",
						title: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
						ondblclick: () => void openCommitDiff(detail.hash, at),
						onkeydown: (event) => event.key === "Enter" && void openCommitDiff(detail.hash, at),
						oncontextmenu: (event) =>
							menuAt(event, [
								{ label: t("Show Diff"), icon: "diff", run: () => void openCommitDiff(detail.hash, at) },
								{
									label: t("Compare with Local"),
									run: () =>
										void call("openDiff", {
											root,
											files: [{ ...commitSides(detail, file), left: { ref: detail.hash, path: file.path }, right: { worktree: true, path: file.path }, leftLabel: detail.hash.slice(0, 8), rightLabel: t("Your version") }],
											index: 0,
											key: `local-vs:${root}:${detail.hash}:${file.path}`,
											title: t("{0} vs local", name),
										}),
								},
								{ label: t("Show History for File"), run: () => showFileHistory(file.path) },
								{ label: t("Copy Path"), run: () => void copyText(file.path) },
							]),
					},
					[fileIcon(file.kind), el("span", { class: "gp-file-name", text: name }), el("span", { class: "gp-file-folder", text: folder })],
				);
			}),
		);
		const [subject, ...rest] = detail.message.split("\n");
		fill(detailBox, 
			files,
			el("div", { class: "gp-detail-info" }, [
				el("div", { class: "gp-detail-subject", text: subject }),
				rest.join("\n").trim() ? el("pre", { class: "gp-detail-body", text: rest.join("\n").trim() }) : null,
				el("div", { class: "gp-detail-meta" }, [
					el("span", { class: "k-mono gp-hash", text: detail.hash.slice(0, 10), title: detail.hash }),
					el("span", { text: `${detail.author} <${detail.email}>` }),
					el("span", { class: "k-muted", text: dateTime(detail.time, kalem.language) }),
					detail.committer !== detail.author ? el("span", { class: "k-muted", text: t("committed by {0}", detail.committer) }) : null,
				]),
				detail.refs.length > 0 ? el("div", { class: "gp-detail-refs" }, detail.refs.map(refBadge)) : null,
				detail.branches.length > 0
					? el("div", { class: "k-muted gp-small", text: t("In {0} branches: {1}", detail.branches.length, detail.branches.join(", ")) })
					: null,
			]),
		);
	}

	function showFileHistory(path) {
		logFilter = { ...logFilter, branch: "HEAD", path };
		logSelected.clear();
		detail = null;
		log.key = "";
		void switchTab("log");
	}

	async function ensureBranches() {
		if (branchesCache !== null) return branchesCache;
		try {
			branchesCache = await call("branches", { root });
		} catch {
			branchesCache = null;
		}
		return branchesCache;
	}

	async function commitMenu(commit, x, y) {
		const hashes = log.commits.filter((each) => logSelected.has(each.hash)).map((each) => each.hash);
		const one = hashes.length === 1;
		const isHead = commit.hash === state.head;
		const [inHead, outgoing] = await Promise.all([
			call("isAncestor", { root, hash: commit.hash }).catch(() => false),
			call("outgoing", { root }).catch(() => ({ commits: [] })),
		]);
		const unpushed = outgoing.commits.some((each) => each.hash === commit.hash);
		const rewritable = one && inHead && commit.parents.length <= 1 && state.operation === null;
		const pushedWarning = unpushed ? "" : t("This commit was already pushed: changing it needs a force push afterwards.");
		const rewrite = (label, work) => async () => {
			if (!unpushed) {
				const answer = await dialog({ title: label, text: pushedWarning, ok: t("Continue"), cancel: t("Cancel"), danger: true });
				if (answer === null) return;
			}
			await run(label, work);
			await reloadLog();
		};
		const chosenPaths = state.files.filter((file) => checked.has(file.path) && file.kind !== "conflict").map((file) => file.path);
		const branchItems = commit.refs
			.filter((ref) => ref.kind === "branch" || ref.kind === "remote" || ref.kind === "head")
			.map((ref) => ({ label: ref.name, icon: "branch", items: branchActions(ref.kind === "remote" ? { name: ref.name, remote: true } : { name: ref.name, current: ref.kind === "head" }) }));
		showMenu(
			[
				{ label: t("Copy Revision Number"), icon: "copy", shortcut: "Ctrl+Alt+Shift+C", run: () => void copyText(hashes.join(" ")) },
				{ label: t("Create Patch…"), run: () => void run(t("Create Patch…"), async () => {
					const written = await call("createPatch", { root, hashes });
					if (written?.length) notice(t("Saved {0}", written.join(", ")), "ok");
				}, { refresh: false, quiet: true }) },
				{ label: t("Cherry-Pick"), icon: "commit", disabled: inHead && one, run: () => void run(t("Cherry-Pick"), () => call("cherryPick", { root, hashes: [...hashes].reverse() })) },
				null,
				{ label: t("Checkout Revision"), disabled: !one, run: () => void confirmThen(t("Check out {0}? You will be on no branch (detached HEAD).", commit.hash.slice(0, 8)), t("Checkout"), () => call("checkoutRevision", { root, ref: commit.hash }), { danger: false, label: t("Checkout Revision") }) },
				{
					label: t("Compare with Local"),
					disabled: !one,
					run: async () => {
						const files = await call("compareWithLocal", { root, hash: commit.hash }).catch(() => []);
						if (files.length === 0) return notice(t("The working tree is the same as {0}.", commit.hash.slice(0, 8)));
						await call("openDiff", {
							root,
							files: files.map((file) => ({
								path: file.path,
								oldPath: file.oldPath,
								kind: file.kind,
								left: file.kind === "added" ? { empty: true } : { ref: commit.hash, path: file.oldPath ?? file.path },
								right: file.kind === "deleted" ? { empty: true } : { worktree: true, path: file.path },
								leftLabel: commit.hash.slice(0, 8),
								rightLabel: t("Your version"),
							})),
							index: 0,
							key: `compare:${root}:${commit.hash}`,
							title: t("{0} vs local", commit.hash.slice(0, 8)),
						});
					},
				},
				null,
				{ label: t("Reset Current Branch to Here…"), icon: "undo", disabled: !one, run: () => void resetDialog(commit) },
				{ label: t("Revert Commit"), disabled: commit.parents.length > 1, run: () => void run(t("Revert Commit"), () => call("revert", { root, hashes })) },
				{
					label: t("Undo Commit…"),
					disabled: !(isHead && one && commit.parents.length <= 1),
					run: rewrite(t("Undo Commit"), () => call("undoCommit", { root })),
				},
				null,
				{ label: t("Edit Commit Message…"), shortcut: "F2", disabled: !rewritable, run: () => void editMessageDialog(commit, unpushed) },
				{
					label: t("Fixup…"),
					disabled: !rewritable || chosenPaths.length === 0,
					run: rewrite(t("Fixup"), () => call("fixup", { root, hash: commit.hash, paths: chosenPaths })),
				},
				{
					label: t("Squash Into…"),
					disabled: !rewritable || chosenPaths.length === 0,
					run: rewrite(t("Squash Into"), () => call("fixup", { root, hash: commit.hash, paths: chosenPaths, squash: true })),
				},
				{
					label: t("Drop Commit"),
					danger: true,
					disabled: !rewritable,
					run: async () => {
						const answer = await dialog({ title: t("Drop Commit"), text: `${t("Drop {0} ({1}) from the branch's history?", commit.hash.slice(0, 8), commit.subject)}${unpushed ? "" : `\n\n${pushedWarning}`}`, ok: t("Drop"), cancel: t("Cancel"), danger: true });
						if (answer === null) return;
						await run(t("Drop Commit"), () => call("dropCommit", { root, hash: commit.hash }));
						await reloadLog();
					},
				},
				{
					label: t("Push All up to Here…"),
					icon: "push",
					disabled: !(one && inHead && unpushed),
					run: () => void confirmThen(t("Push the commits up to {0}?", commit.hash.slice(0, 8)), t("Push"), () => call("push", { root, upTo: commit.hash }), { danger: false }),
				},
				null,
				...(branchItems.length > 0 ? [{ label: t("Branches"), icon: "branch", items: branchItems }] : []),
				{ label: t("New Branch…"), icon: "branch", disabled: !one, run: () => void newBranchDialog(commit.hash) },
				{ label: t("New Tag…"), icon: "tag", disabled: !one, run: () => void tagDialog(commit.hash) },
				null,
				{ label: t("Go to Child Commit"), shortcut: "←", disabled: !childOf(commit.hash), run: () => moveTo(childOf(commit.hash)) },
				{ label: t("Go to Parent Commit"), shortcut: "→", disabled: !commit.parents[0], run: () => moveTo(commit.parents[0]) },
			],
			x,
			y,
		);
	}

	async function editMessageDialog(commit, unpushed = true) {
		const full = detail?.hash === commit.hash ? detail.message : (await call("commit.detail", { root, hash: commit.hash }).catch(() => ({ message: commit.subject }))).message;
		const answer = await dialog({
			title: t("Edit Commit Message"),
			text: unpushed ? "" : t("This commit was already pushed: changing it needs a force push afterwards."),
			fields: [{ key: "message", label: `${commit.hash.slice(0, 8)}`, value: full, multiline: true }],
			ok: t("OK"),
			cancel: t("Cancel"),
			check: (values) => (values.message === "" ? t("Write a commit message.") : null),
		});
		if (answer === null) return;
		await run(t("Edit Commit Message"), () => call("editMessage", { root, hash: commit.hash, message: answer.message }));
		await reloadLog();
	}

	async function resetDialog(commit) {
		const answer = await dialog({
			title: t("Git Reset"),
			text: t("Reset {0} to {1} ({2})", state.branch ?? "HEAD", commit.hash.slice(0, 8), commit.subject),
			fields: [
				{
					key: "mode",
					type: "select",
					label: t("Reset type"),
					value: "mixed",
					options: [
						{ value: "soft", label: t("Soft: files and staged changes are kept") },
						{ value: "mixed", label: t("Mixed: files are kept, nothing is staged") },
						{ value: "hard", label: t("Hard: every change is thrown away") },
						{ value: "keep", label: t("Keep: local changes are kept, the others go") },
					],
				},
			],
			ok: t("Reset"),
			cancel: t("Cancel"),
			danger: true,
		});
		if (answer === null) return;
		await run(t("Git Reset"), () => call("reset", { root, hash: commit.hash, mode: answer.mode }));
		await reloadLog();
	}

	async function newBranchDialog(from = null) {
		const answer = await dialog({
			title: from ? t("Create Branch from {0}", from.length === 40 ? from.slice(0, 8) : from) : t("Create New Branch"),
			fields: [
				{ key: "name", label: t("New branch name") },
				{ key: "checkout", type: "checkbox", label: t("Checkout branch"), value: true },
			],
			ok: t("Create"),
			cancel: t("Cancel"),
			check: (values) => (values.name === "" ? t("Give the branch a name.") : /\s/.test(values.name) ? t("Not a valid branch name: {0}", values.name) : null),
		});
		if (answer === null) return;
		await run(t("Create Branch"), () => call("newBranch", { root, name: answer.name, from, checkout: answer.checkout }));
	}

	async function tagDialog(at) {
		const answer = await dialog({
			title: t("Create Tag"),
			fields: [
				{ key: "name", label: t("Tag name") },
				{ key: "message", label: t("Message (an annotated tag)"), multiline: true },
			],
			ok: t("Create"),
			cancel: t("Cancel"),
			check: (values) => (values.name === "" ? t("Give the tag a name.") : null),
		});
		if (answer === null) return;
		await run(t("Create Tag"), () => call("tag", { root, name: answer.name, at, message: answer.message }));
		await reloadLog();
	}

	// --- Branches ---------------------------------------------------------------------------------

	function branchActions(branch) {
		const current = state.branch ?? "HEAD";
		const items = [];
		if (branch.tag) {
			items.push(
				{ label: t("Checkout"), run: () => void run(t("Checkout"), () => call("checkoutRevision", { root, ref: `refs/tags/${branch.name}` })) },
				{ label: t("Merge into '{0}'", current), run: () => void run(t("Merge"), () => call("merge", { root, name: branch.name })) },
				{ label: t("Show in Log"), run: () => showInLog(branch.name) },
				null,
				{ label: t("Delete"), danger: true, run: () => void confirmThen(t("Delete the tag {0}?", branch.name), t("Delete"), () => call("deleteTag", { root, name: branch.name })) },
			);
			return items;
		}
		if (!branch.current) {
			items.push({
				label: t("Checkout"),
				run: () =>
					void run(t("Checkout {0}", branch.name), () => call("checkout", { root, name: branch.name, remote: branch.remote }), {
						retry: () => call("checkout", { root, name: branch.name, remote: branch.remote, smart: true }),
					}),
			});
		}
		items.push({ label: t("New Branch from '{0}'…", branch.name), run: () => void newBranchDialog(branch.name) });
		if (!branch.current && !branch.remote) {
			items.push({
				label: t("Checkout and Rebase onto '{0}'", current),
				run: () => void run(t("Rebase"), () => call("checkoutAndRebase", { root, name: branch.name, onto: current })),
			});
		}
		if (!branch.current) {
			items.push(
				null,
				{ label: t("Compare with '{0}'", current), run: () => showInLog(`${current}...${branch.name}`) },
				{ label: t("Show in Log"), run: () => showInLog(branch.name) },
				null,
				{
					label: t("Rebase '{0}' onto '{1}'", current, branch.name),
					run: () => void run(t("Rebase"), () => call("rebaseOnto", { root, name: branch.name })),
				},
				{
					label: t("Merge '{0}' into '{1}'", branch.name, current),
					run: () => void run(t("Merge"), () => call("merge", { root, name: branch.name })),
				},
			);
		} else {
			items.push({ label: t("Show in Log"), run: () => showInLog("HEAD") });
		}
		if (!branch.remote) {
			items.push(
				null,
				{ label: t("Push…"), icon: "push", run: () => (branch.current ? void pushDialog() : void run(t("Push"), () => call("pushBranch", { root, name: branch.name }))) },
				{
					label: t("Rename…"),
					run: async () => {
						const answer = await dialog({ title: t("Rename Branch"), fields: [{ key: "to", label: t("New name"), value: branch.name }], ok: t("Rename"), cancel: t("Cancel") });
						if (answer === null || answer.to === "" || answer.to === branch.name) return;
						await run(t("Rename Branch"), () => call("renameBranch", { root, name: branch.name, to: answer.to }));
					},
				},
			);
		}
		if (!branch.current) {
			items.push({
				label: t("Delete"),
				danger: true,
				run: async () => {
					const answer = await dialog({
						title: t("Delete Branch"),
						text: branch.remote ? t("Delete the branch {0} on the remote?", branch.name) : t("Delete the branch {0}?", branch.name),
						fields: branch.remote ? [] : [{ key: "force", type: "checkbox", label: t("Delete even when it is not merged"), value: false }],
						ok: t("Delete"),
						cancel: t("Cancel"),
						danger: true,
					});
					if (answer === null) return;
					await run(t("Delete Branch"), () => call("deleteBranch", { root, name: branch.name, force: answer.force, remote: branch.remote }));
					branchesCache = null;
				},
			});
		}
		return items;
	}

	function showInLog(ref) {
		logFilter = { ...logFilter, branch: ref, path: "" };
		logSelected.clear();
		detail = null;
		log.key = "";
		void switchTab("log");
	}

	let popover = null;

	async function branchPopup(anchorElement) {
		popover?.remove();
		branchesCache = null;
		const list = await ensureBranches();
		if (list === null) return;
		const search = el("input", { class: "k-input", type: "search", placeholder: t("Search branches and actions"), "aria-label": t("Search branches") });
		const items = el("div", { class: "gp-pop-items", role: "menu" });
		const box = el("div", { class: "gp-popover", role: "dialog", "aria-label": t("Branches") }, [search, items]);
		const close = () => {
			box.remove();
			popover = null;
			document.removeEventListener("pointerdown", outside, true);
		};
		const outside = (event) => {
			if (!box.contains(event.target) && !document.querySelector(".g-menu")?.contains(event.target)) close();
		};
		const entry = (label, iconName, onClick, extra = {}) => {
			const button = el(
				"button",
				{ class: `gp-pop-item${extra.current ? " current" : ""}`, type: "button", role: "menuitem", title: extra.title },
				[
					el("span", { class: "g-menu-icon" }, [iconName ? icon(iconName) : null]),
					el("span", { class: "gp-pop-label", text: label }),
					extra.note ? el("span", { class: "k-muted gp-pop-note", text: extra.note }) : null,
					extra.more ? el("span", { class: "gp-pop-more", text: "›" }) : null,
				],
			);
			button.addEventListener("click", (event) => onClick(button, event));
			return button;
		};
		const listItems = () => {
			const query = search.value.trim().toLocaleLowerCase(kalem.language);
			const match = (text) => query === "" || text.toLocaleLowerCase(kalem.language).includes(query);
			const out = [];
			const actions = [
				[t("Update Project…"), "pull", () => void updateProject()],
				[t("Commit…"), "commit", () => switchTab("changes")],
				[t("Push…"), "push", () => void pushDialog()],
				[t("New Branch…"), "plus", () => void newBranchDialog()],
				[
					t("Checkout Tag or Revision…"),
					null,
					async () => {
						const answer = await dialog({ title: t("Checkout Tag or Revision"), fields: [{ key: "ref", label: t("Tag, branch or commit") }], ok: t("Checkout"), cancel: t("Cancel") });
						if (answer?.ref) await run(t("Checkout"), () => call("checkoutRevision", { root, ref: answer.ref }));
					},
				],
			].filter(([label]) => match(label));
			for (const [label, iconName, work] of actions) {
				out.push(
					entry(label, iconName, () => {
						close();
						work();
					}),
				);
			}
			const section = (title, branches, kind) => {
				const shown = branches.filter((branch) => match(branch.name));
				if (shown.length === 0) return;
				out.push(el("div", { class: "g-menu-heading", text: title }));
				for (const branch of shown) {
					const note = kind === "local" ? [branch.ahead ? `↑${branch.ahead}` : "", branch.behind ? `↓${branch.behind}` : "", branch.upstream ? branch.upstream : ""].filter(Boolean).join(" ") : "";
					out.push(
						entry(branch.name, kind === "tag" ? "tag" : "branch", (button) => {
							const rect = button.getBoundingClientRect();
							const menu = showMenu(
								branchActions({ name: branch.name, current: branch.current, remote: kind === "remote", tag: kind === "tag" }).map((item) =>
									item === null ? null : { ...item, run: () => { close(); item.run(); } },
								),
								rect.right,
								rect.top,
							);
							menu.classList.add("g-menu-branch");
						}, { current: branch.current, note, more: true, title: branch.subject }),
					);
				}
			};
			const local = [...list.local].sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || b.time - a.time);
			section(t("Local"), local, "local");
			section(t("Remote"), list.remote, "remote");
			if (query !== "" || list.tags.length <= 20) section(t("Tags"), list.tags, "tag");
			fill(items, ...out);
		};
		search.addEventListener("input", listItems);
		box.addEventListener("keydown", (event) => {
			if (event.key === "Escape") close();
			const buttons = [...items.querySelectorAll(".gp-pop-item")];
			const at = buttons.indexOf(document.activeElement);
			if (event.key === "ArrowDown") {
				event.preventDefault();
				buttons[Math.min(buttons.length - 1, at + 1)]?.focus();
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				if (at <= 0) search.focus();
				else buttons[at - 1]?.focus();
			} else if (event.key === "Enter" && document.activeElement === search) {
				buttons[0]?.click();
			}
		});
		listItems();
		document.body.append(box);
		const rect = anchorElement.getBoundingClientRect();
		box.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - box.offsetWidth - 4))}px`;
		box.style.top = `${rect.bottom + 2}px`;
		box.style.maxHeight = `${Math.max(160, window.innerHeight - rect.bottom - 10)}px`;
		popover = box;
		setTimeout(() => document.addEventListener("pointerdown", outside, true));
		search.focus();
	}

	// --- Console -------------------------------------------------------------------------------

	let consoleBody = null;

	function consoleEntry(entry) {
		return el("div", { class: `gp-console-entry${entry.code === 0 ? "" : " failed"}` }, [
			el("div", { class: "gp-console-command" }, [
				el("span", { class: "k-muted", text: new Date(entry.time).toLocaleTimeString(kalem.language) }),
				el("span", { class: "gp-console-text", text: entry.command }),
				el("span", { class: "k-muted", text: `${entry.ms} ms${entry.code === 0 ? "" : ` · ${t("exit code {0}", entry.code ?? "—")}`}` }),
			]),
			entry.output ? el("pre", { class: "gp-console-output", text: entry.output }) : null,
		]);
	}

	function renderConsole() {
		consoleBody = el("div", { class: "gp-scroll gp-console", role: "log" }, consoleEntries.filter((entry) => !root || entry.root === root || !repos.length).map(consoleEntry));
		if (consoleEntries.length === 0) consoleBody.append(el("div", { class: "k-empty", text: t("The git commands run here show up in this console.") }));
		requestAnimationFrame(() => {
			if (consoleBody) consoleBody.scrollTop = consoleBody.scrollHeight;
		});
		return el("div", { class: "gp-changes" }, [
			el("div", { class: "k-toolbar gp-subtools" }, [
				el("span", { class: "k-muted gp-small", text: t("Commands that change something, and every one that failed.") }),
				el("span", { class: "k-spacer" }),
				tool("eraser", t("Clear"), async () => {
					consoleEntries = await call("clearConsole");
					render();
				}),
			]),
			consoleBody,
		]);
	}

	// --- Messages and the clock -----------------------------------------------------------------

	kalem.onMessage((data) => {
		if (data?.type === "console") {
			consoleEntries.push(data.entry);
			if (consoleEntries.length > 300) consoleEntries.splice(0, consoleEntries.length - 300);
			if (tab === "console" && consoleBody?.isConnected && (!root || data.entry.root === root)) {
				consoleBody.querySelector(".k-empty")?.remove();
				consoleBody.append(consoleEntry(data.entry));
				consoleBody.scrollTop = consoleBody.scrollHeight;
			}
		} else if (data?.type === "focus") {
			void switchTab(data.tab);
			if (data.tab === "changes") requestAnimationFrame(() => content.querySelector(".gp-message")?.focus());
		} else if (data?.type === "clone") {
			void cloneDialog();
		} else if (data?.type === "fetched") {
			void refreshAll();
		}
	});
	kalem.onSettingsChanged(() => void refreshAll());

	let quietTimer = 0;
	const poll = async () => {
		clearTimeout(quietTimer);
		const seconds = Number(settings.refreshSeconds) || 5;
		if (busy === null && document.visibilityState === "visible" && !document.querySelector(".g-overlay, .g-menu, .gp-popover")) {
			const before = JSON.stringify(state);
			await refreshStatus();
			const typing = document.activeElement?.matches?.("textarea, input[type=search], input[type=text]");
			if (JSON.stringify(state) !== before && !typing) {
				if (tab === "changes" || tab === "console") render();
				else renderHeader();
			}
		}
		quietTimer = setTimeout(poll, Math.max(2, seconds) * 1000);
	};
	window.addEventListener("focus", () => void poll());

	content.append(el("div", { class: "k-empty", text: t("Loading…") }));
	void refreshAll().then(() => {
		if (tab === "log") void reloadLog();
		quietTimer = setTimeout(poll, 3000);
	});
}
