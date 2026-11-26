import { Kind, Settings } from "./settings";

/** The frontmatter field that holds a note kind's review state. */
export function statusFieldFor(kind: Kind, settings: Settings): string {
	return settings.kinds[kind].statusField.trim() || settings.statusField;
}

export function isMissing(v: unknown): boolean {
	return v === undefined || v === null || (typeof v === "string" && v.trim() === "")
		|| (Array.isArray(v) && v.length === 0);
}

export function valueMatches(v: unknown, want: string): boolean {
	const w = want.trim().toLowerCase();
	if (Array.isArray(v)) return v.some((x) => valueMatches(x, want));
	if (typeof v === "boolean") return String(v) === w;
	if (typeof v === "string" || typeof v === "number") return String(v).trim().toLowerCase() === w;
	return false;
}

/** Whether a note still needs review, from its parsed frontmatter. */
export function needsReview(
	kind: Kind,
	frontmatter: Record<string, unknown> | undefined,
	settings: Settings,
): boolean {
	const ks = settings.kinds[kind];
	const value = frontmatter?.[statusFieldFor(kind, settings)];
	if (isMissing(value)) return ks.missingStatus === "unreviewed";
	if (ks.reviewedValue.trim()) return !valueMatches(value, ks.reviewedValue);
	return valueMatches(value, settings.unreviewedValue);
}

/** What "Mark reviewed" writes into the status field. */
export function reviewedValueFor(kind: Kind, settings: Settings): string {
	return settings.kinds[kind].reviewedValue.trim() || "true";
}

/** What "Mark unreviewed" writes into the status field. */
export function unreviewedValueFor(kind: Kind, settings: Settings): string {
	return settings.kinds[kind].reviewedValue.trim() ? "" : settings.unreviewedValue;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Set one frontmatter field, changing nothing else in the file.
 *  1. If the field exists, its line is replaced (keeping its indentation).
 *  2. Otherwise, if there's frontmatter, the line is added at its end.
 *  3. Otherwise, a new frontmatter block holding only that line is added.
 * Line endings, quoting and every other byte are left as they were.
 */
export function withFrontmatterValue(raw: string, field: string, value: string): string {
	const eol = raw.includes("\r\n") ? "\r\n" : "\n";
	const line = value === "" ? `${field}:` : `${field}: ${value}`;
	const open = raw.match(/^---[ \t]*\r?\n/);
	if (open) {
		const rest = raw.slice(open[0].length);
		const close = rest.match(/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m);
		if (close && close.index !== undefined) {
			const fm = rest.slice(0, close.index);
			const after = rest.slice(close.index);
			// The line holding the field, but not lines of a multi-line value under it.
			const fieldRe = new RegExp(`^([ \\t]*)${escapeRegExp(field)}[ \\t]*:.*$`, "m");
			const m = fm.match(fieldRe);
			let newFm: string;
			if (m && m.index !== undefined) {
				// Drop indented continuation lines (a YAML list) that belonged to the old value.
				const start = m.index;
				let end = start + m[0].length;
				const indent = m[1].length;
				const contRe = /\r?\n([ \t]*)(?:-[ \t]|-$)[^\r\n]*/y;
				for (;;) {
					contRe.lastIndex = end;
					const c = contRe.exec(fm);
					if (!c || c[1].length < indent) break;
					end = contRe.lastIndex;
				}
				newFm = fm.slice(0, start) + m[1] + line + fm.slice(end);
			} else {
				newFm = fm + line + eol;
			}
			return open[0] + newFm + after;
		}
	}
	return `---${eol}${line}${eol}---${eol}` + raw;
}
