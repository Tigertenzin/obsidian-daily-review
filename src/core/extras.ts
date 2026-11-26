import { moment } from "obsidian";
import { periodFor } from "./periods";
import type { NoteEntry, QueueEntry } from "./queue";
import { isMissing, statusFieldFor, valueMatches } from "./review";
import { ExtraFolder, ExtraLayout, Settings } from "./settings";
import type { TypeCount } from "./parse";

const ISO = "YYYY-MM-DD";

/** Key of a page for a day that has scraps but no daily note. */
export const DAY_PREFIX = "pnr-day:";

/** One note from an extra folder, filed under the day in its name. */
export interface ExtraEntry {
	path: string;
	title: string;
	folderId: string;
	/** The day in the file name, as YYYY-MM-DD. */
	date: string;
	needsReview: boolean;
	counts: Record<string, TypeCount>;
	open: number;
	tasks: number;
	settled: number;
}

export function normFolder(folder: string): string {
	return folder.trim().replace(/^\/+|\/+$/g, "");
}

/** Whether a file path is inside an extra folder (and not in a subfolder, unless allowed). */
export function inExtraFolder(path: string, f: ExtraFolder): boolean {
	const folder = normFolder(f.folder);
	let rest = path;
	if (folder) {
		if (!path.startsWith(folder + "/")) return false;
		rest = path.slice(folder.length + 1);
	}
	return f.subfolders || !rest.includes("/");
}

/** The folder's label: its own, or the last part of its path. */
export function extraLabel(f: ExtraFolder): string {
	const own = f.label.trim();
	if (own) return own;
	const folder = normFolder(f.folder);
	return folder ? folder.split("/").pop()! : "Vault";
}

export type CompiledPattern = { before: RegExp; after: RegExp; error?: undefined } | { error: string };

/**
 * Split a file name pattern at `{date}` into regular expressions for the text before and
 * after the date. Without `{date}`, the name starts with the date and the pattern is
 * what may follow it. Matching ignores case.
 */
