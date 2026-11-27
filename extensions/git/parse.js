/** Reading what git prints. Pure: the host code and the pane both use it. */

export const SEP = "\x1f";
export const END = "\x1e";

function kindOf(xy) {
	if (xy.includes("U") || xy === "AA" || xy === "DD") return "conflict";
	if (xy.includes("A")) return "added";
	if (xy.includes("D")) return "deleted";
	if (xy.includes("R") || xy.includes("C")) return "renamed";
	return "modified";
}

/** `git status --porcelain=v2 -z --branch --untracked-files=all` */
export function parseStatus(output) {
	const status = {
		branch: null,
		head: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		files: [],
	};
	const entries = output.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const line = entries[i];
		if (line.startsWith("# branch.oid ")) {
			const oid = line.slice(13);
			status.head = oid === "(initial)" ? null : oid;
		} else if (line.startsWith("# branch.head ")) {
			const head = line.slice(14);
			status.branch = head === "(detached)" ? null : head;
		} else if (line.startsWith("# branch.upstream ")) {
			status.upstream = line.slice(18);
		} else if (line.startsWith("# branch.ab ")) {
			const match = /\+(\d+) -(\d+)/.exec(line);
			status.ahead = Number(match?.[1] ?? 0);
			status.behind = Number(match?.[2] ?? 0);
		} else if (line.startsWith("1 ")) {
			const fields = line.split(" ");
			const xy = fields[1];
			status.files.push({
				path: fields.slice(8).join(" "),
				oldPath: null,
				kind: kindOf(xy),
				staged: xy[0] !== ".",
				unstaged: xy[1] !== ".",
			});
		} else if (line.startsWith("2 ")) {
			const fields = line.split(" ");
			const xy = fields[1];
			status.files.push({
				path: fields.slice(9).join(" "),
				oldPath: entries[i + 1] ?? null,
				kind: "renamed",
				staged: xy[0] !== ".",
				unstaged: xy[1] !== ".",
			});
			i++;
		} else if (line.startsWith("u ")) {
			status.files.push({
				path: line.split(" ").slice(10).join(" "),
				oldPath: null,
				kind: "conflict",
				staged: false,
				unstaged: true,
			});
		} else if (line.startsWith("? ")) {
			status.files.push({
				path: line.slice(2),
				oldPath: null,
				kind: "untracked",
				staged: false,
				unstaged: true,
			});
		}
	}
	return status;
}

export const LOG_FORMAT = ["%H", "%P", "%an", "%ae", "%at", "%D", "%s"].join(SEP) + END;

/** `git log --format=LOG_FORMAT` */
export function parseLog(output) {
	return output
		.split(END)
		.map((record) => record.replace(/^\n/, ""))
		.filter((record) => record.trim() !== "")
		.map((record) => {
			const [hash, parents, author, email, time, refs, subject] = record.split(SEP);
			return {
				hash,
				parents: parents ? parents.split(" ").filter(Boolean) : [],
				author,
				email,
				time: Number(time) * 1000,
				refs: parseRefs(refs ?? ""),
				subject: subject ?? "",
			};
		});
}

/** `%D`: `HEAD -> main, origin/main, tag: v1.0` */
export function parseRefs(text) {
	const refs = [];
	for (const part of text.split(", ")) {
		const name = part.trim();
		if (name === "") continue;
		if (name.startsWith("HEAD -> ")) {
			refs.push({ kind: "head", name: name.slice(8) });
		} else if (name === "HEAD") {
			refs.push({ kind: "detached", name: "HEAD" });
		} else if (name.startsWith("tag: ")) {
			refs.push({ kind: "tag", name: name.slice(5) });
		} else if (name.includes("/")) {
			refs.push({ kind: name.endsWith("/HEAD") ? "remote-head" : "remote", name });
		} else {
			refs.push({ kind: "branch", name });
		}
	}
	return refs.filter((ref) => ref.kind !== "remote-head");
}

export const DETAIL_FORMAT = ["%H", "%P", "%an", "%ae", "%at", "%cn", "%ce", "%ct", "%D", "%B"].join(
	SEP,
);

