/**
 * A small stand-in for the parts of the Obsidian API the view and store use, so the real
 * view code can run in a plain browser page for visual testing (see dev/shoot.mjs).
 * Not shipped with the plugin.
 */
import momentLib from "moment";
import { marked } from "marked";
import * as lucide from "lucide";

export const moment = momentLib;

// ------------------------------------------------------------------ DOM helpers Obsidian adds

type ElOpts = string | { cls?: string | string[]; text?: string; attr?: Record<string, string>; type?: string; value?: string; href?: string };

function applyOpts(el: HTMLElement, o?: ElOpts) {
	if (!o) return;
	if (typeof o === "string") {
		el.className = o;
		return;
	}
	if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
	if (o.text !== undefined) el.textContent = o.text;
	if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
	if (o.type) el.setAttribute("type", o.type);
	if (o.value !== undefined) (el as HTMLInputElement).value = o.value;
	if (o.href) el.setAttribute("href", o.href);
}

export function installDomHelpers() {
	const P = Node.prototype as any;
	const E = HTMLElement.prototype as any;
	P.createEl = function (tag: string, o?: ElOpts) {
		const el = document.createElement(tag);
		applyOpts(el, o);
		this.appendChild(el);
		return el;
	};
	P.createDiv = function (o?: ElOpts) {
		return this.createEl("div", o);
	};
	P.createSpan = function (o?: ElOpts) {
		return this.createEl("span", o);
	};
	P.empty = function () {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	P.setText = function (t: string) {
		this.textContent = t;
	};
	P.appendText = function (t: string) {
		this.appendChild(document.createTextNode(t));
	};
	E.addClass = function (...c: string[]) {
		this.classList.add(...c.flatMap((x) => x.split(" ").filter(Boolean)));
	};
	E.removeClass = function (...c: string[]) {
		this.classList.remove(...c);
	};
	E.toggleClass = function (c: string, v: boolean) {
		this.classList.toggle(c, v);
	};
	E.hasClass = function (c: string) {
		return this.classList.contains(c);
	};
	E.setAttr = function (k: string, v: string) {
		this.setAttribute(k, v);
	};
	E.getAttr = function (k: string) {
		return this.getAttribute(k);
	};
	E.toggle = function (show: boolean) {
		this.style.display = show ? "" : "none";
	};
	(window as any).createDiv = (o?: ElOpts) => {
		const el = document.createElement("div");
		applyOpts(el, o);
		return el;
	};
}

// ------------------------------------------------------------------ classes

export class Events {
	private handlers = new Map<string, ((...a: any[]) => any)[]>();
	on(name: string, cb: (...a: any[]) => any) {
		const list = this.handlers.get(name) ?? [];
		list.push(cb);
		this.handlers.set(name, list);
		return { name, cb };
	}
	trigger(name: string, ...data: any[]) {
		for (const cb of this.handlers.get(name) ?? []) cb(...data);
	}
}

export class Component {
	private cleanups: (() => void)[] = [];
	private children: Component[] = [];
	_loaded = false;
	load() {
		this._loaded = true;
	}
	unload() {
		this.children.forEach((c) => c.unload());
		this.cleanups.forEach((f) => f());
		this.cleanups = [];
		this._loaded = false;
	}
	addChild<T extends Component>(c: T): T {
		this.children.push(c);
		c.load();
		return c;
	}
	removeChild<T extends Component>(c: T): T {
		this.children = this.children.filter((x) => x !== c);
		c.unload();
		return c;
	}
	register(f: () => void) {
		this.cleanups.push(f);
	}
	registerEvent(_ref: unknown) {}
	registerDomEvent(el: EventTarget, type: string, cb: any, opts?: any) {
		el.addEventListener(type, cb, opts);
		this.register(() => el.removeEventListener(type, cb, opts));
	}
	registerInterval(id: number) {
		this.register(() => window.clearInterval(id));
		return id;
	}
}

export class TAbstractFile {
	path = "";
}
export class TFile extends TAbstractFile {
	basename: string;
	extension = "md";
	constructor(path: string) {
		super();
		this.path = path;
		this.basename = path.split("/").pop()!.replace(/\.md$/, "");
	}
}
export type WorkspaceLeaf = any;
export type App = any;

type KeyHandler = (evt: KeyboardEvent, ctx: unknown) => boolean | void;
export class Scope {
	handlers: { mods: string[]; key: string; fn: KeyHandler }[] = [];
	constructor(public parent?: unknown) {}
	register(mods: string[] | null, key: string, fn: KeyHandler) {
		this.handlers.push({ mods: mods ?? [], key, fn });
	}
	/** Stand-in for Obsidian's keymap: run the first matching handler. */
	handle(evt: KeyboardEvent) {
		for (const h of this.handlers) {
			if (h.key.toLowerCase() !== evt.key.toLowerCase()) continue;
			if (h.mods.includes("Shift") !== evt.shiftKey) continue;
			if (h.fn(evt, {}) === false) {
				evt.preventDefault();
				return;
			}
		}
	}
}

export class ItemView extends Component {
	app: any;
	containerEl: HTMLElement;
	contentEl: HTMLElement;
	scope: Scope | null = null;
	constructor(public leaf: any) {
		super();
		this.app = leaf.app;
		this.containerEl = leaf.containerEl;
		this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
	}
}

export const Keymap = {
	isModEvent: (e: MouseEvent | KeyboardEvent) => e.metaKey || e.ctrlKey,
};

export class Notice {
	constructor(msg: string) {
		console.log("[Notice]", msg);
	}
}

export const Platform = { isMobile: false, isPhone: false, isTablet: false, isDesktop: true };

export function setIcon(el: HTMLElement, name: string) {
	const pascal = name.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());
	const node = (lucide as any)[pascal];
	el.empty?.();
	if (!node) return;
	const svg = lucide.createElement(node);
	svg.classList.add("svg-icon", `lucide-${name}`);
	el.appendChild(svg);
}

