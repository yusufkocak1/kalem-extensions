import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { installSample } from "./api-fakes.js";
import { launch, tempDir } from "./launch.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Ada",
			GIT_AUTHOR_EMAIL: "ada@example.com",
			GIT_COMMITTER_NAME: "Ada",
			GIT_COMMITTER_EMAIL: "ada@example.com",
		},
	});
}

async function repository(): Promise<string> {
	const folder = await tempDir("repo");
	git(folder, "init", "-q", "-b", "main");
	git(folder, "config", "user.name", "Ada");
	git(folder, "config", "user.email", "ada@example.com");
	await writeFile(join(folder, "a.txt"), "one\ntwo\nthree\nfour\n");
	await writeFile(join(folder, "b.txt"), "bee\n");
	git(folder, "add", ".");
	git(folder, "commit", "-q", "-m", "First commit");
	git(folder, "switch", "-q", "-c", "feature");
	await writeFile(join(folder, "f.txt"), "feature\n");
	git(folder, "add", ".");
	git(folder, "commit", "-q", "-m", "Feature work");
	git(folder, "switch", "-q", "main");
	await writeFile(join(folder, "a.txt"), "one\nTWO\nthree\nfour\nfive\n");
	git(folder, "commit", "-q", "-am", "Second commit");
	return folder;
}

async function launchIn(folder: string) {
	const userData = await tempDir("profile");
	await writeFile(
		join(userData, "settings.json"),
		JSON.stringify({
			settings: { language: "en", theme: "light", restoreSession: false, kalemCatalog: false },
			welcomed: true,
			workspaces: [folder],
		}),
	);
	return launch({ userData });
}

const editorTab = (page: Page) => page.locator('.doc-tab[data-page^="ext-editor:kalem.git:"]');

