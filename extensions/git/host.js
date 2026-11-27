import { translator } from "./i18n.js";
import {
	BRANCH_FORMAT,
	DETAIL_FORMAT,
	LOG_FORMAT,
	parseBranches,
	parseDetail,
	parseLog,
	parseNameStatus,
	parseStashes,
	parseStatus,
	STASH_FORMAT,
} from "./parse.js";

const MAX_CONSOLE = 300;
const MAX_OUTPUT = 20_000;
const MAX_CONTENT = 4 * 1024 * 1024;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const COMMIT_PROMPT = `You write Git commit messages. You get the changes of a commit: the files, their diffs, and the subjects of the last commits of the repository.

Reply with the commit message only: no introduction, no quotes, no code fence. A subject line of at most 72 characters in the imperative ("Add …", "Fix …"), saying what the change does; then, when the change needs it, a blank line and a short body (wrapped at 72 characters) saying why. Follow the language and the style of the recent subjects when there are some (a prefix such as "feat:" or "(QR-123)", English or another language).`;

class GitFailure extends Error {
	constructor(message, code) {
		super(message);
		this.code = code;
	}
}

const sep = (platform) => (platform === "win32" ? "\\" : "/");
const nameOf = (path) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const parentOf = (path) => {
	const trimmed = path.replace(/[\\/]+$/, "");
	const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (index <= 0) return index === 0 ? trimmed.slice(0, 1) : null;
	const parent = trimmed.slice(0, index);
	return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent;
};
const sameKey = (path) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function checkPath(path) {
	const text = String(path ?? "");
	if (
		text === "" ||
		text.startsWith("-") ||
		text.startsWith("/") ||
		/^[a-zA-Z]:/.test(text) ||
		text.split(/[\\/]/).includes("..")
	) {
		throw new Error(`Not a path of the repository: ${text}`);
	}
	return text;
}

