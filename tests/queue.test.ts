import { describe, expect, it } from "vitest";
import { moment } from "obsidian";
import { describeFormat, isFuture, longAge, matchesTypeFilter, NoteEntry, openByType, rangeLabel, shortAge, sortEntries, ticksFor, TypeFilterState } from "../src/core/queue";
import { example } from "./fixtures";

const S = example();
function entry(p: Partial<NoteEntry>): NoteEntry {
	return { path: "x", title: "x", kind: "daily", start: "2026-11-20", end: "2026-11-20", anchor: "2026-11-20",
		isWeekend: false, needsReview: true, counts: {}, open: 0, tasks: 0, settled: 0, ...p };
}

describe("queue", () => {
	it("counts only periods that haven't started as future", () => {
		const today = "2026-11-23";
		expect(isFuture(entry({ start: "2026-11-23", end: "2026-11-23" }), today)).toBe(false);
		expect(isFuture(entry({ start: "2026-11-24", end: "2026-11-24" }), today)).toBe(true);
		expect(isFuture(entry({ kind: "weekly", start: "2026-11-23", end: "2026-11-29" }), today)).toBe(false);
		expect(isFuture(entry({ kind: "monthly", start: "2026-12-01", end: "2026-12-31" }), today)).toBe(true);
	});
	it("sorts by anchor, then kind", () => {
		const d = entry({ title: "d", anchor: "2026-11-22" });
		const w = entry({ title: "w", kind: "weekly", anchor: "2026-11-22" });
		const old = entry({ title: "o", anchor: "2026-11-01" });
		expect(sortEntries([w, d, old], "oldest").map((e) => e.title)).toEqual(["o", "d", "w"]);
		expect(sortEntries([w, d, old], "newest").map((e) => e.title)).toEqual(["w", "d", "o"]);
	});
	it("ticks follow item-type order, tasks first", () => {
		const e = entry({ counts: { other: { open: 1, tasks: 0 }, fun: { open: 1, tasks: 0 }, work: { open: 1, tasks: 1 } } });
		expect(ticksFor(e, S).map((t) => `${t.typeId}${t.task ? "!" : ""}`)).toEqual(["work!", "work", "fun", "other"]);
	});
	it("ages", () => {
		expect(shortAge(entry({}), "2026-11-23")).toBe("3d");
		expect(shortAge(entry({ anchor: "2026-11-23", start: "2026-11-23", end: "2026-11-23" }), "2026-11-23")).toBe("today");
		expect(longAge(entry({}), "2026-11-21")).toBe("Yesterday");
		const wk = entry({ kind: "weekly", start: "2026-11-16", end: "2026-11-22", anchor: "2026-11-22" });
		expect(longAge(wk, "2026-11-19")).toBe("Ends in 3 days");
		expect(rangeLabel("2026-11-30", "2026-12-06")).toBe("Nov 30–Dec 6");
	});
});

describe("describeFormat", () => {
	const now = moment("2026-11-22", "YYYY-MM-DD");
	it("shows today's title and how it's read", () => {
		expect(describeFormat("weekly", "GGGG-[W]WW", now)).toEqual({ title: "2026-W47", ok: true, readAs: "the week of Nov 16–22, 2026" });
		expect(describeFormat("daily", "YYYY-MM-DD ddd", now)).toMatchObject({ title: "2026-11-22 Sun", ok: true });
		expect(describeFormat("yearly", "[✱ ]YYYY", now)).toMatchObject({ title: "✱ 2026", ok: true });
	});
	it("flags formats that can't be read back as the period", () => {
		expect(describeFormat("weekly", "YYYY", now).ok).toBe(false);
		expect(describeFormat("daily", "YYYY-MM", now).ok).toBe(false);
		expect(describeFormat("daily", "", now).ok).toBe(false);
	});
});

describe("type pills", () => {
	const both = entry({ counts: { work: { open: 1, tasks: 0 }, fun: { open: 0, tasks: 1 } } });
	const workOnly = entry({ counts: { work: { open: 2, tasks: 0 } } });
	const clear = entry({});
	const f = (pairs: [string, TypeFilterState][]) => new Map(pairs);
	it("include shows only notes with that type open", () => {
		const m = f([["work", "include"]]);
		expect([both, workOnly, clear].map((e) => matchesTypeFilter(e, m))).toEqual([true, true, false]);
		expect(matchesTypeFilter(both, f([["fun", "include"]]))).toBe(true);
		expect(matchesTypeFilter(workOnly, f([["fun", "include"]]))).toBe(false);
	});
	it("exclude hides notes with only that type left", () => {
		const m = f([["work", "exclude"]]);
		expect([both, workOnly, clear].map((e) => matchesTypeFilter(e, m))).toEqual([true, false, true]);
	});
	it("open counts per type", () => {
		expect(openByType([both, workOnly])).toEqual({ work: 3, fun: 1 });
	});
});
