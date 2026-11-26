import { faultOf, readWsdl } from "./wsdl.js";

const MAX_RECENT = 12;
const IMPORTED = "kalem:imported";
const TEXT = "text:";
const MAX_TOOL_BODY = 30_000;

export async function activate(kalem) {
	const read = async (key, fallback) => (await kalem.storage.get(key)) ?? fallback;
	const loaded = new Map();

	async function fetchText(url, headers = {}) {
		const response = await kalem.http.fetch(url, {
			headers: { Accept: "text/xml, application/xml, */*", ...headers },
			timeoutMs: 60_000,
		});
		if (!response.ok)
			throw new Error(`${url}: the server answered ${response.status} ${response.statusText}`);
		return response.body;
	}

	/** Calls imported from cURL and the like, as a WSDL-shaped list grouped by endpoint. */
	async function importedWorkspace() {
		const ports = new Map();
		for (const item of await read("imported", [])) {
			const group = `${item.version} ${item.endpoint}`;
			if (!ports.has(group)) {
				let name = item.endpoint;
				try {
					name = new URL(item.endpoint).host;
				} catch {
					name = item.endpoint || "—";
				}
				ports.set(group, {
					name,
					version: item.version,
					endpoint: item.endpoint,
					operations: [],
				});
			}
			ports.get(group).operations.push({
				id: item.id,
				name: item.name,
				action: item.action,
				documentation: item.endpoint,
				sample: item.envelope,
				headers: item.headers,
				username: item.username,
				password: item.password,
			});
		}
		return {
			url: IMPORTED,
			name: "Imported requests",
			imported: true,
			targetNamespace: "",
			services: ports.size === 0 ? [] : [{ name: "Imported", ports: [...ports.values()] }],
		};
	}

	/** A WSDL's services and operations, each with its sample request (as plain data). */
	async function load(url, force = false) {
		const address = String(url ?? "").trim();
		if (address === "") throw new Error("Give the WSDL's address (…?wsdl).");
		if (address === IMPORTED) return importedWorkspace();
		if (!force && loaded.has(address)) return loaded.get(address);
		const isText = address.startsWith(TEXT);
		const source = isText ? (await read("wsdlTexts", {}))[address] : await fetchText(address);
		if (source === undefined)
			throw new Error("This WSDL was imported as text and is not kept any more.");
		const wsdl = await readWsdl(source, isText ? "" : address, (target) => fetchText(target));
		const plain = {
			url: address,
			name: wsdl.name,
			targetNamespace: wsdl.targetNamespace,
			services: wsdl.services.map((service) => ({
				name: service.name,
				ports: service.ports.map((port) => ({
					name: port.name,
					version: port.version,
					endpoint: port.endpoint,
					operations: port.operations.map((operation) => ({
						name: operation.name,
						action: operation.action,
						documentation: operation.documentation,
						sample: operation.sample(),
					})),
				})),
			})),
		};
		loaded.set(address, plain);
		const recent = (await read("recent", [])).filter((each) => each.url !== address);
		recent.unshift({ url: address, name: plain.name });
		await kalem.storage.set("recent", recent.slice(0, MAX_RECENT));
		return plain;
	}

	async function call(input) {
		const version = input?.version === "1.2" ? "1.2" : "1.1";
		const endpoint = String(input?.endpoint ?? "").trim();
		if (endpoint === "") throw new Error("Give the endpoint's address.");
		const action = String(input?.action ?? "");
		const headers = {
			...(version === "1.1"
				? { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${action}"` }
				: {
						"Content-Type": `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ""}`,
					}),
			...(input?.headers ?? {}),
		};
		if (input?.username) {
			const bytes = new TextEncoder().encode(`${input.username}:${input.password ?? ""}`);
			headers.Authorization = `Basic ${btoa(String.fromCharCode(...bytes))}`;
		}
		const started = performance.now();
		const response = await kalem.http.fetch(endpoint, {
			method: "POST",
			headers,
			body: String(input?.envelope ?? ""),
			timeoutMs: 120_000,
		});
		const time = Math.round(performance.now() - started);
		return {
			...response,
			time,
			size: new TextEncoder().encode(response.body).byteLength,
			fault: faultOf(response.body),
			sentHeaders: headers,
		};
	}

	const recentList = async () => [
		...((await read("imported", [])).length > 0
			? [{ url: IMPORTED, name: "Imported requests" }]
			: []),
		...(await read("recent", [])),
	];
	await kalem.ui.handle("recent", recentList);
	await kalem.ui.handle("loadText", async (input) => {
		const text = String(input?.text ?? "");
		const name = String(input?.name ?? "").trim() || /name="([^"]+)"/.exec(text)?.[1] || "WSDL";
		const url = `${TEXT}${name}`;
		const texts = await read("wsdlTexts", {});
		texts[url] = text;
		await kalem.storage.set("wsdlTexts", texts);
		return load(url, true);
	});
	await kalem.ui.handle("importCalls", async (input) => {
		const imported = await read("imported", []);
		const ids = [];
		for (const call of Array.isArray(input?.calls) ? input.calls : []) {
			const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
			ids.push(id);
			imported.push({
				id,
				name: String(call.name || "Request"),
				version: call.version === "1.2" ? "1.2" : "1.1",
				endpoint: String(call.endpoint ?? ""),
				action: String(call.action ?? ""),
				envelope: String(call.envelope ?? ""),
				headers: call.headers && typeof call.headers === "object" ? call.headers : {},
				username: String(call.username ?? ""),
				password: String(call.password ?? ""),
			});
		}
		await kalem.storage.set("imported", imported);
		return { workspace: await importedWorkspace(), ids };
	});
	await kalem.ui.handle("forgetImported", async (id) => {
		await kalem.storage.set(
			"imported",
			(await read("imported", [])).filter((each) => each.id !== id),
		);
		return importedWorkspace();
	});
	await kalem.ui.handle("forget", async (url) => {
		if (url === IMPORTED) {
			await kalem.storage.set("imported", []);
			return recentList();
		}
		if (String(url).startsWith(TEXT)) {
			const texts = await read("wsdlTexts", {});
			delete texts[url];
			await kalem.storage.set("wsdlTexts", texts);
		}
		await kalem.storage.set(
			"recent",
			(await read("recent", [])).filter((each) => each.url !== url),
		);
		loaded.delete(url);
		return recentList();
	});
	await kalem.ui.handle("load", (input) => load(input?.url, input?.force === true));
	await kalem.ui.handle("call", call);
	await kalem.ui.handle("envelopes", () => read("envelopes", {}));
	await kalem.ui.handle("keepEnvelope", async (input) => {
		const envelopes = await read("envelopes", {});
		if (input?.text) envelopes[input.key] = input.text;
		else delete envelopes[input?.key];
		await kalem.storage.set("envelopes", envelopes);
		return null;
	});
	await kalem.commands.register("open", () => kalem.ui.showPane("client"));

	const findOperation = (wsdl, name) => {
		for (const service of wsdl.services) {
			for (const port of service.ports) {
				const operation = port.operations.find((each) => each.name === name);
				if (operation) return { port, operation };
			}
		}
		return null;
	};

	await kalem.assistant.registerTool(
		{
			name: "soap_operations",
			description:
				"Reads a WSDL and lists its services, endpoints, SOAP versions and operations (with their SOAPAction).",
			parameters: {
				type: "object",
				properties: { wsdl: { type: "string", description: "The WSDL's address." } },
				required: ["wsdl"],
			},
		},
		async (input) => {
			const wsdl = await load(input?.wsdl);
			return wsdl.services
				.flatMap((service) =>
					service.ports.map(
						(port) =>
							`${service.name} / ${port.name} (SOAP ${port.version}) at ${port.endpoint}\n${port.operations.map((operation) => `  - ${operation.name}${operation.action ? ` [${operation.action}]` : ""}${operation.documentation ? `: ${operation.documentation}` : ""}`).join("\n")}`,
					),
				)
				.join("\n\n");
		},
	);
	await kalem.assistant.registerTool(
		{
			name: "soap_sample_request",
			description:
				"Returns a sample SOAP envelope for one of a WSDL's operations, made from its schema, to fill in.",
			parameters: {
				type: "object",
				properties: { wsdl: { type: "string" }, operation: { type: "string" } },
				required: ["wsdl", "operation"],
			},
		},
		async (input) => {
			const found = findOperation(await load(input?.wsdl), input?.operation);
			return found === null
				? `There is no operation named ${input?.operation}.`
				: found.operation.sample;
		},
	);
	await kalem.assistant.registerTool(
		{
			name: "soap_call",
			description:
				"Calls a SOAP operation of a WSDL with the envelope given, and returns the response (and its fault, if any). The user is asked before each call.",
			parameters: {
				type: "object",
				properties: {
					wsdl: { type: "string" },
					operation: { type: "string" },
					envelope: { type: "string", description: "The whole SOAP envelope." },
				},
				required: ["wsdl", "operation", "envelope"],
			},
			writes: true,
		},
		async (input) => {
			const found = findOperation(await load(input?.wsdl), input?.operation);
			if (found === null) return `There is no operation named ${input?.operation}.`;
			const result = await call({
				version: found.port.version,
				endpoint: found.port.endpoint,
				action: found.operation.action,
				envelope: input.envelope,
			});
			const body =
				result.body.length > MAX_TOOL_BODY
					? `${result.body.slice(0, MAX_TOOL_BODY)}\n…`
					: result.body;
			const fault = result.fault
				? `\nSOAP fault ${result.fault.code}: ${result.fault.message}`
				: "";
			return `${result.status} ${result.statusText} in ${result.time} ms${fault}\n\n${body}`;
		},
	);
}
