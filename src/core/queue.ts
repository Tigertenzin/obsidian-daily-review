import { moment } from "obsidian";
import { daysAgo, kindWeight, parseTitle, Period, periodFor } from "./periods";
import { Kind, OTHER_ID, Settings, SortMode } from "./settings";
import { TypeCount } from "./parse";
import type { ExtraEntry } from "./extras";

export interface NoteEntry extends Period {
	path: string;
	title: string;
	needsReview: boolean;
	counts: Record<string, TypeCount>;
	open: number;
	tasks: number;
	settled: number;
	/** Order among pages with the same date and kind (a day's scraps come after its note). */
	sub?: number;
}

/**
 * One page of the review: a periodic note, a day's note with its scraps, a day that only
 * has scraps, or (when scraps get their own pages) one scrap. `path` is the page's key:
 * the note's path, the scrap's path, or `pnr-day:<date>` for a day with no daily note.
 * Counts and review state cover the notes on the page that still need review.
 */
export interface QueueEntry extends NoteEntry {
	note: NoteEntry | null;
	scraps: ExtraEntry[];
}

export type FilterId = "all" | "weekdays" | "weekends" | Exclude<Kind, "daily"> | "old" | "scraps";

/** Kind chips shown in the top bar (the other filter ids remain available to code). */
export const FILTERS: { id: FilterId; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "weekly", label: "Weekly" },
	{ id: "monthly", label: "Monthly" },
	{ id: "quarterly", label: "Quarterly" },
	{ id: "yearly", label: "Yearly" },
	{ id: "scraps", label: "Scraps" },
];

/** A type pill's state: show only notes with this type open, or hide notes with only it left. */
export type TypeFilterState = "include" | "exclude";

/**
 * Type pills. With any "include" pills, a note must have at least one of those types
 * open. With "exclude" pills, a note whose open items are all of excluded types is
 * hidden. Notes with nothing open are only hidden by "include".
 */
export function matchesTypeFilter(e: NoteEntry, filter: Map<string, TypeFilterState>): boolean {
	if (filter.size === 0) return true;
	const open = Object.keys(e.counts).filter((id) => e.counts[id].open + e.counts[id].tasks > 0);
	const include = [...filter].filter(([, v]) => v === "include").map(([k]) => k);
	const exclude = [...filter].filter(([, v]) => v === "exclude").map(([k]) => k);
	if (include.length > 0 && !open.some((id) => include.includes(id))) return false;
	if (exclude.length > 0 && open.length > 0 && open.every((id) => exclude.includes(id))) return false;
	return true;
}

/** Open items (plain and tasks) per type across `entries`. */
export function openByType(entries: NoteEntry[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const e of entries) {
		for (const [id, c] of Object.entries(e.counts)) out[id] = (out[id] ?? 0) + c.open + c.tasks;
	}
	return out;
}

export function isPast(e: NoteEntry, today: string): boolean {
	return daysAgo(e.anchor, today) > 0;
}

/** A note for a period that hasn't started yet (today's note and the current week aren't). */
export function isFuture(e: NoteEntry, today: string): boolean {
	return e.start > today;
}

export function matchesFilter(e: NoteEntry & { scraps?: ExtraEntry[] }, f: FilterId, today: string): boolean {
	switch (f) {
		case "scraps":
			return (e.scraps?.length ?? 0) > 0;
		case "all":
			return true;
		case "weekdays":
			return e.kind === "daily" && !e.isWeekend;
		case "weekends":
			return e.kind === "daily" && e.isWeekend;
		case "old":
			return daysAgo(e.anchor, today) >= 7;
		default:
			return e.kind === f;
	}
}

export function compareByDate(a: NoteEntry, b: NoteEntry): number {
	if (a.anchor !== b.anchor) return a.anchor < b.anchor ? -1 : 1;
	const k = kindWeight(a.kind) - kindWeight(b.kind);
	if (k !== 0) return k;
	const sub = (a.sub ?? 0) - (b.sub ?? 0);
	if (sub !== 0) return sub;
	return a.title.localeCompare(b.title, undefined, { numeric: true });
}

export function sortEntries<T extends NoteEntry>(entries: T[], sort: SortMode): T[] {
	const out = [...entries];
	switch (sort) {
		case "oldest":
			return out.sort(compareByDate);
		case "newest":
			return out.sort((a, b) => compareByDate(b, a));
		case "most-open":
			return out.sort((a, b) => b.open - a.open || compareByDate(a, b));
		case "most-tasks":
			return out.sort((a, b) => b.tasks - a.tasks || b.open - a.open || compareByDate(a, b));
	}
}

export interface Tick {
	typeId: string;
	task: boolean;
}

