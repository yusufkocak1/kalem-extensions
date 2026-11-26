/**
 * Web artifacts in the open folder, found as IntelliJ IDEA lists them:
 * `module:war` and `module:war exploded` for each Maven module packaged as a
 * WAR, and the WARs a Gradle `war` build makes. Pure but for `fs`.
 */

const SKIPPED = new Set([
	"node_modules",
	".git",
	".svn",
	".idea",
	".vscode",
	".kalem",
	"target",
	"build",
	"dist",
	"out",
	"src",
	"bin",
	".gradle",
	".mvn",
]);
const MAX_DEPTH = 6;

const withoutComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "");
const tag = (text, name) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(text)?.[1] ?? "";

/** A pom's own coordinates, packaging and finalName (its parent's version when it has none). */
export function readPom(text) {
	const source = withoutComments(String(text));
	const parent = /<parent>([\s\S]*?)<\/parent>/.exec(source)?.[1] ?? "";
	const own = source
		.replace(/<parent>[\s\S]*?<\/parent>/, "")
		.replace(/<dependencies>[\s\S]*?<\/dependencies>/g, "")
		.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "")
		.replace(/<plugins>[\s\S]*?<\/plugins>/g, "")
		.replace(/<pluginManagement>[\s\S]*?<\/pluginManagement>/g, "")
		.replace(/<profiles>[\s\S]*?<\/profiles>/g, "");
	const artifactId = tag(own, "artifactId");
	const version = tag(own, "version") || tag(parent, "version");
	const properties = {
		"project.artifactId": artifactId,
		"project.version": version,
		artifactId,
		version,
	};
	for (const match of (/<properties>([\s\S]*?)<\/properties>/.exec(own)?.[1] ?? "").matchAll(
		/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g,
	))
		properties[match[1]] = match[2];
	const expand = (value) =>
		value.replace(/\$\{([\w.-]+)\}/g, (whole, name) => properties[name] ?? whole);
	const build = /<build>([\s\S]*?)<\/build>/.exec(own)?.[1] ?? "";
	const finalName =
		expand(tag(build, "finalName")) || (version ? `${artifactId}-${version}` : artifactId);
	return {
		artifactId,
		version,
		packaging: expand(tag(own, "packaging")) || "jar",
		finalName,
		modules: [...source.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((match) => match[1]),
	};
}

const usesWarPlugin = (text) =>
	/\bid\s*\(?\s*["']war["']|apply\s+plugin\s*:\s*["']war["']|^\s*war\s*$|["']war["']\s*\)?\s*$|`war`/m.test(
		text,
	);

/** `$PROJECT_DIR$/out/artifacts/x` in an IntelliJ artifact file, as a path under the folder. */
const projectPath = (text) =>
	String(text ?? "")
		.trim()
		.replace(/^\$PROJECT_DIR\$\/?/, "")
		.replace(/\\/g, "/");

/** The artifacts IntelliJ IDEA keeps in `.idea/artifacts/*.xml` (only web ones: war, exploded war). */
async function ideaArtifacts(folder, fs, paths) {
	const dir = paths.join(folder, ".idea", "artifacts");
	let entries;
	try {
		entries = await fs.list(dir);
	} catch {
		return [];
	}
	const found = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".xml")) continue;
		const text = await fs.readText(paths.join(dir, entry.name)).catch(() => "");
		const head = /<artifact\b([^>]*)>/.exec(text)?.[1] ?? "";
		const type = /\btype="([^"]+)"/.exec(head)?.[1] ?? "";
		const name = /\bname="([^"]+)"/.exec(head)?.[1] ?? entry.name.replace(/\.xml$/, "");
		const output = projectPath(tag(text, "output-path"));
		if (output === "" || output.startsWith("$")) continue;
		if (type === "exploded-war")
			found.push({ id: name, kind: "exploded", path: output, module: "", build: null });
		else if (type === "war") {
			const file = /<root\b[^>]*\bid="archive"[^>]*\bname="([^"]+)"/.exec(text)?.[1];
			if (file)
				found.push({ id: name, kind: "war", path: `${output}/${file}`, module: "", build: null });
		}
	}
	return found;
}

/** WARs and exploded web applications already built under `target`, `build/libs` or `out/artifacts`. */
async function builtOutputs(folder, relative, fs, paths) {
	const found = [];
	for (const outDir of ["target", "build/libs", "out/artifacts"]) {
		const base = [relative, outDir].filter(Boolean).join("/");
		let entries;
		try {
			entries = await fs.list(paths.join(folder, ...base.split("/")));
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = `${base}/${entry.name}`;
			if (entry.type === "file" && /\.war$/i.test(entry.name)) {
				found.push({ id: path, kind: "war", path, module: relative, build: null });
			} else if (
				entry.type === "folder" &&
				(await fs.exists(paths.join(folder, ...path.split("/"), "WEB-INF")))
			) {
				found.push({ id: path, kind: "exploded", path, module: relative, build: null });
			}
		}
	}
	return found;
}

/**
 * What a folder holds to deploy: `{ artifacts, poms }`. Each artifact is
 * `{ id, kind: "war" | "exploded", path, module, build, built }` with `path` and
 * `module` relative to the folder and `build` saying how to make it; `poms`
 * lists the Maven projects seen with their packaging, to say why none is found.
 */