export function compilePattern(pattern: string): CompiledPattern {
	const p = pattern.trim() ? pattern : "{date}.*";
	const at = p.indexOf("{date}");
	const before = at === -1 ? "" : p.slice(0, at);
	const after = at === -1 ? p : p.slice(at + "{date}".length);
	if (after.includes("{date}")) return { error: "Use {date} only once." };
	try {
		return { before: new RegExp(`^(?:${before})$`, "iu"), after: new RegExp(`^(?:${after})$`, "iu") };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

const lengthCache = new Map<string, number[]>();

/** The lengths a date can have in `format` (month and day names vary), longest first. */
function dateLengths(format: string): number[] {
	const hit = lengthCache.get(format);
	if (hit) return hit;
	const lengths = new Set<number>();
	for (const year of [2009, 2026]) {
		for (let m = 0; m < 12; m++) {
			for (const d of [1, 2, 3, 9, 10, 11, 21, 22, 23, 28]) {
				lengths.add(moment({ year, month: m, day: d }).format(format).length);
			}
		}
	}
	const out = [...lengths].filter((n) => n > 0).sort((a, b) => b - a);
	lengthCache.set(format, out);
	return out;
}

/**
 * The day a file name holds, as YYYY-MM-DD, or null when the name doesn't fit the
 * pattern. The date is read with the folder's date format, strictly; the earliest place
 * it fits wins.
 */
export function matchExtraName(name: string, dateFormat: string, pattern: string | CompiledPattern): string | null {
	const format = dateFormat.trim();
	if (!format) return null;
	const c = typeof pattern === "string" ? compilePattern(pattern) : pattern;
	if (c.error !== undefined) return null;
	const lengths = dateLengths(format);
	for (let i = 0; i <= name.length; i++) {
		if (!c.before.test(name.slice(0, i))) continue;
		for (const n of lengths) {
			if (i + n > name.length) continue;
			const m = moment(name.slice(i, i + n), format, true);
			if (m.isValid() && c.after.test(name.slice(i + n))) return m.format(ISO);
		}
	}
	return null;
}

/** The frontmatter field holding an extra note's review state. */
export function extraStatusField(f: ExtraFolder, settings: Settings): string {
	return f.statusField.trim() || statusFieldFor("daily", settings);
}

/** Whether an extra note still needs review: its field holds the unreviewed value. */
export function extraNeedsReview(f: ExtraFolder, frontmatter: Record<string, unknown> | undefined, settings: Settings): boolean {
	const value = frontmatter?.[extraStatusField(f, settings)];
	if (isMissing(value)) return f.missingStatus === "unreviewed";
	return valueMatches(value, settings.unreviewedValue);
}

/** The first enabled extra folder a file belongs to, with the day in its name. */
export function matchExtraFile(
	path: string, basename: string, settings: Settings,
): { folder: ExtraFolder; date: string } | null {
	for (const f of settings.extraFolders) {
		if (!f.enabled || !inExtraFolder(path, f)) continue;
		const date = matchExtraName(basename, f.dateFormat, f.pattern);
		if (date) return { folder: f, date };
	}
	return null;
}

function sumCounts(members: { counts: Record<string, TypeCount>; open: number; tasks: number; settled: number }[]) {
	const counts: Record<string, TypeCount> = {};
	let open = 0;
	let tasks = 0;
	let settled = 0;
	for (const m of members) {
		for (const [id, c] of Object.entries(m.counts)) {
			const t = counts[id] ?? (counts[id] = { open: 0, tasks: 0 });
			t.open += c.open;
			t.tasks += c.tasks;
		}
		open += m.open;
		tasks += m.tasks;
		settled += m.settled;
	}
	return { counts, open, tasks, settled };
}

/** Counts for a page: from the notes that still need review, or from all once none do. */
function pageTotals(members: (NoteEntry | ExtraEntry)[]) {
	const pending = members.filter((m) => m.needsReview);
	return { needsReview: pending.length > 0, ...sumCounts(pending.length > 0 ? pending : members) };
}

/**
 * Turn the periodic notes and scraps into review pages. Non-daily notes are pages of
 * their own. With `below`, a day's scraps join its daily note's page (or a page of their
 * own when the day has no daily note). With `pages`, each scrap is a page after its day.
 */
export function buildPages(
	notes: Iterable<NoteEntry>, extras: Iterable<ExtraEntry>, layout: ExtraLayout, folderOrder: string[],
): Map<string, QueueEntry> {
	const pages = new Map<string, QueueEntry>();
	const dailyByDate = new Map<string, NoteEntry>();
	for (const n of notes) {
		pages.set(n.path, { ...n, note: n, scraps: [] });
		if (n.kind === "daily" && !dailyByDate.has(n.start)) dailyByDate.set(n.start, n);
	}
	const rank = (e: ExtraEntry) => {
		const i = folderOrder.indexOf(e.folderId);
		return i === -1 ? folderOrder.length : i;
	};
	const byDate = new Map<string, ExtraEntry[]>();
	for (const e of extras) {
		const list = byDate.get(e.date) ?? [];
		list.push(e);
		byDate.set(e.date, list);
	}
	for (const [date, list] of byDate) {
		list.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title, undefined, { numeric: true }));
		const period = { kind: "daily" as const, ...periodFor("daily", moment(date, ISO), ISO) };
		if (layout === "pages") {
			list.forEach((e, i) => {
				pages.set(e.path, {
					...period, path: e.path, title: e.title, sub: i + 1, note: null, scraps: [e], ...pageTotals([e]),
				});
			});
			continue;
		}
		const note = dailyByDate.get(date) ?? null;
		const key = note ? note.path : DAY_PREFIX + date;
		pages.set(key, {
			...(note ?? period), path: key, title: note?.title ?? date, note, scraps: list,
			...pageTotals(note ? [note, ...list] : list),
		});
	}
	return pages;
}

/**
 * A scrap's name without its date, for places that already show the day:
 * "2026-11-22 call with Sam" → "call with Sam", "Call 2026-11-22 with Sam" → "Call with Sam".
 * The whole name when nothing else is left.
 */
export function scrapName(title: string, date: string, dateFormat: string): string {
	const format = dateFormat.trim();
	if (!format) return title;
	const d = moment(date, ISO).format(format);
	const at = title.toLowerCase().indexOf(d.toLowerCase());
	if (at === -1) return title;
	const edge = /^[\s\-–—_.:,|·]+|[\s\-–—_.:,|·]+$/g;
	const rest = `${title.slice(0, at)} ${title.slice(at + d.length)}`.replace(/\s+/g, " ").replace(edge, "");
	return rest || title;
}
