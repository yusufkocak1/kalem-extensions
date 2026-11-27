/** Comparing two texts line by line, as a side-by-side diff shows them. Pure. */

const MAX_EDITS = 4000;

/** Myers' diff of two arrays: `[{ op: "equal" | "delete" | "insert", a, b }]` runs, in order. */
export function diffSequences(a, b, same = (x, y) => x === y) {
	let start = 0;
	while (start < a.length && start < b.length && same(a[start], b[start])) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && same(a[endA - 1], b[endB - 1])) {
		endA--;
		endB--;
	}
	const middle = myers(a.slice(start, endA), b.slice(start, endB), same);
	const ops = [];
	const push = (op, count) => {
		if (count <= 0) return;
		const last = ops[ops.length - 1];
		if (last !== undefined && last.op === op) last.count += count;
		else ops.push({ op, count });
	};
	push("equal", start);
	for (const step of middle) push(step.op, step.count);
	push("equal", a.length - endA);
	let ia = 0;
	let ib = 0;
	return ops.map((step) => {
		const run = { op: step.op, a: ia, b: ib, count: step.count };
		if (step.op !== "insert") ia += step.count;
		if (step.op !== "delete") ib += step.count;
		return run;
	});
}

function myers(a, b, same) {
	const n = a.length;
	const m = b.length;
	if (n === 0) return [{ op: "insert", count: m }];
	if (m === 0) return [{ op: "delete", count: n }];
	const max = n + m;
	const offset = max;
	let v = new Int32Array(2 * max + 2);
	const trace = [];
	let found = -1;
	for (let d = 0; d <= Math.min(max, MAX_EDITS); d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x;
			if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
			else x = v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && same(a[x], b[y])) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
		if (found !== -1) break;
	}
	if (found === -1) return [{ op: "delete", count: n }, { op: "insert", count: m }];
	const steps = [];
	let x = n;
	let y = m;
	for (let d = found; d > 0; d--) {
		v = trace[d];
		const k = x - y;
		const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
		const prevX = v[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			steps.push("equal");
			x--;
			y--;
		}
		if (x === prevX) {
			steps.push("insert");
			y--;
		} else {
			steps.push("delete");
			x--;
		}
	}
	while (x > 0 && y > 0) {
		steps.push("equal");
		x--;
		y--;
	}
	steps.reverse();
	const runs = [];
	for (const op of steps) {
		const last = runs[runs.length - 1];
		if (last !== undefined && last.op === op) last.count++;
		else runs.push({ op, count: 1 });
	}
	return runs;
}

/** A text's lines without their ends, and how it ends them. */
export function splitLines(text) {
	if (text === "") return { lines: [], eol: "\n", finalNewline: false };
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const finalNewline = text.endsWith("\n");
	const lines = text.split(/\r?\n/);
	if (finalNewline) lines.pop();
	return { lines, eol, finalNewline };
}

const normalize = (line, ignoreSpace) => (ignoreSpace ? line.replace(/\s+/g, " ").trim() : line);

/**
 * Rows side by side: `{ kind: "equal" | "change" | "delete" | "insert", left, right }`
 * where `left`/`right` are line indexes or `null` (a filler), and the
 * blocks of changes (`{ start, end, leftStart, leftCount, rightStart, rightCount }`).
 */
export function compare(leftText, rightText, { ignoreSpace = false } = {}) {
	const left = splitLines(leftText);
	const right = splitLines(rightText);
	const runs = diffSequences(left.lines, right.lines, (x, y) => normalize(x, ignoreSpace) === normalize(y, ignoreSpace));
	const rows = [];
	const blocks = [];
	for (let i = 0; i < runs.length; i++) {
		const run = runs[i];
		if (run.op === "equal") {
			for (let j = 0; j < run.count; j++) rows.push({ kind: "equal", left: run.a + j, right: run.b + j });
			continue;
		}
		let deleted = { a: run.a, count: 0 };
		let inserted = { b: run.b, count: 0 };
		if (run.op === "delete") {
			deleted = { a: run.a, count: run.count };
			const next = runs[i + 1];
			if (next?.op === "insert") {
				inserted = { b: next.b, count: next.count };
				i++;
			} else inserted = { b: run.b, count: 0 };
		} else {
			inserted = { b: run.b, count: run.count };
			deleted = { a: run.a, count: 0 };
		}
		const start = rows.length;
		const kind = deleted.count > 0 && inserted.count > 0 ? "change" : deleted.count > 0 ? "delete" : "insert";
		const height = Math.max(deleted.count, inserted.count);
		for (let j = 0; j < height; j++) {
			rows.push({
				kind,
				left: j < deleted.count ? deleted.a + j : null,
				right: j < inserted.count ? inserted.b + j : null,
			});
		}
		blocks.push({
			start,
			end: rows.length,
			kind,
			leftStart: deleted.a,
			leftCount: deleted.count,
			rightStart: inserted.b,
			rightCount: inserted.count,
		});
	}
	return { left, right, rows, blocks };
}

const TOKEN = /\w+|\s+|[^\w\s]/gu;

/** The parts of two lines, each marked when it differs from the other line. */
export function wordDiff(leftLine, rightLine) {
	const a = leftLine.match(TOKEN) ?? [];
	const b = rightLine.match(TOKEN) ?? [];
	if (a.length * b.length > 250_000) {
		return { left: [{ text: leftLine, changed: true }], right: [{ text: rightLine, changed: true }] };
	}
	const runs = diffSequences(a, b);
	const left = [];
	const right = [];
	const add = (parts, text, changed) => {
		if (text === "") return;
		const last = parts[parts.length - 1];
		if (last !== undefined && last.changed === changed) last.text += text;
		else parts.push({ text, changed });
	};
	for (const run of runs) {
		if (run.op !== "insert") add(left, a.slice(run.a, run.a + run.count).join(""), run.op !== "equal");
		if (run.op !== "delete") add(right, b.slice(run.b, run.b + run.count).join(""), run.op !== "equal");
	}
	return { left, right };
}

/** The right text with one block of changes put back as the left side has it. */
export function revertBlock(result, block) {
	const lines = [...result.right.lines];
	lines.splice(block.rightStart, block.rightCount, ...result.left.lines.slice(block.leftStart, block.leftStart + block.leftCount));
	const { eol, finalNewline } = result.right.lines.length > 0 ? result.right : result.left;
	return lines.length === 0 ? "" : lines.join(eol) + (finalNewline ? eol : "");
}
