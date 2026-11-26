import { ItemType, OTHER_ID, Settings } from "./settings";

export type ItemState = "open" | "settled" | "ignored";

export interface Item {
	/** 0-based line number in the file. */
	line: number;
	/** The character between the brackets. */
	mark: string;
	state: ItemState;
	/** Item type id, or OTHER_ID. */
	typeId: string;
	isTask: boolean;
	/** The item's text after the checkbox. */
	text: string;
	/** The whole line as it was read. */
	raw: string;
	/** True when the item sits in a part of the note that isn't rendered. */
	hidden: boolean;
}

export interface Heading {
	line: number;
	level: number;
	text: string;
}

export interface TypeCount {
	open: number;
	tasks: number;
}

export interface NoteAnalysis {
	items: Item[];
	headings: Heading[];
	/** Open items per type id (types with nothing open are absent). */
	counts: Record<string, TypeCount>;
	open: number;
	tasks: number;
	settled: number;
	/** Markdown to render: hidden lines are blanked, so line numbers are unchanged. */
	renderText: string;
	/** Items that will appear as rendered checkboxes, in document order. */
	renderedItems: Item[];
}

const FENCE_RE = /^((?:[ \t]*>)*)[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)/;
const HEADING_RE = /^[ \t]{0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const ITEM_RE = /^((?:[ \t]*>)*[ \t]*)(?:[-*+]|\d+[.)])[ \t]+\[(.)\](?:[ \t]+(.*))?$/;
const HR_RE = /^[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const NAV_START = /^[◀◁⬅←]/;
const NAV_END = /[▶▷➡→]$/;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function taskTagRegExp(tag: string): RegExp | null {
	const t = tag.trim();
	if (!t) return null;
	return new RegExp(`(?:^|\\s)${escapeRegExp(t)}(?![\\p{L}\\p{N}_/-])`, "iu");
}

/** Whether a heading's text matches one of an item type's patterns. */
export function typeMatches(type: ItemType, headingText: string): boolean {
	const h = headingText.trim().toLowerCase();
	return type.headings.some((p) => {
		const pat = p.trim();
		if (!pat) return false;
		if (type.match === "exact") return h === pat.toLowerCase();
		if (type.match === "regex") {
			try {
				return new RegExp(pat, "i").test(h);
			} catch {
				return false;
			}
		}
		return h.includes(pat.toLowerCase());
	});
}

/** The type of the section a heading starts: the first enabled type that matches. */
export function typeForHeading(headingText: string, settings: Settings): string {
	for (const t of settings.itemTypes) {
		if (t.enabled && typeMatches(t, headingText)) return t.id;
	}
	return OTHER_ID;
}

export function markState(mark: string, settings: Settings): ItemState {
	if (settings.openMarks.includes(mark)) return "open";
	if (settings.settledMarks.includes(mark)) return "settled";
	if (settings.unknownMarks === "open") return "open";
	if (settings.unknownMarks === "settled") return "settled";
	return "ignored";
}

/** A navigation line: after swapping wikilinks for their labels, ◀ … ▶. */
export function isNavLine(line: string): boolean {
	const text = line
		.replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
		.replace(/!?\[\[([^\]]*)\]\]/g, "$1")
		.replace(/[\uFE0E\uFE0F]/g, "")
		.trim();
	return text.length > 1 && NAV_START.test(text) && NAV_END.test(text);
}