/** One tick per open item, in item-type order: tasks first within a type. */
export function ticksFor(e: NoteEntry, settings: Settings): Tick[] {
	const ticks: Tick[] = [];
	const order = [...settings.itemTypes.map((t) => t.id), OTHER_ID];
	for (const id of order) {
		const c = e.counts[id];
		if (!c) continue;
		for (let n = 0; n < c.tasks; n++) ticks.push({ typeId: id, task: true });
		for (let n = 0; n < c.open; n++) ticks.push({ typeId: id, task: false });
	}
	return ticks;
}

/** Short age for a queue row: "3d", "today", "ahead". */
export function shortAge(e: NoteEntry, today: string): string {
	const d = daysAgo(e.anchor, today);
	if (d > 0) return `${d}d`;
	if (e.start <= today && today <= e.end) return "today";
	return "ahead";
}

/** Longer age for the masthead: "Today", "Yesterday", "12 days ago", "Ends in 3 days". */
export function longAge(e: NoteEntry, today: string): string {
	const d = daysAgo(e.anchor, today);
	if (e.kind === "daily") {
		if (d === 0) return "Today";
		if (d === 1) return "Yesterday";
		if (d === -1) return "Tomorrow";
		return d > 0 ? `${d} days ago` : `In ${-d} days`;
	}
	if (d > 0) return d === 1 ? "Ended yesterday" : `Ended ${d} days ago`;
	if (d === 0) return "Ends today";
	if (e.start > today) return `Starts in ${daysAgo(today, e.start)} days`;
	return -d === 1 ? "Ends tomorrow" : `Ends in ${-d} days`;
}

const D = "YYYY-MM-DD";

/** "Nov 16–22", or "Nov 30–Dec 6" across months. */
export function rangeLabel(start: string, end: string, withYear = false): string {
	const s = moment(start, D);
	const e = moment(end, D);
	const year = withYear ? `, ${e.format("YYYY")}` : "";
	if (s.isSame(e, "month")) return `${s.format("MMM D")}–${e.format("D")}${year}`;
	return `${s.format("MMM D")}–${e.format("MMM D")}${year}`;
}

export function weekNumber(e: NoteEntry, titleFormat: string): string {
	const s = moment(e.start, D);
	const iso = /[GW]/.test(titleFormat.replace(/\[[^\]]*\]/g, ""));
	return String(iso ? s.isoWeek() : s.week());
}

export interface Masthead {
	kicker: string;
	headline: string;
}

export function mastheadFor(e: NoteEntry, settings: Settings): Masthead {
	const s = moment(e.start, D);
	switch (e.kind) {
		case "daily":
			return { kicker: s.format("dddd"), headline: s.format("D MMMM YYYY") };
		case "weekly":
			return {
				kicker: `Week ${weekNumber(e, settings.kinds.weekly.titleFormat)} · weekly note`,
				headline: rangeLabel(e.start, e.end, true),
			};
		case "monthly":
			return { kicker: "The month · monthly note", headline: s.format("MMMM YYYY") };
		case "quarterly":
			return { kicker: "The quarter · quarterly note", headline: `Q${s.quarter()} ${s.format("YYYY")}` };
		case "yearly":
			return { kicker: "The year · yearly note", headline: s.format("YYYY") };
	}
}

/** Queue group header: "November 2026"; yearly notes group under their year. */
export function groupLabel(e: NoteEntry): string {
	const a = moment(e.anchor, D);
	if (e.kind === "yearly") return a.format("YYYY");
	return a.format("MMMM YYYY");
}

/** Today's title in a kind's format, and whether it reads back as the current period. */
export function describeFormat(kind: Kind, format: string, now = moment()): { title: string; ok: boolean; readAs: string } {
	const title = format.trim() ? now.format(format) : "";
	const parsed = title ? parseTitle(title, format, false) : null;
	if (!parsed) return { title, ok: false, readAs: "" };
	const p = periodFor(kind, parsed, format);
	const today = now.format("YYYY-MM-DD");
	if (!(p.start <= today && today <= p.end)) return { title, ok: false, readAs: "" };
	const s = moment(p.start, "YYYY-MM-DD");
	const readAs: Record<Kind, string> = {
		daily: s.format("dddd, D MMMM YYYY"),
		weekly: `the week of ${rangeLabel(p.start, p.end, true)}`,
		monthly: s.format("MMMM YYYY"),
		quarterly: `Q${s.quarter()} ${s.format("YYYY")} (${rangeLabel(p.start, p.end)})`,
		yearly: s.format("YYYY"),
	};
	return { title, ok: true, readAs: readAs[kind] };
}

