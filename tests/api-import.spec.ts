import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { calculatorWsdl, fakeApi, fakeSoap, installSample } from "./api-fakes.js";
import { launch, tempDir } from "./launch.js";

const cleanup: (() => Promise<void>)[] = [];
test.afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

const pasteInto = async (
	frame: import("@playwright/test").FrameLocator,
	selector: string,
	text: string,
) =>
	frame.locator(selector).evaluate((input, value) => {
		const data = new DataTransfer();
		data.setData("text/plain", value);
		input.dispatchEvent(
			new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
		);
	}, text);

test("the REST client imports a request copied from the browser as cURL, fetch or a Postman collection", async () => {
	const api = await fakeApi();
	cleanup.push(api.close);
	const { app, page, errors } = await launch();
	await page.setViewportSize({ width: 1400, height: 900 });
	const rest = await installSample(app, page, "rest-client", "client", "REST");

	await rest.getByRole("button", { name: "Import" }).click();
	const dialog = rest.locator(".rest-dialog");
	await dialog.getByLabel("Text to import").fill(`curl '${api.url}/users' \\
  -H 'accept: application/json' \\
  -H 'authorization: Bearer abc' \\
  -H 'content-type: application/json' \\
  -H 'sec-ch-ua: "Chromium";v="130"' \\
  -H 'user-agent: Mozilla/5.0' \\
  --data-raw $'{"name":"Ay\\u015fe","note":"it\\'s"}'`);
	await expect(dialog.locator(".rest-import-found")).toContainText("cURL");
	await expect(dialog.locator(".rest-import-list .k-list-item")).toHaveCount(1);
	await dialog.getByRole("button", { name: "Open", exact: true }).click();

	await expect(rest.getByLabel("Method")).toHaveValue("POST");
	await expect(rest.getByLabel("URL")).toHaveValue(`${api.url}/users`);
	await rest.getByRole("tab", { name: /Body/ }).click();
	await expect(rest.locator(".rest-body")).toHaveValue(
		'{\n  "name": "Ayşe",\n  "note": "it\'s"\n}',
	);
	await rest.getByRole("tab", { name: /Auth/ }).click();
	await expect(rest.locator(".rest-auth input")).toHaveValue("abc");
	await rest
		.getByRole("tab", { name: /Headers/ })
		.first()
		.click();
	await expect(rest.locator('.k-kv input[data-col="key"]')).toHaveCount(2);
	await expect(rest.locator('.k-kv input[data-col="key"]').first()).toHaveValue("accept");
	await rest.getByRole("button", { name: "Send" }).click();
	await expect(rest.locator(".rest-status")).toHaveText("201 Created");
	expect(api.seen.at(-1)?.headers.authorization).toBe("Bearer abc");
	expect(JSON.parse(api.seen.at(-1)?.body ?? "{}")).toEqual({ name: "Ayşe", note: "it's" });

	await rest.getByRole("button", { name: "New request" }).click();
	await pasteInto(
		rest,
		".rest-url",
		`fetch("${api.url}/users?page=3", {\n  "headers": { "authorization": "Bearer s3cret" },\n  "body": null,\n  "method": "GET"\n});`,
	);
	await expect(rest.getByLabel("URL")).toHaveValue(`${api.url}/users?page=3`);
	await rest.getByRole("button", { name: "Send" }).click();
	await expect(rest.locator(".rest-status")).toHaveText("200 OK");
	expect(api.seen.at(-1)?.url).toBe("/users?page=3");

	const collection = {
		info: {
			name: "Acme",
			schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
		},
		variable: [{ key: "baseUrl", value: api.url }],
		item: [
			{
				name: "Users",
				item: [
					{
						name: "List",
						request: {
							method: "GET",
							url: { raw: "{{baseUrl}}/users" },
							auth: { type: "bearer", bearer: [{ key: "token", value: "s3cret" }] },
						},
					},
					{
						name: "Create",
						request: {
							method: "POST",
							url: "{{baseUrl}}/users",
							body: { mode: "raw", raw: '{"name":"Can"}', options: { raw: { language: "json" } } },
						},
					},
				],
			},
		],
	};
	const file = join(await tempDir("postman"), "acme.postman_collection.json");
	await writeFile(file, JSON.stringify(collection));
	await rest.getByRole("button", { name: "Import" }).click();
	await dialog.getByLabel("Choose a file").setInputFiles(file);
	await expect(dialog.locator(".rest-import-found")).toContainText("Postman");
	await expect(dialog.locator(".rest-import-found")).toContainText("1 variables");
	await dialog.getByRole("button", { name: "Add 2 to the collection" }).click();
	await expect(rest.locator('.rest-list [data-request="Users / List"]')).toBeVisible();
	await expect(rest.locator('.rest-list [data-request="Users / Create"]')).toBeVisible();
	await expect(rest.locator(".rest-env option:checked")).toHaveText("Acme");
	await rest.locator('.rest-list [data-request="Users / List"]').click();
	await rest.getByRole("button", { name: "Send" }).click();
	await expect(rest.locator(".rest-status")).toHaveText("200 OK");
	expect(api.seen.at(-1)?.headers.authorization).toBe("Bearer s3cret");
	expect(errors).toEqual([]);
});