/** Item text with links reduced to their labels and markdown markers stripped. */
export function plainItemText(text: string): string {
	return text
		.replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
		.replace(/!?\[\[([^\]]*)\]\]/g, (_, l: string) => l.split("/").pop() ?? l)
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_~`=]{1,2}/g, "")
		.trim();
}

/** The host of the first link in an item's text, if any. */
export function firstLinkDomain(text: string): string | null {
	const m = text.match(/\]\((https?:\/\/[^)\s]+)/) ?? text.match(/(https?:\/\/[^\s)>\]]+)/);
	if (!m) return null;
	try {
		return new URL(m[1]).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return null;
	}
}

/** Label for a domain from a `domain → label` map, matching the domain or a subdomain. */
export function domainLabel(domain: string, labels: Record<string, string>): string | null {
	let best: string | null = null;
	let bestLen = -1;
	for (const [d, label] of Object.entries(labels)) {
		const key = d.trim().toLowerCase().replace(/^www\./, "");
		if (!key) continue;
		if ((domain === key || domain.endsWith("." + key)) && key.length > bestLen) {
			best = label;
			bestLen = key.length;
		}
	}
	return best;
}

/**
 * Read a note: its headings, checkbox items (with state, type and task flag), counts,
 * and the markdown to render with hidden parts blanked out. `fallbackType` is the type of
 * items under no heading, or under a section heading no type matches (default Other).
 */
export function analyzeNote(raw: string, title: string, settings: Settings, fallbackType = OTHER_ID): NoteAnalysis {
	const lines = raw.split(/\r?\n/);
	const hidden = new Array<boolean>(lines.length).fill(false);
	const inCode = new Array<boolean>(lines.length).fill(false);
	const hiddenLangs = new Set(settings.hiddenBlockLanguages.map((l) => l.trim().toLowerCase()));
	const taskRe = taskTagRegExp(settings.taskTag);

	let i = 0;
	// Frontmatter
	if (lines.length > 0 && /^---[ \t]*$/.test(lines[0])) {
		for (let j = 1; j < lines.length; j++) {
			if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[j])) {
				for (let k = 0; k <= j; k++) hidden[k] = true;
				i = j + 1;
				break;
			}
		}
	}

	// Fenced code blocks
	for (let j = i; j < lines.length; j++) {
		const f = lines[j].match(FENCE_RE);
		if (!f) continue;
		const fence = f[2];
		const lang = f[3].replace(/^\{?\.?/, "").replace(/\}$/, "").toLowerCase();
		const closeRe = new RegExp(`^(?:[ \\t]*>)*[ \\t]{0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
		let end = lines.length - 1;
		for (let k = j + 1; k < lines.length; k++) {
			if (closeRe.test(lines[k])) {
				end = k;
				break;
			}
		}
		const hide = hiddenLangs.has(lang);
		for (let k = j; k <= end; k++) {
			inCode[k] = true;
			if (hide) hidden[k] = true;
		}
		j = end;
	}

	// Obsidian %% comments %% (not shown in reading view): treated like code, and hidden
	let inComment = false;
	for (let j = i; j < lines.length; j++) {
		if (inCode[j]) continue;
		const marks = (lines[j].match(/%%/g) ?? []).length;
		const startsComment = !inComment && lines[j].trim().startsWith("%%");
		if (inComment || startsComment) {
			inCode[j] = true;
			hidden[j] = true;
		}
		if (marks % 2 === 1) inComment = !inComment;
	}

	// Headings
	const headings: Heading[] = [];
	for (let j = i; j < lines.length; j++) {
		if (inCode[j]) continue;
		const h = lines[j].match(HEADING_RE);
		if (h) headings.push({ line: j, level: h[1].length, text: (h[2] ?? "").replace(/[ \t]+#+$/, "") });
	}

	// Title heading: the first H1, when it starts with the note's title
	if (settings.hideTitleHeading) {
		const h1 = headings.find((h) => h.level === 1);
		// Compared on letters and digits only, so "2026-11 (Nov)" repeats "2026-11 Nov".
		const key = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
		if (h1 && key(title) && key(h1.text).startsWith(key(title))) hidden[h1.line] = true;
	}

	// Navigation line
	if (settings.hideNavLine) {
		for (let j = i; j < lines.length; j++) {
			if (!inCode[j] && !hidden[j] && isNavLine(lines[j])) hidden[j] = true;
		}
	}

	// Headings left with nothing under them (checked last to first, so a heading whose only
	// content is an empty subheading counts as empty too). Rules in its span go with it.
	for (let hi = headings.length - 1; hi >= 0; hi--) {
		const h = headings[hi];
		if (hidden[h.line]) continue;
		let end = lines.length;
		for (let hj = hi + 1; hj < headings.length; hj++) {
			if (headings[hj].level <= h.level) {
				end = headings[hj].line;
				break;
			}
		}
		let empty = true;
		const rules: number[] = [];
		for (let k = h.line + 1; k < end; k++) {
			if (hidden[k] || lines[k].trim() === "") continue;
			if (!inCode[k] && HR_RE.test(lines[k])) {
				rules.push(k);
				continue;
			}
			empty = false;
			break;
		}
		if (empty) {
			hidden[h.line] = true;
			for (const r of rules) hidden[r] = true;
		}
	}

	// Items, with the type of the section they sit in
	const items: Item[] = [];
	const headingAt = new Map(headings.map((h) => [h.line, h]));
	const fallback = fallbackType === OTHER_ID || settings.itemTypes.some((t) => t.id === fallbackType && t.enabled)
		? fallbackType : OTHER_ID;
	let section = fallback;
	for (let j = i; j < lines.length; j++) {
		const h = headingAt.get(j);
		if (h) {
			if (h.level === settings.sectionLevel) {
				const t = typeForHeading(h.text, settings);
				section = t === OTHER_ID ? fallback : t;
			} else if (h.level < settings.sectionLevel) section = fallback;
			continue;
		}
		if (inCode[j]) continue;
		const m = lines[j].match(ITEM_RE);
		if (!m) continue;
		const text = m[3] ?? "";
		items.push({
			line: j,
			mark: m[2],
			state: markState(m[2], settings),
			typeId: section,
			isTask: taskRe ? taskRe.test(" " + text) : false,
			text,
			raw: lines[j],
			hidden: hidden[j],
		});
	}

	const counts: Record<string, TypeCount> = {};
	let open = 0;
	let tasks = 0;
	let settled = 0;
	for (const it of items) {
		if (it.hidden) continue;
		if (it.typeId === OTHER_ID && settings.other.hidden) continue;
		if (it.state === "settled") settled++;
		if (it.state !== "open") continue;
		const c = counts[it.typeId] ?? (counts[it.typeId] = { open: 0, tasks: 0 });
		if (it.isTask) {
			c.tasks++;
			tasks++;
		} else {
			c.open++;
		}
		open++;
	}

	const renderText = lines.map((l, j) => (hidden[j] ? "" : l)).join("\n");
	return {
		items,
		headings,
		counts,
		open,
		tasks,
		settled,
		renderText,
		renderedItems: items.filter((it) => !it.hidden),
	};
}

/** Replace the mark of a checkbox line, leaving the rest of the line as it was. */
export function withMark(line: string, mark: string): string {
	return line.replace(/^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)(.)(\])/, `$1${mark}$3`);
}
