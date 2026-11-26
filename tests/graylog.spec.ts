import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { fakeClaude } from "./fake-claude.js";
import { clickMenu, launch, stubOpenDialog, tempDir } from "./launch.js";
import { EXTENSIONS, PACK } from "./paths.js";

const SAMPLE = join(EXTENSIONS, "graylog");
const TOKEN = "gl-token-123";

interface Request {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
}

interface PivotRequest {
	queries: {
		filter?: unknown;
		query: { query_string: string };
		timerange: { type: string };
		search_types: {
			row_groups: { interval: { timeunit: string } }[];
			column_groups: { fields: string[] }[];
		}[];
	}[];
}

const MESSAGES = [
	{
		timestamp: "2026-11-25T10:00:02.000Z",
		source: "api-1",
		level: 3,
		message: "NullPointerException at OrderService.java:42",
		http_status: 500,
	},
	{
		timestamp: "2026-11-25T10:00:01.000Z",
		source: "db-1",
		level: 6,
		message: "checkpoint complete",
		http_status: 200,
	},
];

/** A stand-in for Graylog: the scripting API of 4.3+ (5, 6, 7), or only the older universal search (`legacy`). */
async function fakeGraylog(legacy = false) {
	const requests: Request[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => {
			raw += chunk;
		});
		request.on("end", () => {
			const url = new URL(request.url ?? "/", "http://graylog");
			requests.push({
				method: request.method ?? "",
				path: `${url.pathname}${url.search}`,
				body: raw === "" ? null : JSON.parse(raw),
			});
			const send = (status: number, body: unknown): void => {
				response.writeHead(status, { "Content-Type": "application/json" });
				response.end(JSON.stringify(body));
			};
			if (
				request.headers.authorization !==
				`Basic ${Buffer.from(`${TOKEN}:token`).toString("base64")}`
			) {
				send(401, { message: "Unauthorized" });
				return;
			}
			if (request.method === "POST" && request.headers["x-requested-by"] === undefined) {
				send(400, { message: "CSRF protection" });
				return;
			}
			const path = url.pathname;
			if (path === "/api/system")
				return send(200, { version: legacy ? "4.2.13+abc" : "6.1.4+0d0f2b1" });
			if (path === "/api/streams") {
				return send(200, {
					streams: [
						{ id: "000000000000000000000001", title: "Default Stream", disabled: false },
						{ id: "s-api", title: "API", disabled: false },
						{ id: "s-old", title: "Old", disabled: true },
					],
				});
			}
			if (!legacy && path === "/api/search/messages") {
				const fields = (JSON.parse(raw) as { fields: string[] }).fields;
				return send(200, {
					schema: fields.map((field) => ({
						column_type: "field",
						type: "string",
						field,
						name: `field: ${field}`,
					})),
					datarows: MESSAGES.map((message) =>
						fields.map((field) => message[field as keyof typeof message] ?? null),
					),
				});
			}
			if (!legacy && path === "/api/views/fields" && request.method === "POST") {
				return send(
					200,
					["timestamp", "source", "level", "message", "http_status", "gl2_source_input"].map(
						(name) => ({
							name,
							type: {
								type:
									name === "timestamp"
										? "date"
										: name === "level" || name === "http_status"
											? "long"
											: "string",
								properties: [],
								index_names: [],
							},
						}),
					),
				);
			}
			if (legacy && path === "/api/system/fields") {
				return send(200, { fields: ["message", "source", "timestamp", "level", "http_status"] });
			}
			if (!legacy && path === "/api/views/search/sync") {
				const spec = (JSON.parse(raw) as PivotRequest).queries[0].search_types[0];
				const split = spec.column_groups[0]?.fields[0];
				const minute = 60_000;
				const now = Math.floor(Date.now() / minute) * minute;
				const counts: [number, Record<string, number>][] = [
					[now - 3 * minute, { "3": 1, "6": 2 }],
					[now - 2 * minute, { "3": 4, "6": 1 }],
					[now - minute, { "6": 2 }],
				];
				return send(200, {
					execution: { done: true },
					results: {
						q: {
							state: "COMPLETED",
							search_types: {
								trend: {
									id: "trend",
									type: "pivot",
									total: 10,
									rows: [
										...counts.map(([time, byLevel]) => ({
											key: [new Date(time).toISOString()],
											source: "leaf",
											values: [
												...(split
													? Object.entries(byLevel).map(([level, value]) => ({
															key: [level, "count()"],
															value,
															rollup: false,
															source: "col-leaf",
														}))
													: []),
												{
													key: ["count()"],
													value: Object.values(byLevel).reduce((sum, each) => sum + each, 0),
													rollup: true,
													source: "row-leaf",
												},
											],
										})),
										{
											key: [],
											source: "non-leaf",
											values: [{ key: ["count()"], value: 10, rollup: true, source: "row-inner" }],
										},
									],
								},
							},
						},
					},
				});
			}
			if (!legacy && path === "/api/search/aggregate") {
				return send(200, {
					schema: [],
					datarows: [
						["api-1", 5],
						["db-1", 2],
					],
				});
			}
			if (
				legacy &&
				(path === "/api/search/universal/relative" || path === "/api/search/universal/absolute")
			) {
				return send(200, { total_results: 2, messages: MESSAGES.map((message) => ({ message })) });
			}
			if (legacy && path === "/api/search/universal/relative/terms") {
				return send(200, { terms: { "db-1": 2, "api-1": 5 } });
			}
			send(404, { type: "ApiError", message: "Not found" });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

async function installGraylog(
	page: Page,
	app: Parameters<typeof stubOpenDialog>[0],
	url: string,
): Promise<void> {
	const folder = await tempDir("graylog");
	const packagePath = join(folder, "graylog.kalem-ext");
	execFileSync(process.execPath, [PACK, SAMPLE, packagePath]);
	await stubOpenDialog(app, [packagePath]);
	await clickMenu(app, "Extensions", "Manage Extensions…");
	const settings = page.locator('[data-block="extensions"]');
	await settings.locator(".ext-intro").getByRole("button", { name: "Install from File…" }).click();
	const preview = settings.locator(".ext-preview");
	await expect(preview).toContainText("Connect to the address you enter in: Graylog address");
	await expect(preview).toContainText("Keep encrypted: Access token");
	await preview.getByRole("button", { name: "Install", exact: true }).click();
	const card = settings.locator('.ext-card[data-extension="kalem.graylog"]');
	await expect(card.locator(".ext-badge")).toHaveText("Running");
	const address = card.locator("label", { hasText: "Graylog address" }).locator("input");
	await address.fill(url);
	await address.press("Tab");
	await card.locator('input[type="password"]').fill(TOKEN);
	await card.getByRole("button", { name: "Save", exact: true }).click();
	await expect(card.locator('input[type="password"]')).toHaveAttribute("placeholder", "Saved");
}

const cleanup: (() => Promise<void>)[] = [];
test.afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

test("the Graylog extension's pane searches Graylog with the token, docked as Kalem's panes are", async () => {
	const graylog = await fakeGraylog();
	cleanup.push(graylog.close);
	const { app, page, errors } = await launch();
	await installGraylog(page, app, `${graylog.url}/`);

	const button = page.locator('.stripe-bottom [data-pane="ext:kalem.graylog/search"]');
	await expect(button).toBeVisible();
	await button.click();
	const dock = page.locator(".tool-dock.dock-bottom");
	await expect(dock.locator(".dock-title")).toHaveText("Graylog");
	const pane = page.frameLocator('iframe.ext-pane-frame[title="Graylog"]');
	await pane.locator("#query").fill("level:3");
	await pane.locator("#range").selectOption("60");
	await pane.locator("#stream").selectOption({ label: "API" });
	await expect(pane.locator("#stream option")).toHaveText(["All streams", "API", "Default Stream"]);
	await pane.locator("#go").click();
	await expect(pane.locator("#status")).toHaveText(/^2 of 2 messages/);
	await expect(pane.locator("tbody tr.row")).toHaveCount(2);
	await expect(pane.locator("tbody tr.row").first()).toContainText(
		"NullPointerException at OrderService.java:42",
	);
	await expect(pane.locator("tbody tr.row").first().locator(".level-error")).toHaveText("error");

	const search = graylog.requests.find((request) => request.path === "/api/search/messages");
	expect(search?.body).toEqual({
		query: "level:3",
		timerange: { type: "relative", range: 3600 },
		fields: ["timestamp", "source", "level", "message"],
		size: 100,
		streams: ["s-api"],
		sort: "timestamp",
		sort_order: "Descending",
	});

	await pane.locator("tbody tr.row").first().click();
	await expect(pane.locator("tr.detail")).toContainText("api-1");

	await dock.getByRole("button", { name: "Close" }).click();
	await expect(dock).toBeHidden();
	await clickMenu(app, "Extensions", "Graylog", "Open Graylog");
	await expect(dock).toBeVisible();
	await expect(dock.locator(".dock-title")).toHaveText("Graylog");
	expect(errors).toEqual([]);
});

test("the Graylog pane shows any of Graylog's fields, a trend over time, top values and saved searches", async () => {
	const graylog = await fakeGraylog();
	cleanup.push(graylog.close);
	const { app, page, errors } = await launch();
	await page.setViewportSize({ width: 1400, height: 950 });
	await installGraylog(page, app, graylog.url);
	await page.locator('.stripe-bottom [data-pane="ext:kalem.graylog/search"]').click();
	await page.evaluate(() => {
		(document.querySelector(".tool-dock.dock-bottom") as HTMLElement).style.height = "640px";
	});
	const pane = page.frameLocator('iframe.ext-pane-frame[title="Graylog"]');
	await pane.locator("#query").fill("level:3");
	await pane.locator("#go").click();
	await expect(pane.locator("tbody tr.row")).toHaveCount(2);

	// The trend: a bar per minute, the total and the peak; the query and the interval went to the pivot.
	const trend = pane.locator(".graylog-trend");
	await expect(trend.locator(".graylog-trend-info")).toContainText("10 messages");
	await expect(trend.locator(".graylog-trend-info")).toContainText("peak 5");
	await expect(trend.locator('.graylog-bar[data-total="5"]')).toHaveCount(1);
	const pivot = () =>
		(
			graylog.requests.filter((each) => each.path === "/api/views/search/sync").at(-1)
				?.body as PivotRequest
		).queries[0];
	expect(pivot().query.query_string).toBe("level:3");
	expect(pivot().search_types[0].row_groups[0].interval.timeunit).toBe("1m");
	await trend.getByLabel("Split by").selectOption("level");
	await expect(trend.locator(".graylog-legend")).toHaveText(/error.*info/);
	expect(pivot().search_types[0].column_groups[0].fields).toEqual(["level"]);

	// Every field of the stream, filtered; the one picked becomes a column.
	await pane.getByRole("button", { name: "Fields" }).click();
	const fields = pane.locator(".graylog-dialog");
	await expect(fields.locator(".graylog-field-item")).toHaveCount(6);
	await expect(fields.locator(".graylog-field-item").last()).toHaveAttribute(
		"data-field",
		"gl2_source_input",
	);
	await fields.getByLabel("Filter fields").fill("http");
	await expect(fields.locator(".graylog-field-item:not(:has(input:checked))")).toHaveCount(1);
	await fields.getByLabel("http_status").check();
	await fields.getByRole("button", { name: "Show" }).click();
	await expect(pane.locator("thead th")).toHaveText([
		"timestamp",
		"source",
		"level",
		"message",
		"http_status",
	]);
	const lastSearch = graylog.requests.filter((each) => each.path === "/api/search/messages").at(-1);
	expect((lastSearch?.body as { fields: string[] }).fields).toEqual([
		"timestamp",
		"source",
		"level",
		"message",
		"http_status",
	]);

	// A field's menu: its top values, and one of them added to the query.
	await pane.locator("thead").getByRole("button", { name: "source", exact: true }).click();
	await pane.getByRole("menuitem", { name: "Show top values" }).click();
	const top = pane.locator(".graylog-dialog");
	await expect(top.locator(".graylog-top-row")).toHaveCount(2);
	await expect(top.locator('.graylog-top-row[data-value="api-1"]')).toContainText("5 · 71%");
	await top
		.locator('.graylog-top-row[data-value="api-1"]')
		.getByRole("button", { name: "Add to query" })
		.click();
	await expect(pane.locator("#query")).toHaveValue("(level:3) AND source:api-1");

	// A value's menu: left out of the results.
	await pane.locator("tbody tr.row").first().click();
	await pane.locator("tr.detail").getByRole("button", { name: "500", exact: true }).click();
	await pane.getByRole("menuitem", { name: "Exclude from results" }).click();
	await expect(pane.locator("#query")).toHaveValue(
		"((level:3) AND source:api-1) AND NOT http_status:500",
	);

	// Saved: one click away, with its fields.
	await pane.getByRole("button", { name: "Save this search" }).click();
	const save = pane.locator(".graylog-dialog");
	await save.getByLabel("Name").fill("API errors");
	await save.getByRole("button", { name: "Save", exact: true }).click();
	await pane.locator("#query").fill("*");
	await pane.locator("#go").click();
	await pane
		.locator('.graylog-chip[data-saved="API errors"]')
		.getByRole("button", { name: "API errors", exact: true })
		.click();
	await expect(pane.locator("#query")).toHaveValue(
		"((level:3) AND source:api-1) AND NOT http_status:500",
	);

	// Dragging over the chart zooms into that time.
	const plot = trend.locator(".graylog-plot");
	const box = (await plot.boundingBox()) as { x: number; y: number; width: number; height: number };
	await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 5 });
	await page.mouse.up();
	await expect(pane.locator("#range")).toHaveValue("zoom");
	await expect.poll(() => pivot().timerange.type).toBe("absolute");
	await trend.getByRole("button", { name: /Back to/ }).click();
	await expect(pane.locator("#range")).toHaveValue("15");
	expect(errors).toEqual([]);
});

test("the assistant searches Graylog through the extension's tools, also on a Graylog without the scripting API", async () => {
	test.skip(process.platform === "win32", "The stand-in CLI is a Unix script.");
	const graylog = await fakeGraylog(true);
	cleanup.push(graylog.close);
	const folder = await tempDir("graylog-agent");
	const claude = await fakeClaude(folder, "İki hata buldum.", [
		{ name: "graylog_streams", input: {} },
		{ name: "graylog_top_values", input: { field: "source", query: "level:3", minutes: 60 } },
		{ name: "graylog_search", input: { query: "level:3", minutes: 60, limit: 20 } },
		{ name: "graylog_fields", input: {} },
		{
			name: "graylog_trend",
			input: {
				query: "*",
				from: "2026-11-25T09:59:00Z",
				to: "2026-11-25T10:01:00Z",
				splitBy: "level",
			},
		},
	]);
	const { app, page } = await launch({
		settings: { assistant: true },
		env: { KALEM_CLAUDE: claude.path },
	});
	await installGraylog(page, app, graylog.url);
	await page.keyboard.press("Escape");

	const assistant = page.locator(".assistant");
	await assistant.locator(".assistant-input").fill("Son bir saatteki hataları bul");
	await assistant.locator(".assistant-input").press("Enter");
	await expect(
		assistant.locator(".assistant-assistant").last().locator(".assistant-markdown"),
	).toContainText("İki hata buldum.");

	const [call] = await claude.calls();
	const [streams, top, search, fields, trend] = call?.tools ?? [];
	expect(fields?.text).toBe("http_status\nlevel\nmessage\nsource\ntimestamp");
	expect(trend?.text).toBe(
		[
			"2 message(s) from 2026-11-25T09:59Z to 2026-11-25T10:01Z, in bars of 1 minute(s).",
			"Peak: 2 at 2026-11-25T10:00Z.",
			"Split by level: 3, 6",
			"2026-11-25T10:00Z 2 (3=1, 6=1)",
		].join("\n"),
	);
	expect(streams?.text).toBe(
		"Graylog 4.2.13\ns-api: API\n000000000000000000000001: Default Stream",
	);
	expect(top?.text).toBe("api-1: 5\ndb-1: 2");
	expect(search?.text).toBe(
		[
			"2 message(s), newest first. Fields: timestamp | source | level | message",
			"2026-11-25T10:00:02.000Z | api-1 | 3 | NullPointerException at OrderService.java:42",
			"2026-11-25T10:00:01.000Z | db-1 | 6 | checkpoint complete",
		].join("\n"),
	);
	const legacy = graylog.requests.find((request) =>
		request.path.startsWith("/api/search/universal/relative?"),
	);
	const params = new URL(`http://x${legacy?.path}`).searchParams;
	expect(Object.fromEntries(params)).toEqual({
		query: "level:3",
		limit: "20",
		fields: "timestamp,source,level,message",
		sort: "timestamp:desc",
		range: "3600",
	});
});