test("the SOAP client imports a call copied as cURL, into the loaded WSDL's operation or on its own, and a WSDL as text", async () => {
	const soap = await fakeSoap();
	cleanup.push(soap.close);
	const endpoint = soap.wsdl.replace("?wsdl", "");
	const { app, page, errors } = await launch();
	await page.setViewportSize({ width: 1400, height: 900 });
	const client = await installSample(app, page, "soap-client", "client", "SOAP");
	const envelope = (a: number, b: number) =>
		`<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://acme.example/calc"><soapenv:Body><ns1:Add><ns1:intA>${a}</ns1:intA><ns1:intB>${b}</ns1:intB></ns1:Add></soapenv:Body></soapenv:Envelope>`;
	const curl = (a: number, b: number) =>
		`curl '${endpoint}' -H 'Content-Type: text/xml; charset=utf-8' -H 'SOAPAction: "http://acme.example/calc/Add"' -H 'Authorization: Basic YWRtaW46cHc=' -H 'X-Correlation-Id: 7' --data-raw '${envelope(a, b)}'`;

	await client.getByRole("button", { name: "Import" }).click();
	const dialog = client.locator(".soap-dialog");
	await dialog.getByLabel("Text to import").fill(curl(4, 5));
	await expect(dialog.locator(".soap-import-found")).toContainText("Kept under Imported requests");
	await dialog.getByRole("button", { name: "Open", exact: true }).click();
	await expect(client.locator(".soap-wsdl-head")).toContainText("Imported requests");
	await expect(client.getByLabel("Endpoint")).toHaveValue(endpoint);
	await expect(client.locator(".soap-editor-input")).toHaveValue(/<ns1:intA>4<\/ns1:intA>/);
	await client.getByRole("button", { name: "Send" }).click();
	await expect(client.locator(".soap-response")).toContainText("<AddResult>9</AddResult>");
	expect(soap.seen.at(-1)?.headers.soapaction).toBe('"http://acme.example/calc/Add"');
	expect(soap.seen.at(-1)?.headers.authorization).toBe("Basic YWRtaW46cHc=");
	expect(soap.seen.at(-1)?.headers["x-correlation-id"]).toBe("7");

	await client.getByLabel("WSDL address").fill(soap.wsdl);
	await client.getByRole("button", { name: "Load" }).click();
	await expect(client.locator(".soap-wsdl-head")).toContainText("Calculator");
	await client.getByRole("button", { name: "Import" }).click();
	await dialog.getByLabel("Text to import").fill(curl(10, 20));
	await expect(dialog.locator(".soap-import-found")).toContainText(
		"Opens in the loaded WSDL's Add operation",
	);
	await dialog.getByRole("button", { name: "Open in Add" }).click();
	await expect(
		client.locator('.soap-ops [data-operation="Add"][aria-selected="true"]'),
	).toHaveCount(1);
	await expect(client.locator(".soap-editor-input")).toHaveValue(/<ns1:intA>10<\/ns1:intA>/);
	await client.getByRole("button", { name: "Send" }).click();
	await expect(client.locator(".soap-response")).toContainText("<AddResult>30</AddResult>");

	const file = join(await tempDir("wsdl"), "Calculator.wsdl");
	await writeFile(file, calculatorWsdl(endpoint));
	await client.getByRole("button", { name: "Import" }).click();
	await dialog.getByLabel("Choose a file").setInputFiles(file);
	await expect(dialog.locator(".soap-import-found")).toContainText("WSDL");
	await dialog.getByRole("button", { name: "Open the WSDL" }).click();
	await expect(client.locator(".soap-port-head")).toHaveCount(2);
	await expect(client.getByLabel("WSDL address")).toHaveValue("");
	expect(errors).toEqual([]);
});
