/** Pieces both pages use: a context menu, a small window, a notice. */
import { el, fill, icon } from "./dom.js";

/** An error from the host code, without its stack. */
export function errorText(error) {
	const text = error instanceof Error ? error.message : String(error);
	return text
		.split("\n")
		.filter((line) => !/^\s+at\s/.test(line))
		.join("\n")
		.replace(/^(?:Git)?(?:Error|GitFailure): /, "")
		.trim();
}

let openMenu = null;

export function closeMenu() {
	openMenu?.remove();
	openMenu = null;
}

document.addEventListener("pointerdown", (event) => {
	if (openMenu !== null && !openMenu.contains(event.target)) closeMenu();
});
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && openMenu !== null) {
		event.stopPropagation();
		closeMenu();
	}
});
window.addEventListener("blur", () => closeMenu());

/**
 * Items: `{ label, run, shortcut, danger, disabled, icon, items }` (`items`
 * opens a submenu), `null` for a line, `{ heading }` for a title.
 */
export function showMenu(items, x, y, { parent = null } = {}) {
	if (parent === null) closeMenu();
	const menu = el("div", { class: "g-menu", role: "menu" });
	const buttons = [];
	for (const item of items) {
		if (item === null) {
			menu.append(el("div", { class: "g-menu-line", role: "separator" }));
			continue;
		}
		if (item.heading !== undefined) {
			menu.append(el("div", { class: "g-menu-heading", text: item.heading }));
			continue;
		}
		const button = el(
			"button",
			{
				class: `g-menu-item${item.danger ? " danger" : ""}`,
				type: "button",
				role: "menuitem",
				disabled: item.disabled ? true : undefined,
				tabindex: "-1",
			},
			[
				el("span", { class: "g-menu-icon" }, [item.icon ? icon(item.icon) : null]),
				el("span", { class: "g-menu-label", text: item.label }),
				el("span", { class: "g-menu-shortcut", text: item.items ? "›" : (item.shortcut ?? "") }),
			],
		);
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			if (item.items) {
				const box = button.getBoundingClientRect();
				menu.querySelector(".g-menu.sub")?.remove();
				const sub = showMenu(item.items, box.right - 2, box.top - 4, { parent: menu });
				sub.classList.add("sub");
				return;
			}
			closeMenu();
			item.run?.();
		});
		button.addEventListener("pointerenter", () => {
			if (!item.items) menu.querySelector(".g-menu.sub")?.remove();
			else if (!menu.querySelector(".g-menu.sub")) button.click();
			button.focus();
		});
		buttons.push(button);
		menu.append(button);
	}
	menu.addEventListener("keydown", (event) => {
		const index = buttons.indexOf(document.activeElement);
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			for (let i = 1; i <= buttons.length; i++) {
				const next = buttons[(index + step * i + buttons.length * 2) % buttons.length];
				if (!next.disabled) {
					next.focus();
					break;
				}
			}
		} else if (event.key === "ArrowRight" && index >= 0) {
			buttons[index].click();
		} else if (event.key === "ArrowLeft" && parent !== null) {
			menu.remove();
		}
	});
	(parent ?? document.body).append(menu);
	if (parent === null) openMenu = menu;
	const box = menu.getBoundingClientRect();
	const left = Math.max(4, Math.min(x, window.innerWidth - box.width - 4));
	const top = Math.max(4, Math.min(y, window.innerHeight - box.height - 4));
	if (parent === null) {
		menu.style.left = `${left}px`;
		menu.style.top = `${top}px`;
	} else {
		const host = parent.getBoundingClientRect();
		menu.style.left = `${(x + box.width > window.innerWidth ? x - box.width - (host.width - 4) : x) - host.left}px`;
		menu.style.top = `${top - host.top}px`;
	}
	buttons.find((button) => !button.disabled)?.focus();
	return menu;
}

export function menuAt(event, items) {
	event.preventDefault();
	event.stopPropagation();
	showMenu(items, event.clientX, event.clientY);
}

export function menuBelow(element, items) {
	const box = element.getBoundingClientRect();
	return showMenu(items, box.left, box.bottom + 2);
}

/**
 * A small window in the page. `fields`: `{ key, label, value, multiline,
 * placeholder, type: "text" | "checkbox" | "select", options }`. Resolves to
 * the values by key, or `null` when cancelled.
 */
