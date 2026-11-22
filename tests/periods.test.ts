import { describe, expect, it } from "vitest";
import { classifyNote, daysAgo, hasTag, parseTitle } from "../src/core/periods";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/core/settings";

const S = mergeSettings({});
S.kinds.quarterly.enabled = true;

describe("classifyNote", () => {
	it("daily notes, with weekend from the date", () => {
		expect(classifyNote("2026-11-22 Sun", ["daily"], S)).toMatchObject({
			kind: "daily", anchor: "2026-11-22", isWeekend: true,
		});
		expect(classifyNote("2026-11-23 Mon", ["daily"], S)?.isWeekend).toBe(false);
	});

	it("rejects titles that don't parse", () => {
		expect(classifyNote("Shopping list", ["daily"], S)).toBeNull();
		expect(classifyNote("2026-11-22 Mon", ["daily"], S)).toBeNull(); // wrong weekday
	});

	it("prefix matching is optional", () => {
		expect(classifyNote("2026-11-22 Sun - trip", ["daily"], S)?.anchor).toBe("2026-11-22");
		const strict = mergeSettings({ titlePrefixMatch: false });
		expect(classifyNote("2026-11-22 Sun - trip", ["daily"], strict)).toBeNull();
	});

	it("weekly: ISO week, anchored to its last day", () => {
		expect(classifyNote("2026-W47", ["daily", "weekly"], S)).toMatchObject({
			kind: "weekly", start: "2026-11-16", end: "2026-11-22", anchor: "2026-11-22",
		});
	});

	it("weekly: a week running into the next month is clamped to its Thursday's month", () => {
		// 2026-W49: Mon Nov 30 – Sun Dec 6, Thursday Dec 3 → belongs to December, no clamp
		expect(classifyNote("2026-W49", ["weekly"], S)?.anchor).toBe("2026-12-06");
		// 2026-W44: Mon Oct 26 – Sun Nov 1, Thursday Oct 29 → clamped to Oct 31
		expect(classifyNote("2026-W44", ["weekly"], S)?.anchor).toBe("2026-10-31");
	});

	it("weekly: new year (ISO week-year differs from calendar year)", () => {
		// 2026-W01 starts Mon Dec 29 2025; Thursday Jan 1 → January
		expect(classifyNote("2026-W01", ["weekly"], S)).toMatchObject({ start: "2025-12-29", anchor: "2026-01-04" });
		// 2025-W52: Dec 22–28
		expect(classifyNote("2025-W52", ["weekly"], S)?.anchor).toBe("2025-12-28");
	});

	it("monthly, quarterly, yearly", () => {
		expect(classifyNote("2026-11 Nov", ["monthly"], S)?.anchor).toBe("2026-11-30");
		expect(classifyNote("2026-Q4", ["quarterly"], S)).toMatchObject({ start: "2026-10-01", anchor: "2026-12-31" });
		expect(classifyNote("✱ 2026", ["yearly"], S)).toMatchObject({ kind: "yearly", anchor: "2026-12-31" });
	});

	it("kind tags win longest period first", () => {
		expect(classifyNote("✱ 2026", ["weekly", "yearly"], S)?.kind).toBe("yearly");
	});

	it("disabled kinds are left out", () => {
		const s = mergeSettings({});
		s.kinds.weekly.enabled = false;
		expect(classifyNote("2026-W47", ["weekly"], s)).toBeNull();
		expect(classifyNote("2026-Q4", ["quarterly"], DEFAULT_SETTINGS)).toBeNull();
	});
});

describe("helpers", () => {
	it("hasTag handles # and nested tags", () => {
		expect(hasTag(["#daily"], "daily")).toBe(true);
		expect(hasTag(["daily/2026"], "#Daily")).toBe(true);
		expect(hasTag(["dailyish"], "daily")).toBe(false);
	});
	it("daysAgo", () => {
		expect(daysAgo("2026-11-20", "2026-11-22")).toBe(2);
		expect(daysAgo("2026-11-30", "2026-11-22")).toBe(-8);
	});
	it("parseTitle strict", () => {
		expect(parseTitle("2026-W47", "GGGG-[W]WW", false)?.isValid()).toBe(true);
	});
});