export async function scanArtifacts(folder, fs, paths) {
	const found = [];
	const poms = [];
	const walk = async (relative, depth) => {
		const dir = relative === "" ? folder : paths.join(folder, ...relative.split("/"));
		let entries;
		try {
			entries = await fs.list(dir);
		} catch {
			return;
		}
		const names = new Set(entries.map((entry) => entry.name));
		const rel = (...parts) => [relative, ...parts].filter(Boolean).join("/");
		if (names.has("pom.xml")) {
			const pom = readPom(await fs.readText(paths.join(dir, "pom.xml")).catch(() => ""));
			poms.push({ path: rel("pom.xml"), artifactId: pom.artifactId, packaging: pom.packaging });
			const module = pom.artifactId || relative.split("/").pop() || "app";
			if (pom.packaging === "war") {
				found.push(
					{
						id: `${module}:war`,
						kind: "war",
						path: rel("target", `${pom.finalName}.war`),
						module: relative,
						build: "maven",
					},
					{
						id: `${module}:war exploded`,
						kind: "exploded",
						path: rel("target", pom.finalName),
						module: relative,
						build: "maven",
					},
				);
			}
		} else if (names.has("build.gradle") || names.has("build.gradle.kts")) {
			const file = names.has("build.gradle") ? "build.gradle" : "build.gradle.kts";
			const script = await fs.readText(paths.join(dir, file)).catch(() => "");
			if (usesWarPlugin(script)) {
				const module = relative.split("/").pop() || folder.split(/[\\/]/).pop() || "app";
				let war = rel("build", "libs", `${module}.war`);
				try {
					const built = (await fs.list(paths.join(dir, "build", "libs"))).find((entry) =>
						entry.name.endsWith(".war"),
					);
					if (built) war = rel("build", "libs", built.name);
				} catch {
					// Not built yet: the usual name.
				}
				found.push({
					id: `${module}:war`,
					kind: "war",
					path: war,
					module: relative,
					build: "gradle",
				});
			}
		}
		found.push(...(await builtOutputs(folder, relative, fs, paths)));
		if (depth >= MAX_DEPTH) return;
		for (const entry of entries) {
			if (entry.type !== "folder" || SKIPPED.has(entry.name) || entry.name.startsWith("."))
				continue;
			await walk(rel(entry.name), depth + 1);
		}
	};
	found.push(...(await ideaArtifacts(folder, fs, paths)));
	await walk("", 0);
	const byPath = new Map();
	for (const artifact of found) {
		const key = artifact.path.replace(/\/+$/, "");
		const known = byPath.get(key);
		// What a build tool or IntelliJ names wins over a bare path.
		if (known === undefined || (known.id === known.path && artifact.id !== artifact.path))
			byPath.set(key, { ...artifact, path: key, build: artifact.build ?? known?.build ?? null });
	}
	const artifacts = [...byPath.values()];
	for (const artifact of artifacts)
		artifact.built = await fs.exists(paths.join(folder, ...artifact.path.split("/")));
	artifacts.sort((a, b) => a.id.localeCompare(b.id) || (a.kind === "war" ? -1 : 1));
	return { artifacts, poms };
}

export async function findArtifacts(folder, fs, paths) {
	return (await scanArtifacts(folder, fs, paths)).artifacts;
}

/** The command that builds an artifact's module, from the folder's root project. */
export async function buildStepOf(artifact, folder, fs, paths, platform) {
	const win = platform === "win32";
	if (artifact.build === "maven") {
		const wrapper = paths.join(folder, win ? "mvnw.cmd" : "mvnw");
		const rootIsProject = await fs.exists(paths.join(folder, "pom.xml"));
		const inModule = !rootIsProject || artifact.module === "";
		return {
			title: `Build '${artifact.id}' (Maven package)`,
			command: (await fs.exists(wrapper)) && rootIsProject ? wrapper : "mvn",
			args: ["package", "-DskipTests", ...(inModule ? [] : ["-pl", artifact.module, "-am"])],
			cwd: inModule ? paths.join(folder, ...artifact.module.split("/").filter(Boolean)) : folder,
			shell: win,
		};
	}
	const wrapper = paths.join(folder, win ? "gradlew.bat" : "gradlew");
	const hasWrapper = await fs.exists(wrapper);
	const task =
		hasWrapper && artifact.module !== "" ? `:${artifact.module.replace(/\//g, ":")}:war` : "war";
	return {
		title: `Build '${artifact.id}' (Gradle war)`,
		command: hasWrapper ? wrapper : "gradle",
		args: [task],
		cwd: hasWrapper ? folder : paths.join(folder, ...artifact.module.split("/").filter(Boolean)),
		shell: win,
	};
}

/** The version in a Tomcat folder's RELEASE-NOTES (or RUNNING.txt), e.g. "11.0.26". */
export async function tomcatVersion(home, fs, paths) {
	for (const file of ["RELEASE-NOTES", "RUNNING.txt", "RELEASE-NOTES.txt"]) {
		const text = await fs.readText(paths.join(home, file)).catch(() => "");
		const match =
			/Apache Tomcat Version\s+([\d.]+(?:-M\d+)?)/i.exec(text) ??
			/Tomcat\s+([\d]+\.[\d]+\.[\d]+)/.exec(text);
		if (match) return match[1];
	}
	return null;
}
