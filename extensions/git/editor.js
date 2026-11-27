/** The diff as a tab in the documents' place: two versions side by side, as IntelliJ shows them. */
import { compare, revertBlock, wordDiff } from "./diff.js";
import { el, fill, icon } from "./dom.js";
import { errorText, KIND_LETTER, notice, splitPath } from "./widgets.js";

const CONTEXT = 4;
const AUTO_COLLAPSE_ROWS = 3000;
const VIEW_KEY = "kalem.git.diff.view";

const readView = () => {
	try {
		return { mode: "side", ignoreSpace: false, collapse: false, ...JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") };
	} catch {
		return { mode: "side", ignoreSpace: false, collapse: false };
	}
};

export function startEditor(kalem, t, app) {
	let data = null;
	let index = 0;
	let view = readView();
	let result = null;
	let sides = null;
	let current = -1;
	let expanded = new Set();
	let loading = 0;

	const saveView = () => {
		try {
			localStorage.setItem(VIEW_KEY, JSON.stringify(view));
		} catch {}
	};

	const toolbar = el("div", { class: "k-toolbar gd-toolbar" });
	const header = el("div", { class: "gd-header" });
	const body = el("div", { class: "gd-body", tabindex: "0" });
	const footer = el("div", { class: "k-statusline gd-status" });
	app.classList.add("gd");
	fill(app, toolbar, header, body, footer);

	const file = () => data?.files?.[index] ?? null;

	async function fetchSide(side) {
		if (side === null || side === undefined || side.empty) return { text: "", missing: true };
		if (side.shelf) return kalem.call("shelfContent", { root: data.root, id: side.shelf, path: side.path });
		return kalem.call("content", { root: data.root, side });
	}

	async function load(first = false) {
		const wanted = file();
		if (wanted === null) return;
		const ticket = ++loading;
		renderToolbar();
		try {
			const [left, right] = await Promise.all([fetchSide(wanted.left), fetchSide(wanted.right)]);
			if (ticket !== loading) return;
			sides = { left, right };
			result = compare(left.text, right.text, { ignoreSpace: view.ignoreSpace });
			if (first && result.rows.length > AUTO_COLLAPSE_ROWS) view = { ...view, collapse: true };
			current = -1;
			render();
			if (result.blocks.length > 0) go(0, false);
		} catch (error) {
			if (ticket !== loading) return;
			result = null;
			fill(body, el("div", { class: "k-empty", text: errorText(error) }));
		}
	}

	const button = (iconName, title, onclick, { pressed, disabled, text } = {}) =>
		el(
			"button",
			{
				class: `k-button small ghost${text ? "" : " icon"}`,
				type: "button",
				title,
				"aria-label": title,
				"aria-pressed": pressed === undefined ? undefined : String(pressed),
				disabled: disabled ? true : undefined,
				onclick,
			},
			[icon(iconName), text ? el("span", { text }) : null],
		);

	function renderToolbar() {
		const files = data?.files ?? [];
		const blocks = result?.blocks.length ?? 0;
		const picker = el(
			"select",
			{ class: "k-select gd-files", "aria-label": t("Files"), onchange: (event) => openFile(Number(event.target.value)) },
			files.map((each, at) =>
				el("option", { value: String(at), text: `${KIND_LETTER[each.kind] ?? "M"}  ${each.path}`, selected: at === index ? true : undefined }),
			),
		);
		fill(toolbar, 
			button("arrowUp", t("Previous Difference (Shift+F7)"), () => go(current - 1), { disabled: blocks === 0 }),
			button("arrowDown", t("Next Difference (F7)"), () => go(current + 1), { disabled: blocks === 0 }),
			el("span", { class: "gd-sep" }),
			button("arrowLeft", t("Previous File (Alt+Left)"), () => openFile(index - 1), { disabled: index <= 0 }),
			el("span", { class: "gd-count", text: t("{0}/{1} files", index + 1, files.length) }),
			button("arrowRight", t("Next File (Alt+Right)"), () => openFile(index + 1), { disabled: index >= files.length - 1 }),
			files.length > 1 ? picker : null,
			el("span", { class: "gd-sep" }),
			el("div", { class: "k-segmented", role: "group", "aria-label": t("Viewer") }, [
				button("split", t("Side-by-side viewer"), () => setView({ mode: "side" }), { pressed: view.mode === "side", text: t("Side-by-side") }),
				button("lines", t("Unified viewer"), () => setView({ mode: "unified" }), { pressed: view.mode === "unified", text: t("Unified") }),
			]),
			button("space", t("Ignore whitespace"), () => setView({ ignoreSpace: !view.ignoreSpace }, true), { pressed: view.ignoreSpace }),
			button("collapse", t("Collapse unchanged fragments"), () => setView({ collapse: !view.collapse }), { pressed: view.collapse }),
			el("span", { class: "k-spacer" }),
			button("refresh", t("Refresh"), () => void load()),
		);
	}

	function setView(change, recompute = false) {
		view = { ...view, ...change };
		saveView();
		if (recompute) void load();
		else render();
	}

	function openFile(at) {
		if (data === null || at < 0 || at >= data.files.length) return;
		index = at;
		expanded = new Set();
		void load();
	}

	function sideLabel(side, label) {
		const fallback = side?.worktree
			? t("Your version")
			: side?.index
				? t("Staged")
				: side?.empty
					? t("(none)")
					: side?.shelf
						? t("Shelved version")
						: side?.ref
							? String(side.ref).slice(0, 12)
							: "";
		return label || fallback;
	}

	function render() {
		renderToolbar();
		const wanted = file();
		if (wanted === null || result === null) return;
		const { name, folder } = splitPath(wanted.path);
		header.className = `gd-header ${view.mode}`;
		fill(header, 
			el("div", { class: "gd-head-side" }, [
				el("span", { class: "gd-head-label", text: sideLabel(wanted.left, wanted.leftLabel) }),
				el("span", { class: "gd-head-path", text: wanted.oldPath ?? wanted.path, title: wanted.oldPath ?? wanted.path }),
			]),
			view.mode === "side"
				? el("div", { class: "gd-head-side" }, [
						el("span", { class: "gd-head-label", text: sideLabel(wanted.right, wanted.rightLabel) }),
						el("span", { class: "gd-head-path", text: folder ? `${name} · ${folder}` : name, title: wanted.path }),
					])
				: el("div", { class: "gd-head-side" }, [el("span", { class: "gd-head-label", text: `→ ${sideLabel(wanted.right, wanted.rightLabel)}` })]),
		);

		const special = [sides.left, sides.right].find((side) => side.binary || side.tooLarge);
		if (special !== undefined) {
			fill(body, 
				el("div", { class: "k-empty", text: special.binary ? t("Binary files differ.") : t("The file is too large to compare.") }),
			);
			footer.textContent = "";
			return;
		}
		const rows = view.mode === "side" ? sideRows() : unifiedRows();
		body.className = `gd-body ${view.mode}`;
		fill(body, ...rows);
		const count = result.blocks.length;
		fill(footer, 
			el("span", {
				text:
					count === 0
						? view.ignoreSpace
							? t("Contents differ only in whitespace.")
							: sides.left.missing && sides.right.missing
								? t("Both versions are empty.")
								: t("Contents are identical.")
						: t("{0} differences", count),
			}),
			sides.left.missing && !sides.right.missing ? el("span", { class: "k-badge ok", text: t("New file") }) : null,
			sides.right.missing && !sides.left.missing ? el("span", { class: "k-badge error", text: t("Deleted") }) : null,
		);
		if (current >= 0) mark(current);
	}

	/** Which rows show: all, or the changes with a few lines around them. */
	function shown() {
		const total = result.rows.length;
		if (!view.collapse || total === 0) return [{ from: 0, to: total }];
		const keep = new Uint8Array(total);
		for (const block of result.blocks) {
			for (let i = Math.max(0, block.start - CONTEXT); i < Math.min(total, block.end + CONTEXT); i++) keep[i] = 1;
		}
		const parts = [];
		let i = 0;
		while (i < total) {
			const on = keep[i] === 1;
			let j = i;
			while (j < total && (keep[j] === 1) === on) j++;
			if (on || expanded.has(i) || j - i < 3) parts.push({ from: i, to: j });
			else parts.push({ from: i, to: j, folded: true });
			i = j;
		}
		return parts;
	}

	function foldRow(part) {
		return el(
			"button",
			{
				class: "gd-fold",
				type: "button",
				onclick: () => {
					expanded.add(part.from);
					render();
				},
			},
			[icon("expand"), el("span", { text: t("{0} unchanged lines", part.to - part.from) })],
		);
	}

	const blockAt = new Map();

	function code(text, parts, side) {
		const cell = el("div", { class: `gd-code ${side}` });
		if (parts === null) cell.textContent = text === "" ? " " : text;
		else
			cell.append(
				...parts.map((part) => (part.changed ? el("span", { class: "gd-word", text: part.text }) : document.createTextNode(part.text))),
			);
		return cell;
	}

	function sideRows() {
		blockAt.clear();
		result.blocks.forEach((block, at) => blockAt.set(block.start, at));
		const out = [];
		for (const part of shown()) {
			if (part.folded) {
				out.push(foldRow(part));
				continue;
			}
			for (let r = part.from; r < part.to; r++) {
				const row = result.rows[r];
				const left = row.left === null ? null : result.left.lines[row.left];
				const right = row.right === null ? null : result.right.lines[row.right];
				const words = row.kind === "change" && left !== null && right !== null ? wordDiff(left, right) : null;
				const block = blockAt.get(r);
				const gutter = el("div", { class: "gd-gutter" });
				if (block !== undefined && data.editable && file()?.right?.worktree) {
					gutter.append(
						el(
							"button",
							{
								class: "gd-revert",
								type: "button",
								title: t("Revert this change"),
								"aria-label": t("Revert this change"),
								onclick: () => void revert(block),
							},
							[icon("arrowRight")],
						),
					);
				}
				out.push(
					el("div", { class: `gd-row ${row.kind}`, "data-row": String(r), "data-block": block === undefined ? undefined : String(block) }, [
						el("div", { class: "gd-num", text: row.left === null ? "" : String(row.left + 1) }),
						left === null ? el("div", { class: "gd-code left filler" }) : code(left, words?.left ?? null, "left"),
						gutter,
						el("div", { class: "gd-num", text: row.right === null ? "" : String(row.right + 1) }),
						right === null ? el("div", { class: "gd-code right filler" }) : code(right, words?.right ?? null, "right"),
					]),
				);
			}
		}
		return out;
	}

	function unifiedRows() {
		blockAt.clear();
		result.blocks.forEach((block, at) => blockAt.set(block.start, at));
		const out = [];
		for (const part of shown()) {
			if (part.folded) {
				out.push(foldRow(part));
				continue;
			}
			let r = part.from;
			while (r < part.to) {
				const row = result.rows[r];
				if (row.kind === "equal") {
					out.push(
						el("div", { class: "gd-row equal", "data-row": String(r) }, [
							el("div", { class: "gd-num", text: String(row.left + 1) }),
							el("div", { class: "gd-num", text: String(row.right + 1) }),
							el("div", { class: "gd-sign", text: " " }),
							code(result.left.lines[row.left], null, "left"),
						]),
					);
					r++;
					continue;
				}
				const blockIndex = blockAt.get(r);
				const block = result.blocks[blockIndex];
				const end = block?.end ?? r + 1;
				const pairs = [];
				for (let i = r; i < end; i++) pairs.push(result.rows[i]);
				const first = out.length;
				for (const each of pairs) {
					if (each.left === null) continue;
					const words =
						each.kind === "change" && each.right !== null ? wordDiff(result.left.lines[each.left], result.right.lines[each.right]) : null;
					out.push(
						el("div", { class: "gd-row removed" }, [
							el("div", { class: "gd-num", text: String(each.left + 1) }),
							el("div", { class: "gd-num" }),
							el("div", { class: "gd-sign", text: "−" }),
							code(result.left.lines[each.left], words?.left ?? null, "left"),
						]),
					);
				}
				for (const each of pairs) {
					if (each.right === null) continue;
					const words =
						each.kind === "change" && each.left !== null ? wordDiff(result.left.lines[each.left], result.right.lines[each.right]) : null;
					out.push(
						el("div", { class: "gd-row added" }, [
							el("div", { class: "gd-num" }),
							el("div", { class: "gd-num", text: String(each.right + 1) }),
							el("div", { class: "gd-sign", text: "+" }),
							code(result.right.lines[each.right], words?.right ?? null, "right"),
						]),
					);
				}
				if (out[first] !== undefined && blockIndex !== undefined) out[first].dataset.block = String(blockIndex);
				r = end;
			}
		}
		return out;
	}

	function mark(at) {
		for (const row of body.querySelectorAll(".gd-current")) row.classList.remove("gd-current");
		const block = result?.blocks[at];
		if (block === undefined) return;
		const first = body.querySelector(`[data-block="${at}"]`);
		if (view.mode === "side") {
			for (let r = block.start; r < block.end; r++) body.querySelector(`[data-row="${r}"]`)?.classList.add("gd-current");
		} else first?.classList.add("gd-current");
		return first;
	}

	function go(at, scroll = true) {
		if (result === null || result.blocks.length === 0) return;
		if (at < 0 || at >= result.blocks.length) {
			if (at >= result.blocks.length && index < (data?.files.length ?? 0) - 1) {
				notice(t("Last difference. Press again to go to the next file."));
				if (current === result.blocks.length) openFile(index + 1);
				current = result.blocks.length;
			}
			return;
		}
		const block = result.blocks[at];
		if (view.collapse) {
			for (const part of shown()) if (part.folded && part.from <= block.start && block.start < part.to) expanded.add(part.from);
			render();
		}
		current = at;
		const first = mark(at);
		if (scroll && first) first.scrollIntoView({ block: "center" });
		else if (!scroll && first) first.scrollIntoView({ block: "nearest" });
	}

	async function revert(at) {
		const block = result.blocks[at];
		const wanted = file();
		if (block === undefined || wanted === null) return;
		try {
			await kalem.call("writeWorktree", { root: data.root, path: wanted.right.path, text: revertBlock(result, block) });
			await load();
		} catch (error) {
			notice(errorText(error), "error");
		}
	}

	document.addEventListener("keydown", (event) => {
		if (event.key === "F7") {
			event.preventDefault();
			go(event.shiftKey ? current - 1 : current + 1);
		} else if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
			event.preventDefault();
			openFile(index + (event.key === "ArrowRight" ? 1 : -1));
		} else if ((event.ctrlKey || event.metaKey) && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
			event.preventDefault();
			go(event.key === "ArrowDown" ? current + 1 : current - 1);
		}
	});

	body.append(el("div", { class: "k-empty", text: t("Loading…") }));

	// Last: the data may already be here, and then this calls back at once.
	kalem.onEditorData((next) => {
		data = next;
		index = Math.max(0, Math.min(Number(next?.index) || 0, (next?.files?.length ?? 1) - 1));
		expanded = new Set();
		void load(true);
	});
}