export function getAllTags(cache: any): string[] {
	return cache?.tags ?? [];
}

export function debounce<T extends (...a: any[]) => any>(fn: T, ms: number) {
	let t = 0;
	return (...a: Parameters<T>) => {
		window.clearTimeout(t);
		t = window.setTimeout(() => fn(...a), ms);
	};
}

/** Renders markdown roughly the way Obsidian's reading view does, for checkboxes and links. */
export const MarkdownRenderer = {
	async render(_app: unknown, md: string, el: HTMLElement) {
		const withLinks = md
			.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<a class="internal-link" data-href="$1" href="$1">$2</a>')
			.replace(/\[\[([^\]]+)\]\]/g, '<a class="internal-link" data-href="$1" href="$1">$1</a>')
			.replace(/(^|\s)#([\w/-]+)/g, '$1<a class="tag" href="#$2">#$2</a>');
		el.innerHTML = await marked.parse(withLinks, { gfm: true, breaks: true });
		el.querySelectorAll("li").forEach((li) => {
			// marked only knows [ ] and [x]; Obsidian renders any mark as a checkbox.
			const lead = li.firstChild?.nodeType === 3 ? li.firstChild : li.firstElementChild?.tagName === "P" ? li.firstElementChild.firstChild : null;
			const m = lead?.textContent?.match(/^\[(.)\] ?/);
			if (lead && m && !li.querySelector(":scope > input, :scope > p > input")) {
				lead.textContent = " " + lead.textContent!.slice(m[0].length);
				const box = document.createElement("input");
				box.type = "checkbox";
				box.checked = m[1] !== " ";
				lead.parentNode!.insertBefore(box, lead);
			}
			const first = li.firstElementChild;
			const input = (first?.tagName === "INPUT" ? first : first?.firstElementChild?.tagName === "INPUT" ? first.firstElementChild : null) as HTMLInputElement | null;
			if (!input) return;
			li.classList.add("task-list-item");
			if (input.checked) li.classList.add("is-checked");
			li.setAttribute("data-task", input.checked ? "x" : " ");
			input.removeAttribute("disabled");
			input.classList.add("task-list-item-checkbox");
			li.parentElement?.classList.add("contains-task-list");
			// marked wraps loose items in <p>; Obsidian doesn't.
			if (first?.tagName === "P") first.replaceWith(...Array.from(first.childNodes));
		});
	},
};