export function parseDetail(output) {
	const [hash, parents, author, email, time, committer, committerEmail, committed, refs, body] =
		output.split(SEP);
	return {
		hash,
		parents: parents ? parents.trim().split(" ").filter(Boolean) : [],
		author,
		email,
		time: Number(time) * 1000,
		committer,
		committerEmail,
		committed: Number(committed) * 1000,
		refs: parseRefs(refs ?? ""),
		message: (body ?? "").replace(/\s+$/, ""),
	};
}

const NAME_STATUS = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "added", T: "modified", U: "conflict" };

/** `--name-status -z` */
export function parseNameStatus(output) {
	const parts = output.split("\0");
	const files = [];
	for (let i = 0; i < parts.length; i++) {
		const code = parts[i];
		if (code === "" || !/^[A-Z]/.test(code)) continue;
		const letter = code[0];
		if (letter === "R" || letter === "C") {
			files.push({ kind: NAME_STATUS[letter], oldPath: parts[i + 1], path: parts[i + 2] });
			i += 2;
		} else {
			files.push({ kind: NAME_STATUS[letter] ?? "modified", oldPath: null, path: parts[i + 1] });
			i += 1;
		}
	}
	return files.filter((file) => file.path !== undefined);
}

export const BRANCH_FORMAT = [
	"%(refname)",
	"%(HEAD)",
	"%(upstream:short)",
	"%(upstream:track)",
	"%(objectname)",
	"%(committerdate:unix)",
	"%(contents:subject)",
].join(SEP);

/** `git for-each-ref --format=BRANCH_FORMAT refs/heads refs/remotes refs/tags` */
export function parseBranches(output) {
	const local = [];
	const remote = [];
	const tags = [];
	for (const line of output.split("\n")) {
		if (line.trim() === "") continue;
		const [ref, head, upstream, track, hash, time, subject] = line.split(SEP);
		const ahead = Number(/ahead (\d+)/.exec(track ?? "")?.[1] ?? 0);
		const behind = Number(/behind (\d+)/.exec(track ?? "")?.[1] ?? 0);
		const common = { hash, time: Number(time) * 1000, subject: subject ?? "" };
		if (ref.startsWith("refs/heads/")) {
			local.push({
				...common,
				name: ref.slice(11),
				current: head === "*",
				upstream: upstream || null,
				gone: (track ?? "").includes("gone"),
				ahead,
				behind,
			});
		} else if (ref.startsWith("refs/remotes/")) {
			const name = ref.slice(13);
			if (name.endsWith("/HEAD")) continue;
			const slash = name.indexOf("/");
			remote.push({ ...common, name, remote: name.slice(0, slash), short: name.slice(slash + 1) });
		} else if (ref.startsWith("refs/tags/")) {
			tags.push({ ...common, name: ref.slice(10) });
		}
	}
	return { local, remote, tags };
}

export const STASH_FORMAT = ["%gd", "%H", "%ct", "%gs"].join(SEP);

export function parseStashes(output) {
	return output
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const [ref, hash, time, subject] = line.split(SEP);
			return { ref, hash, time: Number(time) * 1000, subject: subject ?? "" };
		});
}

/**
 * Lanes of the commit graph, row by row: which lanes come in at the top,
 * which go out at the bottom, and where the commit's dot is. `state` carries
 * the open lanes from one page of the log to the next.
 */
export function graphRows(commits, state = { lanes: [] }) {
	const rows = [];
	let lanes = [...state.lanes];
	for (const commit of commits) {
		const before = [...lanes];
		let node = lanes.indexOf(commit.hash);
		if (node === -1) {
			node = lanes.indexOf(null);
			if (node === -1) {
				node = lanes.length;
				lanes.push(null);
			}
		}
		const after = lanes.map((hash, index) => (hash === commit.hash && index !== node ? null : hash));
		after[node] = commit.parents[0] ?? null;
		const parentLanes = [];
		if (commit.parents[0] !== undefined) parentLanes.push(node);
		for (const parent of commit.parents.slice(1)) {
			let lane = after.indexOf(parent);
			if (lane === -1) {
				lane = after.indexOf(null);
				if (lane === -1 || lane === node) {
					lane = after.length;
					after.push(null);
				}
				after[lane] = parent;
			}
			parentLanes.push(lane);
		}
		while (after.length > 0 && after[after.length - 1] === null) after.pop();
		rows.push({ before, after, node, parentLanes, hash: commit.hash });
		lanes = after;
	}
	return { rows, state: { lanes } };
}