export function dialog({ title, text = "", fields = [], ok, cancel, danger = false, check, extra = null }) {
	return new Promise((resolve) => {
		const inputs = new Map();
		const error = el("p", { class: "g-dialog-error", role: "alert", hidden: true });
		const rows = fields.map((field) => {
			let input;
			if (field.type === "checkbox") {
				input = el("input", { type: "checkbox", checked: field.value ? true : undefined });
				inputs.set(field.key, input);
				return el("label", { class: "g-dialog-check" }, [input, el("span", { text: field.label })]);
			}
			if (field.type === "select") {
				input = el(
					"select",
					{ class: "k-select" },
					field.options.map((option) =>
						el("option", { value: option.value, text: option.label, selected: option.value === field.value ? true : undefined }),
					),
				);
			} else if (field.multiline) {
				input = el("textarea", { class: "k-textarea", rows: "5", spellcheck: "true", placeholder: field.placeholder });
				input.value = field.value ?? "";
			} else {
				input = el("input", {
					class: "k-input",
					type: "text",
					spellcheck: "false",
					autocomplete: "off",
					placeholder: field.placeholder,
				});
				input.value = field.value ?? "";
			}
			inputs.set(field.key, input);
			return el("label", { class: "g-dialog-field" }, [el("span", { text: field.label }), input]);
		});
		const values = () => {
			const result = {};
			for (const [key, input] of inputs) result[key] = input.type === "checkbox" ? input.checked : input.value.trim();
			return result;
		};
		const finish = (value) => {
			overlay.remove();
			document.removeEventListener("keydown", onKey, true);
			resolve(value);
		};
		const submit = () => {
			const result = values();
			const problem = check?.(result) ?? null;
			if (problem) {
				error.textContent = problem;
				error.hidden = false;
				return;
			}
			finish(result);
		};
		const okButton = el("button", {
			class: `k-button ${danger ? "stop" : "primary"}`,
			type: "button",
			text: ok,
			onclick: submit,
		});
		const cancelButton = el("button", { class: "k-button", type: "button", text: cancel, onclick: () => finish(null) });
		const box = el("div", { class: "g-dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, [
			el("h2", { text: title }),
			text ? el("p", { class: "g-dialog-text", text }) : null,
			...rows,
			extra,
			error,
			el("div", { class: "g-dialog-actions" }, [cancelButton, okButton]),
		]);
		const overlay = el("div", { class: "g-overlay" }, [box]);
		overlay.addEventListener("pointerdown", (event) => {
			if (event.target === overlay) finish(null);
		});
		const onKey = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				finish(null);
			} else if (event.key === "Enter" && (event.target.tagName !== "TEXTAREA" || event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				submit();
			}
		};
		document.addEventListener("keydown", onKey, true);
		document.body.append(overlay);
		const first = [...inputs.values()].find((input) => input.type !== "checkbox");
		if (first) {
			first.focus();
			first.select?.();
		} else okButton.focus();
	});
}

let noticeTimer = 0;

export function notice(text, kind = "info") {
	let box = document.querySelector(".g-notice");
	if (box === null) {
		box = el("div", { class: "g-notice", role: "status" });
		document.body.append(box);
	}
	box.className = `g-notice ${kind}`;
	fill(box, 
		el("span", { text }),
		el("button", { class: "k-button small ghost icon", type: "button", "aria-label": "×", onclick: () => box.remove() }, [icon("close")]),
	);
	clearTimeout(noticeTimer);
	noticeTimer = setTimeout(() => box.remove(), kind === "error" ? 12_000 : 4000);
}

export function relativeTime(time, language) {
	const seconds = Math.round((Date.now() - time) / 1000);
	const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
	if (seconds < 60) return format.format(-seconds, "second");
	if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
	if (seconds < 86400) return format.format(-Math.round(seconds / 3600), "hour");
	if (seconds < 7 * 86400) return format.format(-Math.round(seconds / 86400), "day");
	return new Date(time).toLocaleDateString(language);
}

export const dateTime = (time, language) =>
	new Date(time).toLocaleString(language, { dateStyle: "short", timeStyle: "short" });

export const KIND_LETTER = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflict: "!" };

export const splitPath = (path) => {
	const index = path.lastIndexOf("/");
	return index === -1 ? { name: path, folder: "" } : { name: path.slice(index + 1), folder: path.slice(0, index) };
};