test("the Git extension: local changes with a diff in the documents' place, commit, shelf, stash, log and branches", async () => {
	const folder = await repository();
	await writeFile(join(folder, "a.txt"), "one\nTWO 2\nthree\nfive\n");
	await rm(join(folder, "b.txt"));
	await writeFile(join(folder, "c.txt"), "new file\n");

	const { app, page, errors } = await launchIn(folder);
	await page.setViewportSize({ width: 1500, height: 1000 });
	const pane = await installSample(app, page, "git", "git", "Git");

	// Git waits until the repository is trusted.
	await expect(pane.locator(".gp-banner")).toContainText("until you trust it");
	await pane.getByRole("button", { name: "Trust…" }).click();
	await pane.locator(".g-dialog").getByRole("button", { name: "Trust", exact: true }).click();
	await expect(pane.locator(".gp-branch")).toContainText("main");

	const changes = pane.locator(".gp-file");
	await expect(changes).toHaveCount(3);
	await expect(pane.locator('.gp-file.modified[data-path="a.txt"]')).toBeVisible();
	await expect(pane.locator('.gp-file.deleted[data-path="b.txt"]')).toBeVisible();
	await expect(pane.locator('.gp-file.untracked[data-path="c.txt"]')).toBeVisible();
	await expect(pane.locator('.gp-file[data-path="a.txt"] input')).toBeChecked();
	await expect(pane.locator('.gp-file[data-path="c.txt"] input')).not.toBeChecked();

	// The diff opens as a tab beside the documents, not in a window.
	await pane.locator('.gp-file[data-path="a.txt"]').dblclick();
	await expect(editorTab(page)).toHaveCount(1);
	await expect(editorTab(page)).toHaveAttribute("aria-selected", "true");
	await expect(page.locator(".desk-area")).toHaveAttribute("data-ext-editor", "");
	await expect(page.locator("#editor")).toBeHidden();
	const diff = page.frameLocator('iframe.ext-pane-frame[title="Diff: a.txt"]');
	await expect(diff.locator(".gd-head-label").first()).toContainText("HEAD");
	await expect(diff.locator(".gd-row.change")).toHaveCount(1);
	await expect(diff.locator(".gd-row.change .gd-code.left .gd-word")).toHaveCount(0);
	await expect(diff.locator(".gd-row.change .gd-code.right .gd-word")).toHaveText(" 2");
	await expect(diff.locator(".gd-row.delete")).toHaveCount(1);
	await expect(diff.locator(".gd-status")).toContainText("2 differences");
	await expect(diff.locator(".gd-count")).toHaveText("1/2 files");

	// Next file, the unified view, and a change put back from the gutter.
	await diff.getByRole("button", { name: "Next File (Alt+Right)" }).click();
	await expect(diff.locator(".gd-count")).toHaveText("2/2 files");
	await expect(diff.locator(".gd-status")).toContainText("Deleted");
	await diff.getByRole("button", { name: "Previous File (Alt+Left)" }).click();
	await diff.getByRole("button", { name: "Unified viewer" }).click();
	await expect(diff.locator(".gd-row.removed")).toHaveCount(2);
	await expect(diff.locator(".gd-row.added")).toHaveCount(1);
	await diff.getByRole("button", { name: "Side-by-side viewer" }).click();
	await diff.locator(".gd-row.delete .gd-revert").click();
	await expect(diff.locator(".gd-status")).toContainText("1 differences");
	expect(await readFile(join(folder, "a.txt"), "utf8")).toBe("one\nTWO 2\nthree\nfour\nfive\n");

	// The same file again brings the same tab forward; a document tab brings the document back.
	await pane.locator('.gp-file[data-path="a.txt"]').dblclick();
	await expect(editorTab(page)).toHaveCount(1);
	await page.locator(".doc-tab[data-document]").first().click();
	await expect(page.locator(".desk-area")).not.toHaveAttribute("data-ext-editor", "");
	await expect(page.locator("#editor")).toBeVisible();
	await editorTab(page).locator(".doc-tab-close").click();
	await expect(editorTab(page)).toHaveCount(0);

	// Shelve the new file: it goes, and comes back from the shelf.
	await pane.locator('.gp-file[data-path="c.txt"]').click({ button: "right" });
	await pane.locator(".g-menu").getByRole("menuitem", { name: "Shelve Changes…" }).click();
	await pane.locator(".g-dialog input").fill("Later");
	await pane.locator(".g-dialog").getByRole("button", { name: "Shelve" }).click();
	await expect(pane.locator('.gp-file[data-path="c.txt"]')).toHaveCount(0);
	await expect.poll(() => readFile(join(folder, "c.txt"), "utf8").catch(() => null)).toBeNull();
	await pane.getByRole("tab", { name: /Shelf/ }).click();
	await expect(pane.locator(".gp-shelf")).toContainText("Later");
	await pane.locator(".gp-file.added").dblclick();
	const shelfDiff = page.frameLocator('iframe.ext-pane-frame[title="Shelf: Later"]');
	await expect(shelfDiff.locator(".gd-row.insert")).toHaveCount(1);
	await editorTab(page).locator(".doc-tab-close").click();
	await pane.getByRole("button", { name: "Unshelve" }).click();
	await expect.poll(() => readFile(join(folder, "c.txt"), "utf8").catch(() => null)).toBe("new file\n");

	// Commit the chosen files only.
	await pane.getByRole("tab", { name: /Local Changes/ }).click();
	await expect(pane.locator('.gp-file[data-path="c.txt"]')).toBeVisible();
	await pane.locator(".gp-message").fill("Change a and remove b");
	await pane.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(pane.locator(".gp-file")).toHaveCount(1);
	expect(git(folder, "log", "-1", "--format=%s").trim()).toBe("Change a and remove b");
	expect(git(folder, "status", "--porcelain").trim()).toBe("?? c.txt");

	// Stash a change and pop it back.
	await writeFile(join(folder, "a.txt"), "stashed\n");
	await pane.getByRole("button", { name: "Refresh" }).first().click();
	await expect(pane.locator('.gp-file[data-path="a.txt"]')).toBeVisible();
	await pane.getByRole("tab", { name: /Stash/ }).click();
	await pane.getByRole("button", { name: "Stash Changes…" }).click();
	await pane.locator(".g-dialog input.k-input").fill("wip");
	await pane.locator(".g-dialog").getByRole("button", { name: "Create Stash" }).click();
	await expect(pane.locator(".gp-stash")).toHaveCount(1);
	await expect(pane.locator(".gp-stash")).toContainText("wip");
	expect(await readFile(join(folder, "a.txt"), "utf8")).toBe("one\nTWO 2\nthree\nfour\nfive\n");
	await pane.getByRole("button", { name: "Pop", exact: true }).click();
	await expect(pane.locator(".gp-stash")).toHaveCount(0);
	expect(await readFile(join(folder, "a.txt"), "utf8")).toBe("stashed\n");

	// The log: the graph, a commit's files, and the commit menu.
	await pane.getByRole("tab", { name: /Log/ }).click();
	const rows = pane.locator(".gp-commit-row");
	await expect(rows).toHaveCount(3);
	await expect(rows.first()).toContainText("Change a and remove b");
	await expect(rows.first().locator(".gp-ref.head")).toHaveText("main");
	await expect(rows.first().locator("svg.gp-graph circle")).toHaveCount(1);
	await expect(pane.locator(".gp-detail-files .gp-file")).toHaveCount(2);
	await pane.locator(".gp-log-branch").selectOption("--all");
	await expect(rows).toHaveCount(4);
	await expect(pane.locator(".gp-commit-row", { hasText: "Feature work" }).locator(".gp-ref")).toHaveText("feature");
	await rows.nth(1).click({ button: "right" });
	const menu = pane.locator(".g-menu");
	for (const item of ["Copy Revision Number", "Create Patch…", "Cherry-Pick", "Checkout Revision", "Compare with Local", "Reset Current Branch to Here…", "Revert Commit", "Undo Commit…", "Edit Commit Message…", "Fixup…", "Squash Into…", "Drop Commit", "Push All up to Here…", "New Branch…", "New Tag…", "Go to Child Commit", "Go to Parent Commit"]) {
		await expect(menu.getByRole("menuitem", { name: item })).toHaveCount(1);
	}
	await menu.getByRole("menuitem", { name: "New Tag…" }).click();
	await pane.locator(".g-dialog input.k-input").fill("v1.0");
	await pane.locator(".g-dialog").getByRole("button", { name: "Create" }).click();
	await expect.poll(() => git(folder, "tag").trim()).toBe("v1.0");

	// Edit the message of the commit under HEAD: an autosquash rebase.
	await pane.locator(".gp-log-branch").selectOption("HEAD");
	await expect(rows).toHaveCount(3);
	await rows.nth(1).click({ button: "right" });
	await menu.getByRole("menuitem", { name: "Edit Commit Message…" }).click();
	await pane.locator(".g-dialog textarea").fill("Second commit, reworded");
	await pane.locator(".g-dialog").getByRole("button", { name: "OK" }).click();
	await expect.poll(() => git(folder, "log", "--format=%s").trim().split("\n")).toEqual([
		"Change a and remove b",
		"Second commit, reworded",
		"First commit",
	]);
	expect(await readFile(join(folder, "a.txt"), "utf8")).toBe("stashed\n");

	// Branches from the header: check out the feature branch.
	await pane.locator(".gp-branch").click();
	const popup = pane.locator(".gp-popover");
	await popup.getByRole("menuitem", { name: /^feature/ }).click();
	await menu.getByRole("menuitem", { name: "Checkout", exact: true }).click();
	// a.txt is changed here and differs on feature: Smart Checkout keeps the change.
	await pane.locator(".g-dialog").getByRole("button", { name: "Smart Checkout" }).click();
	await expect(pane.locator(".gp-branch")).toContainText("feature");
	expect(git(folder, "branch", "--show-current").trim()).toBe("feature");

	// The console lists what ran.
	await pane.getByRole("tab", { name: /Console/ }).click();
	await expect(pane.locator(".gp-console")).toContainText("git commit -m Change a and remove b");
	await expect(pane.locator(".gp-console")).toContainText("git switch feature");

	// The status bar shows the branch.
	await expect(page.locator(".ext-status-items")).toContainText("feature");
	expect(errors).toEqual([]);
	await app.close();
});