function checkRef(ref) {
	const text = String(ref ?? "").trim();
	if (text === "" || text.startsWith("-") || /[\s\x00-\x1f:?*[\\]|\.\./.test(text))
		throw new Error(`Not a revision: ${text}`);
	return text;
}

const firstLines = (stderr, stdout = "") =>
	`${stderr}\n${stdout}`
		.split(/\r?\n/)
		.map((line) => line.replace(/^(fatal|error|hint|remote): ?/i, "").trim())
		.filter(Boolean)
		.slice(0, 8)
		.join("\n");

export async function activate(kalem) {
	const t = translator(kalem.language);
	const slash = sep(kalem.platform);
	const join = (...parts) => parts.join(slash).replace(/[\\/]+/g, slash);

	let trusted = (await kalem.storage.get("trusted")) ?? [];
	let extraRepos = (await kalem.storage.get("repos")) ?? [];
	const consoleEntries = [];
	let consoleId = 0;

	const post = (message) => kalem.ui.post(message).catch(() => {});

	// --- Running git -----------------------------------------------------------------------

	function spawnGit(cwd, args, { env = {}, okCodes = [] } = {}) {
		return new Promise((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			const started = Date.now();
			const full = [
				"--no-optional-locks",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.quotepath=false",
				"-c",
				"color.ui=false",
				...args,
			];
			kalem.process
				.spawn(
					{
						command: "git",
						args: full,
						cwd,
						env: {
							GIT_TERMINAL_PROMPT: "0",
							LC_ALL: "C",
							LANGUAGE: "en",
							GIT_EDITOR: "true",
							...env,
						},
					},
					(event) => {
						if (event.type === "output") {
							if (event.stream === "stdout") stdout += event.text;
							else stderr += event.text;
						} else if (event.type === "exit") {
							const ok = event.code === 0 || okCodes.includes(event.code);
							record(cwd, args, event.code, stdout, stderr, Date.now() - started);
							if (ok) resolve({ stdout, stderr, code: event.code });
							else
								reject(
									new GitFailure(
										firstLines(stderr, stdout) || `git ${args[0]} failed (${event.code}).`,
										event.code,
									),
								);
						} else if (event.type === "error") {
							record(cwd, args, null, stdout, event.message, Date.now() - started);
							reject(
								new GitFailure(
									/ENOENT/.test(event.message) ? t("Git is not installed (git was not found).") : event.message,
									null,
								),
							);
						}
					},
				)
				.catch(reject);
		});
	}

	/** Looking only: these reach the console when they fail. */
	const QUIET = new Set(["merge-base", "status", "for-each-ref", "log", "show", "rev-parse", "diff", "diff-tree", "cat-file", "ls-tree", "branch", "remote", "check-ref-format"]);

	function record(cwd, args, code, stdout, stderr, ms) {
		const command = args.join(" ");
		const quiet =
			(QUIET.has(args[0]) && !(args[0] === "branch" && args.length > 1 && !args.includes("--list") && !args.includes("--contains"))) ||
			(args[0] === "stash" && (args[1] === "list" || args[1] === "show"));
		if (quiet && code === 0) return;
		const entry = {
			id: ++consoleId,
			time: Date.now(),
			root: cwd,
			command: `git ${command}`.slice(0, 2000),
			code,
			ms,
			output: `${stdout}${stderr ? (stdout ? "\n" : "") + stderr : ""}`.slice(0, MAX_OUTPUT),
		};
		consoleEntries.push(entry);
		if (consoleEntries.length > MAX_CONSOLE) consoleEntries.splice(0, consoleEntries.length - MAX_CONSOLE);
		post({ type: "console", entry });
	}

	async function git(root, args, options) {
		if (!isTrusted(root)) throw new Error(t("Trust the repository {0} before git runs in it.", root));
		return spawnGit(root, args, options);
	}

	const out = async (root, args, options) => (await git(root, args, options)).stdout;

	// --- Repositories ----------------------------------------------------------------------

	const isTrusted = (root) => trusted.some((each) => sameKey(each) === sameKey(root));

	async function findRoot(folder) {
		let current = folder;
		for (let depth = 0; depth < 64 && current; depth++) {
			if (await kalem.fs.exists(join(current, ".git"))) return current;
			const parent = parentOf(current);
			if (parent === null || parent === current) return null;
			current = parent;
		}
		return null;
	}

	async function repos() {
		const folders = await kalem.workspace.folders().catch(() => []);
		const found = [];
		for (const folder of [...folders, ...extraRepos]) {
			const root = await findRoot(folder).catch(() => null);
			if (root !== null && !found.some((each) => sameKey(each.root) === sameKey(root))) {
				found.push({ root, name: nameOf(root), trusted: isTrusted(root) });
			}
		}
		const plain = folders.filter((folder) => !found.some((repo) => sameKey(folder).startsWith(sameKey(repo.root))));
		return { repos: found, plainFolders: plain };
	}

	const repoRoot = async (root) => {
		const { repos: known } = await repos();
		const repo = known.find((each) => sameKey(each.root) === sameKey(String(root ?? "")));
		if (repo === undefined) throw new Error(t("{0} is not an open repository.", String(root)));
		return repo.root;
	};

	async function gitDir(root) {
		return (await out(root, ["rev-parse", "--absolute-git-dir"])).trim();
	}

	async function operation(root) {
		const dir = await gitDir(root);
		const has = (name) => kalem.fs.exists(join(dir, name));
		if ((await has("rebase-merge")) || (await has("rebase-apply"))) return "rebase";
		if (await has("MERGE_HEAD")) return "merge";
		if (await has("CHERRY_PICK_HEAD")) return "cherry-pick";
		if (await has("REVERT_HEAD")) return "revert";
		return null;
	}

	async function status(root) {
		const { stdout } = await git(root, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]);
		const parsed = parseStatus(stdout);
		const [op, stashes] = await Promise.all([
			operation(root).catch(() => null),
			out(root, ["stash", "list", "--format=%gd"]).catch(() => ""),
		]);
		const result = {
			...parsed,
			root,
			operation: op,
			stashCount: stashes.split("\n").filter(Boolean).length,
		};
		updateStatusItem(result);
		return result;
	}

	function updateStatusItem(state) {
		const branch = state.branch ?? (state.head ? state.head.slice(0, 8) : t("no commits"));
		const marks = [state.ahead > 0 ? `↑${state.ahead}` : "", state.behind > 0 ? `↓${state.behind}` : ""]
			.filter(Boolean)
			.join(" ");
		kalem.ui
			.setStatusItem("branch", {
				text: `⎇ ${branch}${marks ? ` ${marks}` : ""}${state.operation ? ` · ${t(state.operation)}` : ""}`,
				tooltip: `${nameOf(state.root)} · ${branch}${state.upstream ? ` → ${state.upstream}` : ""}\n${t("{0} changed files", state.files.length)}`,
				command: "open",
			})
			.catch(() => {});
	}

	// --- Contents for diffs ----------------------------------------------------------------

	async function showBlob(root, spec) {
		const result = await git(root, ["cat-file", "-p", spec], { okCodes: [128] }).catch(() => null);
		if (result === null || result.code !== 0) return null;
		return result.stdout;
	}

	/** `side`: `{ ref, path }`, `{ index: true, path }`, `{ worktree: true, path }` or `{ empty: true }`. */
	async function content(root, side) {
		if (side === null || side === undefined || side.empty) return { text: "", missing: true };
		const path = checkPath(side.path);
		let text = null;
		if (side.worktree) {
			const full = join(root, path);
			const info = await kalem.fs.stat(full);
			if (info === null) return { text: "", missing: true };
			if (info.size > MAX_CONTENT) return { text: "", tooLarge: true };
			text = await kalem.fs.readText(full);
		} else if (side.index) {
			text = await showBlob(root, `:${path}`);
		} else {
			text = await showBlob(root, `${checkRef(side.ref)}:${path}`);
			if (text === null && side.alternate) text = await showBlob(root, `${checkRef(side.alternate)}:${path}`);
		}
		if (text === null) return { text: "", missing: true };
		if (text.length > MAX_CONTENT) return { text: "", tooLarge: true };
		if (text.slice(0, 8000).includes("\0")) return { text: "", binary: true };
		return { text };
	}

	// --- Shelf: changes put aside, kept next to the repository ------------------------------

	const shelfDir = async (root) => join(await gitDir(root), "kalem-shelf");

	async function shelves(root) {
		const dir = await shelfDir(root);
		const index = await kalem.fs.readText(join(dir, "index.json")).catch(() => "[]");
		try {
			return JSON.parse(index);
		} catch {
			return [];
		}
	}

	async function saveShelves(root, list) {
		const dir = await shelfDir(root);
		await kalem.fs.mkdir(dir);
		await kalem.fs.writeText(join(dir, "index.json"), JSON.stringify(list, null, 1));
	}

	async function shelve(root, paths, name) {
		const state = await status(root);
		const chosen = state.files.filter((file) => paths.includes(file.path) && file.kind !== "conflict");
		if (chosen.length === 0) throw new Error(t("Choose the files to shelve."));
		const untracked = chosen.filter((file) => file.kind === "untracked").map((file) => file.path);
		if (untracked.length > 0) await git(root, ["add", "-N", "--", ...untracked]);
		const base = state.head ?? EMPTY_TREE;
		const pathspec = chosen.flatMap((file) => (file.oldPath ? [file.oldPath, file.path] : [file.path]));
		const patch = await out(root, ["diff", "--binary", base, "--", ...pathspec]);
		const id = `${Date.now().toString(36)}`;
		const dir = join(await shelfDir(root), id);
		await kalem.fs.mkdir(dir);
		await kalem.fs.writeText(join(dir, "changes.patch"), patch);
		const files = [];
		for (const [index, file] of chosen.entries()) {
			const current = await content(root, { worktree: true, path: file.path });
			const stored = current.missing || current.binary || current.tooLarge ? null : `${index}.txt`;
			if (stored !== null) await kalem.fs.writeText(join(dir, stored), current.text);
			files.push({ path: file.path, oldPath: file.oldPath, kind: file.kind === "untracked" ? "added" : file.kind, stored, binary: Boolean(current.binary) });
		}
		const list = await shelves(root);
		list.unshift({
			id,
			name: String(name || "").trim() || t("Changes of {0}", new Date().toLocaleString(kalem.language)),
			time: Date.now(),
			base,
			branch: state.branch,
			files,
		});
		await saveShelves(root, list);
		await rollback(root, chosen.map((file) => file.path), true);
		return list;
	}

	async function unshelve(root, id, keep) {
		const list = await shelves(root);
		const shelf = list.find((each) => each.id === id);
		if (shelf === undefined) throw new Error(t("That shelf is not there any more."));
		const patchPath = join(await shelfDir(root), id, "changes.patch");
		const patch = await kalem.fs.readText(patchPath);
		if (patch.trim() !== "") {
			try {
				await git(root, ["apply", "--3way", "--whitespace=nowarn", patchPath]);
				const touched = shelf.files.flatMap((file) => (file.oldPath ? [file.oldPath, file.path] : [file.path]));
				await git(root, ["reset", "-q", "--", ...touched], { okCodes: [1] }).catch(() => {});
			} catch (error) {
				await git(root, ["apply", "--whitespace=nowarn", patchPath]).catch(() => {
					throw error;
				});
			}
		}
		if (!keep) await saveShelves(root, list.filter((each) => each.id !== id));
		return shelves(root);
	}

	async function shelfContent(root, id, path) {
		const shelf = (await shelves(root)).find((each) => each.id === id);
		const file = shelf?.files.find((each) => each.path === path);
		if (file === undefined) return { text: "", missing: true };
		if (file.binary) return { text: "", binary: true };
		if (file.stored === null) return { text: "", missing: true };
		return { text: await kalem.fs.readText(join(await shelfDir(root), id, file.stored)) };
	}

	// --- Changes ---------------------------------------------------------------------------

	async function rollback(root, paths, includeNew = false) {
		const state = await status(root);
		const kinds = new Map(state.files.map((file) => [file.path, file]));
		const chosen = paths.map(checkPath).filter((path) => kinds.has(path));
		const fresh = chosen.filter((path) => kinds.get(path).kind === "added" && !kinds.get(path).oldPath);
		const untracked = chosen.filter((path) => kinds.get(path).kind === "untracked");
		const known = chosen.filter((path) => !fresh.includes(path) && !untracked.includes(path));
		const renamedFrom = known.map((path) => kinds.get(path).oldPath).filter(Boolean);
		if (known.length > 0 && state.head !== null) {
			await git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...known, ...renamedFrom]);
			const renamedTo = known.filter((path) => kinds.get(path).oldPath);
			if (renamedTo.length > 0) {
				await git(root, ["rm", "--cached", "-q", "--ignore-unmatch", "--", ...renamedTo]);
				await git(root, ["clean", "-fq", "--", ...renamedTo]);
			}
		}
		if (fresh.length > 0) {
			await git(root, ["rm", "--cached", "-q", "--", ...fresh]);
			await git(root, ["clean", "-fq", "--", ...fresh]);
		}
		if (includeNew && untracked.length > 0) await git(root, ["clean", "-fq", "--", ...untracked]);
	}

	async function commit(root, { message, paths, amend, push }) {
		const text = String(message ?? "").trim();
		if (text === "" && !amend) throw new Error(t("Write a commit message."));
		const chosen = Array.isArray(paths) ? paths.map(checkPath) : [];
		if (chosen.length === 0 && !amend) throw new Error(t("Choose the files to commit."));
		const state = await status(root);
		const byPath = new Map(state.files.map((file) => [file.path, file]));
		const pathspec = chosen.flatMap((path) => {
			const file = byPath.get(path);
			return file?.oldPath ? [file.oldPath, path] : [path];
		});
		if (pathspec.length > 0) await git(root, ["add", "--all", "--", ...pathspec]);
		const args = ["commit", ...(amend ? ["--amend"] : []), ...(text === "" ? ["--no-edit"] : ["-m", text])];
		const result = await git(root, [...args, "--only", "--", ...pathspec]);
		let pushed = null;
		if (push) pushed = await pushCurrent(root, { force: amend && push === "force" });
		return { message: firstLines(result.stdout), pushed };
	}

	async function pushCurrent(root, { force = false, upTo = null } = {}) {
		const state = await status(root);
		if (state.branch === null) throw new Error(t("Check out a branch to push."));
		const lease = force ? ["--force-with-lease"] : [];
		if (upTo !== null) {
			const remote = state.upstream ? state.upstream.split("/")[0] : "origin";
			const target = state.upstream ? state.upstream.slice(remote.length + 1) : state.branch;
			return firstLines((await git(root, ["push", ...lease, remote, `${checkRef(upTo)}:refs/heads/${target}`])).stderr);
		}
		if (state.upstream === null) {
			return firstLines((await git(root, ["push", ...lease, "--set-upstream", "origin", state.branch])).stderr);
		}
		return firstLines((await git(root, ["push", ...lease])).stderr);
	}

	async function suggestMessage(root, paths) {
		const state = await status(root);
		const chosen = new Set((paths?.length ? paths : state.files.map((file) => file.path)).map(checkPath));
		const files = state.files.filter((file) => chosen.has(file.path));
		const parts = [];
		const subjects = await out(root, ["log", "-10", "--format=%s"], { okCodes: [128] }).catch(() => "");
		if (subjects.trim()) parts.push(`Recent commit subjects:\n${subjects.trim()}`);
		parts.push(`Branch: ${state.branch ?? "(detached)"}`);
		parts.push(`Files:\n${files.map((file) => `${file.kind}: ${file.path}`).join("\n")}`);
		const base = state.head ?? EMPTY_TREE;
		for (const file of files) {
			let diff = "";
			if (file.kind === "untracked") {
				const current = await content(root, { worktree: true, path: file.path });
				diff = current.text ? `New file ${file.path}:\n${current.text.slice(0, 4000)}` : "";
			} else {
				diff = await out(root, ["diff", base, "--", ...(file.oldPath ? [file.oldPath] : []), file.path]).catch(() => "");
			}
			parts.push(diff.length > 8000 ? `${diff.slice(0, 8000)}\n[… cut]` : diff);
			if (parts.join("\n").length > 60_000) break;
		}
		const reply = await kalem.assistant.complete(
			COMMIT_PROMPT,
			`${parts.join("\n\n").slice(0, 60_000)}\n\nWrite the commit message for these changes.`,
		);
		let text = String(reply ?? "").trim();
		const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text);
		if (fenced) text = fenced[1].trim();
		text = text.replace(/^[^\n]*(?:commit message|commit mesaj)[^\n]*:\s*\n+/i, "");
		if (/^(["'`])[\s\S]*\1$/.test(text)) text = text.slice(1, -1).trim();
		return text;
	}

	// --- History rewriting, as IntelliJ does it: autosquash rebases ---------------------------

	const sequence = { GIT_SEQUENCE_EDITOR: "true", GIT_EDITOR: "true" };

	async function rebaseFrom(root, hash) {
		const detail = parseDetail(await out(root, ["show", "-s", `--format=${DETAIL_FORMAT}`, checkRef(hash)]));
		const base = detail.parents.length === 0 ? ["--root"] : [`${hash}^`];
		return git(root, ["rebase", "-i", "--autosquash", "--autostash", ...base], { env: sequence });
	}

	async function editMessage(root, hash, message) {
		const text = String(message ?? "").trim();
		if (text === "") throw new Error(t("Write a commit message."));
		const head = (await out(root, ["rev-parse", "HEAD"])).trim();
		if (head.startsWith(hash) || hash.startsWith(head)) {
			await git(root, ["commit", "--amend", "--only", "-m", text]);
			return;
		}
		const subject = (await out(root, ["show", "-s", "--format=%s", checkRef(hash)])).trim();
		await git(root, ["commit", "--allow-empty", "--only", "-m", `amend! ${subject}\n\n${text}`]);
		await rebaseFrom(root, hash);
	}

	async function fixup(root, hash, paths, squash) {
		const chosen = (paths ?? []).map(checkPath);
		if (chosen.length === 0) throw new Error(t("Choose the files to put into the commit (in Local Changes)."));
		await git(root, ["add", "--all", "--", ...chosen]);
		await git(root, ["commit", squash ? `--squash=${checkRef(hash)}` : `--fixup=${checkRef(hash)}`, "--no-edit", "--only", "--", ...chosen]);
		await rebaseFrom(root, hash);
	}

	// --- What the pane asks ----------------------------------------------------------------

	const ui = (name, handler) => kalem.ui.handle(name, handler);
	const withRoot = (handler) => async (input) => handler(await repoRoot(input?.root), input ?? {});

	await ui("state", async () => ({
		...(await repos()),
		settings: await kalem.settings.all(),
		console: consoleEntries,
		assistant: true,
	}));
	await ui("trust", async ({ root }) => {
		const found = await findRoot(String(root));
		if (found === null) throw new Error(t("{0} is not a git repository.", String(root)));
		if (!isTrusted(found)) {
			trusted = [...trusted, found];
			await kalem.storage.set("trusted", trusted);
		}
		return repos();
	});
	await ui("addRepo", async () => {
		const folder = await kalem.ui.pickPath({ folder: true, title: t("Add a Repository…") });
		if (folder === null) return repos();
		const root = await findRoot(folder);
		if (root === null) throw new Error(t("{0} is not a git repository.", folder));
		if (!extraRepos.some((each) => sameKey(each) === sameKey(root))) {
			extraRepos = [...extraRepos, root];
			await kalem.storage.set("repos", extraRepos);
		}
		return repos();
	});
	await ui("removeRepo", async ({ root }) => {
		extraRepos = extraRepos.filter((each) => sameKey(each) !== sameKey(String(root)));
		await kalem.storage.set("repos", extraRepos);
		return repos();
	});
	await ui("init", async ({ folder }) => {
		const { plainFolders } = await repos();
		const target = plainFolders.find((each) => sameKey(each) === sameKey(String(folder)));
		if (target === undefined) throw new Error(t("{0} is not an open folder.", String(folder)));
		await spawnGit(target, ["init"]);
		trusted = [...trusted, target];
		await kalem.storage.set("trusted", trusted);
		return repos();
	});
	await ui("clone", async ({ url }) => {
		const address = String(url ?? "").trim();
		if (!/^(?:https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|[\w.-]+@[\w.-]+:)/.test(address) || /\s/.test(address))
			throw new Error(t("Not a repository address: {0}", address));
		const parent = await kalem.ui.pickPath({ folder: true, title: t("Clone into…") });
		if (parent === null) return null;
		const name = nameOf(address.replace(/\.git\/?$/, "").replace(/:/g, "/")) || "repository";
		const target = join(parent, name);
		if (await kalem.fs.exists(target)) throw new Error(t("{0} is already there.", target));
		await spawnGit(parent, ["clone", "--", address, target]);
		trusted = [...trusted, target];
		await kalem.storage.set("trusted", trusted);
		await kalem.workspace.addFolder(target);
		return target;
	});

	await ui("status", withRoot((root) => status(root)));
	await ui("branches", withRoot(async (root) => parseBranches(await out(root, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads", "refs/remotes", "refs/tags"]))));
	await ui("log", withRoot(async (root, { branch, author, text, path, skip = 0, limit = 200 }) => {
		const args = ["log", `--format=${LOG_FORMAT}`, "--date-order", `--max-count=${Math.min(Number(limit) || 200, 1000)}`, `--skip=${Math.max(0, Number(skip) || 0)}`];
		if (author) args.push(`--author=${String(author)}`);
		if (text) args.push(`--grep=${String(text)}`, "-i", "--fixed-strings");
		if (!branch || branch === "HEAD") args.push("HEAD");
		else if (branch === "--all") args.push("--branches", "--remotes", "--tags", "HEAD");
		else if (String(branch).includes("...")) {
			const [from, to] = String(branch).split("...");
			args.push(`${checkRef(from)}...${checkRef(to)}`);
		} else args.push(checkRef(branch));
		if (path) args.push("--", checkPath(path));
		const result = await git(root, args, { okCodes: [128] });
		return result.code === 0 ? parseLog(result.stdout) : [];
	}));
	await ui("commit.detail", withRoot(async (root, { hash }) => {
		const detail = parseDetail(await out(root, ["show", "-s", `--format=${DETAIL_FORMAT}`, checkRef(hash)]));
		const files =
			detail.parents.length === 0
				? parseNameStatus(await out(root, ["diff-tree", "--root", "-r", "-M", "--name-status", "-z", "--no-commit-id", detail.hash]))
				: parseNameStatus(await out(root, ["diff", "-M", "--name-status", "-z", detail.parents[0], detail.hash]));
		const branches = await out(root, ["branch", "-a", "--contains", detail.hash, "--format=%(refname:short)"]).catch(() => "");
		return { ...detail, files, branches: branches.split("\n").filter(Boolean).slice(0, 30) };
	}));
	await ui("outgoing", withRoot(async (root) => {
		const state = await status(root);
		const range = state.upstream ? [`${state.upstream}..HEAD`] : ["HEAD", "--not", "--remotes"];
		if (state.head === null) return { branch: state.branch, upstream: state.upstream, commits: [] };
		const result = await git(root, ["log", `--format=${LOG_FORMAT}`, "--max-count=200", ...range], { okCodes: [128] });
		return { branch: state.branch, upstream: state.upstream, commits: result.code === 0 ? parseLog(result.stdout) : [] };
	}));
	await ui("isAncestor", withRoot(async (root, { hash }) => {
		const result = await git(root, ["merge-base", "--is-ancestor", checkRef(hash), "HEAD"], { okCodes: [1, 128] });
		return result.code === 0;
	}));
	await ui("compareWithLocal", withRoot(async (root, { hash }) => parseNameStatus(await out(root, ["diff", "-M", "--name-status", "-z", checkRef(hash)]))));
	await ui("headMessage", withRoot(async (root) => (await out(root, ["log", "-1", "--format=%B"], { okCodes: [128] }).catch(() => "")).trim()));
	await ui("content", withRoot((root, { side }) => content(root, side)));
	await ui("shelfContent", withRoot((root, { id, path }) => shelfContent(root, String(id), String(path))));
	await ui("writeWorktree", withRoot(async (root, { path, text }) => {
		await kalem.fs.writeText(join(root, checkPath(path)), String(text ?? ""));
		return true;
	}));

	await ui("openDiff", async ({ root, title, files, index = 0, key, editable }) => {
		const repo = await repoRoot(root);
		const list = (Array.isArray(files) ? files : []).slice(0, 2000);
		if (list.length === 0) return null;
		const at = Math.max(0, Math.min(Number(index) || 0, list.length - 1));
		const first = list[at];
		await kalem.ui.openEditor("diff", {
			key: String(key ?? `diff:${repo}:${first.path}`).slice(0, 200),
			title: String(title ?? nameOf(first.path)),
			tooltip: `${nameOf(repo)} · ${first.path}`,
			data: { root: repo, files: list, index: at, editable: Boolean(editable) },
		});
		return null;
	});

	await ui("commit", withRoot((root, input) => commit(root, input)));
	await ui("suggestMessage", withRoot((root, { paths }) => suggestMessage(root, paths)));
	await ui("rollback", withRoot(async (root, { paths }) => {
		await rollback(root, (paths ?? []).map(checkPath));
		return status(root);
	}));
	await ui("deleteUntracked", withRoot(async (root, { paths }) => {
		const chosen = (paths ?? []).map(checkPath);
		if (chosen.length > 0) await git(root, ["clean", "-fq", "--", ...chosen]);
		return status(root);
	}));
	await ui("add", withRoot(async (root, { paths }) => {
		await git(root, ["add", "--", ...(paths ?? []).map(checkPath)]);
		return status(root);
	}));
	await ui("ignore", withRoot(async (root, { paths }) => {
		const file = join(root, ".gitignore");
		const current = (await kalem.fs.exists(file)) ? await kalem.fs.readText(file) : "";
		const lines = (paths ?? []).map(checkPath).map((path) => `/${path.replace(/\\/g, "/")}`);
		const next = `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${lines.join("\n")}\n`;
		await kalem.fs.writeText(file, next);
		return status(root);
	}));
	await ui("resolve", withRoot(async (root, { paths, take }) => {
		const chosen = (paths ?? []).map(checkPath);
		if (take === "ours" || take === "theirs") await git(root, ["checkout", `--${take}`, "--", ...chosen]);
		await git(root, ["add", "--", ...chosen]);
		return status(root);
	}));
	await ui("operation", withRoot(async (root, { action }) => {
		const op = await operation(root);
		if (op === null) return status(root);
		if (action === "abort") await git(root, [op, "--abort"]);
		else if (op === "merge") await git(root, ["commit", "--no-edit"]);
		else await git(root, [op, "--continue"], { env: sequence });
		return status(root);
	}));

	await ui("fetch", withRoot(async (root) => firstLines((await git(root, ["fetch", "--all", "--prune"])).stderr)));
	await ui("pull", withRoot(async (root, { how }) => {
		const mode = how === "rebase" ? ["--rebase"] : how === "merge" ? ["--no-rebase"] : [];
		try {
			const result = await git(root, ["pull", "--no-edit", ...mode]);
			return firstLines(result.stdout, result.stderr);
		} catch (error) {
			if (!how && /divergent branches|Need to specify how to reconcile/i.test(error.message)) {
				throw new Error(`diverged: ${error.message}`);
			}
			throw error;
		}
	}));
	await ui("push", withRoot((root, { force, upTo }) => pushCurrent(root, { force: Boolean(force), upTo: upTo ?? null })));

	await ui("checkout", withRoot(async (root, { name, remote, smart }) => {
		const ref = checkRef(name);
		let stashed = false;
		if (smart) {
			const before = (await out(root, ["stash", "list", "--format=%H"])).split("\n")[0];
			await git(root, ["stash", "push", "-m", `Smart checkout of ${ref}`]);
			stashed = (await out(root, ["stash", "list", "--format=%H"])).split("\n")[0] !== before;
		}
		try {
			await switchTo(root, ref, remote);
		} catch (error) {
			if (stashed) await git(root, ["stash", "pop"]).catch(() => {});
			if (!smart && /would be overwritten by checkout/i.test(error.message)) throw new Error(`overwritten: ${error.message}`);
			throw error;
		}
		if (stashed) await git(root, ["stash", "pop"]);
		return status(root);
	}));
	async function switchTo(root, ref, remote) {
		if (remote) {
			const short = ref.slice(ref.indexOf("/") + 1);
			const local = (await out(root, ["branch", "--list", short])).trim();
			if (local === "") await git(root, ["switch", "--track", "-c", short, ref]);
			else await git(root, ["switch", short]);
		} else {
			await git(root, ["switch", ref]);
		}
	}
	await ui("checkoutRevision", withRoot(async (root, { ref }) => {
		await git(root, ["switch", "--detach", checkRef(ref)]);
		return status(root);
	}));
	await ui("newBranch", withRoot(async (root, { name, from, checkout = true }) => {
		const branch = String(name ?? "").trim();
		await git(root, ["check-ref-format", "--branch", branch]).catch(() => {
			throw new Error(t("Not a valid branch name: {0}", branch));
		});
		const start = from ? [checkRef(from)] : [];
		if (checkout) await git(root, ["switch", "-c", branch, ...start]);
		else await git(root, ["branch", branch, ...start]);
		return status(root);
	}));
	await ui("renameBranch", withRoot(async (root, { name, to }) => {
		await git(root, ["branch", "-m", checkRef(name), String(to ?? "").trim()]);
		return null;
	}));
	await ui("deleteBranch", withRoot(async (root, { name, force, remote }) => {
		const ref = checkRef(name);
		if (remote) {
			const slash = ref.indexOf("/");
			await git(root, ["push", ref.slice(0, slash), "--delete", ref.slice(slash + 1)]);
		} else {
			await git(root, ["branch", force ? "-D" : "-d", ref]);
		}
		return null;
	}));
	await ui("merge", withRoot(async (root, { name }) => firstLines((await git(root, ["merge", "--no-edit", checkRef(name)])).stdout)));
	await ui("rebaseOnto", withRoot(async (root, { name }) => firstLines((await git(root, ["rebase", "--autostash", checkRef(name)], { env: sequence })).stderr)));
	await ui("checkoutAndRebase", withRoot(async (root, { name, onto }) => {
		await git(root, ["switch", checkRef(name)]);
		await git(root, ["rebase", "--autostash", checkRef(onto)], { env: sequence });
		return null;
	}));
	await ui("pushBranch", withRoot(async (root, { name }) => {
		const branch = checkRef(name);
		const upstream = (await out(root, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`])).trim();
		if (upstream === "") await git(root, ["push", "--set-upstream", "origin", branch]);
		else await git(root, ["push", upstream.split("/")[0], `${branch}:${upstream.slice(upstream.indexOf("/") + 1)}`]);
		return null;
	}));
	await ui("tag", withRoot(async (root, { name, at, message }) => {
		const tag = String(name ?? "").trim();
		await git(root, ["check-ref-format", `refs/tags/${tag}`]).catch(() => {
			throw new Error(t("Not a valid tag name: {0}", tag));
		});
		await git(root, ["tag", ...(message ? ["-a", "-m", String(message)] : []), tag, checkRef(at || "HEAD")]);
		return null;
	}));
	await ui("deleteTag", withRoot(async (root, { name }) => {
		await git(root, ["tag", "-d", checkRef(name)]);
		return null;
	}));

	await ui("cherryPick", withRoot(async (root, { hashes }) => {
		await git(root, ["cherry-pick", ...(hashes ?? []).map(checkRef)]);
		return null;
	}));
	await ui("revert", withRoot(async (root, { hashes }) => {
		await git(root, ["revert", "--no-edit", ...(hashes ?? []).map(checkRef)]);
		return null;
	}));
	await ui("reset", withRoot(async (root, { hash, mode }) => {
		const flag = ["soft", "mixed", "hard", "keep"].includes(mode) ? mode : "mixed";
		await git(root, ["reset", `--${flag}`, checkRef(hash)]);
		return null;
	}));
	await ui("undoCommit", withRoot(async (root) => {
		await git(root, ["reset", "--soft", "HEAD~1"]);
		return null;
	}));
	await ui("editMessage", withRoot(async (root, { hash, message }) => {
		await editMessage(root, checkRef(hash), message);
		return null;
	}));
	await ui("fixup", withRoot(async (root, { hash, paths, squash }) => {
		await fixup(root, checkRef(hash), paths, Boolean(squash));
		return null;
	}));
	await ui("dropCommit", withRoot(async (root, { hash }) => {
		const ref = checkRef(hash);
		await git(root, ["rebase", "--autostash", "--onto", `${ref}^`, ref], { env: sequence });
		return null;
	}));
	await ui("createPatch", withRoot(async (root, { hashes }) => {
		const folder = await kalem.ui.pickPath({ folder: true, title: t("Save the patch in…") });
		if (folder === null) return null;
		const list = (hashes ?? []).map(checkRef);
		const written = [];
		for (const hash of list) {
			const patch = await out(root, ["format-patch", "-1", "--stdout", hash]);
			const subject = (await out(root, ["show", "-s", "--format=%s", hash])).trim();
			const name = `${hash.slice(0, 8)}-${subject.replace(/[^\w.-]+/g, "-").slice(0, 50)}.patch`;
			await kalem.fs.writeText(join(folder, name), patch);
			written.push(join(folder, name));
		}
		return written;
	}));
	await ui("applyPatch", withRoot(async (root) => {
		const file = await kalem.ui.pickPath({ title: t("Apply a Patch…") });
		if (file === null) return null;
		await git(root, ["apply", "--3way", "--whitespace=nowarn", file]);
		return status(root);
	}));

	await ui("stashes", withRoot(async (root) => parseStashes(await out(root, ["stash", "list", `--format=${STASH_FORMAT}`]))));
	await ui("stash", withRoot(async (root, { message, keepIndex, untracked, paths }) => {
		const args = ["stash", "push"];
		if (keepIndex) args.push("--keep-index");
		if (untracked) args.push("--include-untracked");
		if (message) args.push("-m", String(message));
		const chosen = (paths ?? []).map(checkPath);
		if (chosen.length > 0) args.push("--", ...chosen);
		await git(root, args);
		return status(root);
	}));
	await ui("stashApply", withRoot(async (root, { ref, pop, index, branch }) => {
		const stash = checkRef(ref);
		if (branch) await git(root, ["stash", "branch", String(branch).trim(), stash]);
		else await git(root, ["stash", pop ? "pop" : "apply", ...(index ? ["--index"] : []), stash]);
		return status(root);
	}));
	await ui("stashDrop", withRoot(async (root, { ref }) => {
		await git(root, ["stash", "drop", checkRef(ref)]);
		return null;
	}));
	await ui("stashClear", withRoot(async (root) => {
		await git(root, ["stash", "clear"]);
		return null;
	}));
	await ui("stashFiles", withRoot(async (root, { ref }) => {
		const stash = checkRef(ref);
		const tracked = parseNameStatus(await out(root, ["stash", "show", "-M", "--name-status", "-z", stash]));
		const untracked = await out(root, ["ls-tree", "-r", "--name-only", "-z", `${stash}^3`], { okCodes: [128] }).catch(() => "");
		return [
			...tracked,
			...untracked
				.split("\0")
				.filter(Boolean)
				.map((path) => ({ kind: "untracked", oldPath: null, path })),
		];
	}));

	await ui("shelves", withRoot((root) => shelves(root)));
	await ui("shelve", withRoot(async (root, { paths, name }) => {
		await shelve(root, (paths ?? []).map(checkPath), name);
		return status(root);
	}));
	await ui("unshelve", withRoot(async (root, { id, keep }) => {
		await unshelve(root, String(id), Boolean(keep));
		return status(root);
	}));
	await ui("dropShelf", withRoot(async (root, { id }) => {
		await saveShelves(root, (await shelves(root)).filter((each) => each.id !== id));
		return shelves(root);
	}));
	await ui("renameShelf", withRoot(async (root, { id, name }) => {
		const list = await shelves(root);
		await saveShelves(root, list.map((each) => (each.id === id ? { ...each, name: String(name ?? each.name).trim() || each.name } : each)));
		return shelves(root);
	}));

	await ui("console", () => consoleEntries);
	await ui("clearConsole", () => {
		consoleEntries.splice(0);
		return [];
	});

	await kalem.commands.register("open", () => kalem.ui.showPane("git"));
	await kalem.commands.register("commit", async () => {
		await kalem.ui.showPane("git");
		await post({ type: "focus", tab: "changes" });
	});
	await kalem.commands.register("log", async () => {
		await kalem.ui.showPane("git");
		await post({ type: "focus", tab: "log" });
	});
	await kalem.commands.register("clone", async () => {
		await kalem.ui.showPane("git");
		await post({ type: "clone" });
	});

	// --- Fetch now and then, quietly ---------------------------------------------------------

	const fetchQuietly = async () => {
		const minutes = Number(await kalem.settings.get("autoFetchMinutes"));
		if (!(minutes > 0)) return;
		const { repos: known } = await repos();
		for (const repo of known.filter((each) => each.trusted)) {
			const remotes = await out(repo.root, ["remote"]).catch(() => "");
			if (remotes.trim() === "") continue;
			await git(repo.root, ["fetch", "--all", "--prune", "--quiet"], {
				env: { GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
			}).catch(() => {});
		}
		post({ type: "fetched" });
	};
	let lastFetch = Date.now();
	setInterval(async () => {
		const minutes = Number(await kalem.settings.get("autoFetchMinutes").catch(() => 0));
		if (minutes > 0 && Date.now() - lastFetch >= minutes * 60_000) {
			lastFetch = Date.now();
			await fetchQuietly();
		}
	}, 60_000);

	// --- The assistant: what the repository looks like ----------------------------------------

	const firstRepo = async (input) => {
		const { repos: known } = await repos();
		const wanted = input?.repository ? String(input.repository) : "";
		const repo = wanted
			? known.find((each) => sameKey(each.root) === sameKey(wanted) || each.name === wanted)
			: known.find((each) => each.trusted);
		if (repo === undefined) throw new Error("No trusted git repository is open.");
		return repo.root;
	};
	const repoParam = {
		repository: { type: "string", description: "The repository's folder or name; the first open one when left out." },
	};
	await kalem.assistant.registerTool(
		{
			name: "git_status",
			description: "The branch, what waits to be pushed or pulled, and the changed files of an open git repository.",
			parameters: { type: "object", properties: repoParam },
		},
		async (input) => {
			const state = await status(await firstRepo(input));
			return {
				branch: state.branch,
				upstream: state.upstream,
				ahead: state.ahead,
				behind: state.behind,
				operation: state.operation,
				files: state.files.map((file) => `${file.kind}: ${file.path}`),
			};
		},
	);
	await kalem.assistant.registerTool(
		{
			name: "git_log",
			description: "The last commits of an open git repository (optionally of one file).",
			parameters: {
				type: "object",
				properties: {
					...repoParam,
					count: { type: "number", description: "How many, at most 100 (20 by default)." },
					path: { type: "string", description: "Only commits that changed this file." },
				},
			},
		},
		async (input) => {
			const root = await firstRepo(input);
			const args = ["log", `--max-count=${Math.min(Number(input?.count) || 20, 100)}`, "--format=%h %ad %an: %s", "--date=short"];
			if (input?.path) args.push("--", checkPath(input.path));
			return out(root, args);
		},
	);
	await kalem.assistant.registerTool(
		{
			name: "git_diff",
			description: "The uncommitted changes of an open git repository as a unified diff, or the changes of one commit.",
			parameters: {
				type: "object",
				properties: {
					...repoParam,
					commit: { type: "string", description: "A commit to show instead of the uncommitted changes." },
					path: { type: "string", description: "Only this file." },
				},
			},
		},
		async (input) => {
			const root = await firstRepo(input);
			const args = input?.commit ? ["show", "--format=%H %an %ad%n%B", checkRef(input.commit)] : ["diff", "HEAD"];
			if (input?.path) args.push("--", checkPath(input.path));
			const text = await out(root, args);
			return text.length > 60_000 ? `${text.slice(0, 60_000)}\n[… cut]` : text || "No changes.";
		},
	);
}
