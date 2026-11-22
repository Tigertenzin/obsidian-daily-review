import { describe, expect, it } from "vitest";
import { longAge, NoteEntry, rangeLabel, shortAge, sortEntries, ticksFor } from "../src/core/queue";
import { example } from "./fixtures";

const S = example();
function entry(p: Partial<NoteEntry>): NoteEntry {
	return { path: "x", title: "x", kind: "daily", start: "2026-11-20", end: "2026-11-20", anchor: "2026-11-20",
		isWeekend: false, needsReview: true, counts: {}, open: 0, tasks: 0, settled: 0, ...p };
}

describe("queue", () => {
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
