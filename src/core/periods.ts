import { moment } from "obsidian";
import { Kind, KIND_TAG_ORDER, KIND_TITLE_ORDER, KINDS, Settings } from "./settings";

type Moment = import("moment").Moment;

export interface Period {
	kind: Kind;
	/** First and last day of the period, as YYYY-MM-DD. */
	start: string;
	end: string;
	/** Sort position and the date "days ago" counts from, as YYYY-MM-DD. */
	anchor: string;
	/** Daily notes only: the date is a Saturday or Sunday. */
	isWeekend: boolean;
}

const ISO = "YYYY-MM-DD";

/** Normalise a tag for comparison: no leading '#', lower case. */
export function normTag(tag: string): string {
	return tag.replace(/^#/, "").trim().toLowerCase();
}

/** True when `tags` contains `tag` itself or a nested tag under it (`daily/x`). */
export function hasTag(tags: string[], tag: string): boolean {
	const want = normTag(tag);
	if (!want) return false;
	return tags.some((t) => {
		const n = normTag(t);
		return n === want || n.startsWith(want + "/");
	});
}

/** The kind a note's tags give it, or null when it has none of the kind tags. */
export function kindFromTags(tags: string[], settings: Settings): Kind | null {
	for (const k of KIND_TAG_ORDER) {
		const tag = settings.kinds[k].tag;
		if (tag && hasTag(tags, tag)) return k;
	}
	return null;
}

/**
 * Parse a title with a moment format, strictly. With `prefix`, the title only has to
 * start with the format (the longest matching prefix wins).
 */
export function parseTitle(title: string, format: string, prefix: boolean): Moment | null {
	const t = title.trim();
	const whole = moment(t, format, true);
	if (whole.isValid()) return whole;
	if (!prefix) return null;
	for (let n = t.length - 1; n > 0; n--) {
		const m = moment(t.slice(0, n), format, true);
		if (m.isValid()) return m;
	}
	return null;
}

/** Whether a format uses ISO week tokens (G, W) rather than locale weeks (g, w). */
function usesIsoWeeks(format: string): boolean {
	const unbracketed = format.replace(/\[[^\]]*\]/g, "");
	return /[GW]/.test(unbracketed);
}

export function periodFor(kind: Kind, date: Moment, format: string): Omit<Period, "kind"> {
	let start: Moment;
	let end: Moment;
	switch (kind) {
		case "daily":
			start = date.clone().startOf("day");
			end = start.clone();
			break;
		case "weekly": {
			const unit = usesIsoWeeks(format) ? "isoWeek" : "week";
			start = date.clone().startOf(unit);
			end = start.clone().add(6, "days");
			break;
		}
		case "monthly":
			start = date.clone().startOf("month");
			end = date.clone().endOf("month").startOf("day");
			break;
		case "quarterly":
			start = date.clone().startOf("quarter");
			end = date.clone().endOf("quarter").startOf("day");
			break;
		case "yearly":
			start = date.clone().startOf("year");
			end = date.clone().endOf("year").startOf("day");
			break;
	}
	let anchor = end;
	if (kind === "weekly") {
		// A week belongs to the month holding its Thursday (as in ISO week-year rules).
		// Clamp to that month's last day, so a week running into the next month sorts
		// before that month's note.
		const owningMonthEnd = start.clone().add(3, "days").endOf("month").startOf("day");
		if (owningMonthEnd.isBefore(end)) anchor = owningMonthEnd;
	}
	const dow = start.isoWeekday();
	return {
		start: start.format(ISO),
		end: end.format(ISO),
		anchor: anchor.format(ISO),
		isWeekend: kind === "daily" && (dow === 6 || dow === 7),
	};
}

/**
 * Work out a note's kind and period from its title and tags. Returns null when the note
 * isn't part of the review: its kind is switched off, or its title doesn't parse.
 */
export function classifyNote(title: string, tags: string[], settings: Settings): Period | null {
	const tagged = kindFromTags(tags, settings);
	if (tagged) {
		// A kind tag decides the kind; the title must then parse with that kind's format.
		const ks = settings.kinds[tagged];
		if (!ks.enabled) return null;
		const date = parseTitle(title, ks.titleFormat, settings.titlePrefixMatch);
		return date ? { kind: tagged, ...periodFor(tagged, date, ks.titleFormat) } : null;
	}
	// No kind tag: the first enabled kind whose title format fits, most specific first.
	for (const kind of KIND_TITLE_ORDER) {
		const ks = settings.kinds[kind];
		if (!ks.enabled) continue;
		const date = parseTitle(title, ks.titleFormat, settings.titlePrefixMatch);
		if (date) return { kind, ...periodFor(kind, date, ks.titleFormat) };
	}
	return null;
}

/** Whole days from `anchor` to `today` (both YYYY-MM-DD). Positive = in the past. */
export function daysAgo(anchor: string, today: string): number {
	return moment(today, ISO).diff(moment(anchor, ISO), "days");
}

export function todayString(): string {
	return moment().format(ISO);
}

export function kindWeight(kind: Kind): number {
	return KINDS.indexOf(kind);
}
