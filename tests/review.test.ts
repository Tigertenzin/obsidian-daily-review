import { describe, expect, it } from "vitest";
import { needsReview, withFrontmatterValue } from "../src/core/review";
import { mergeSettings } from "../src/core/settings";

const S = mergeSettings({});

describe("needsReview", () => {
	it("false, FALSE and 'false' are unreviewed; anything else reviewed", () => {
		expect(needsReview("daily", { dailyNotetStatus: false }, S)).toBe(true);
		expect(needsReview("daily", { dailyNotetStatus: "FALSE" }, S)).toBe(true);
		expect(needsReview("daily", { dailyNotetStatus: true }, S)).toBe(false);
		expect(needsReview("daily", { dailyNotetStatus: "done" }, S)).toBe(false);
	});
	it("missing (or empty) field depends on the kind", () => {
		expect(needsReview("daily", {}, S)).toBe(false);
		expect(needsReview("daily", { dailyNotetStatus: null }, S)).toBe(false);
		expect(needsReview("weekly", {}, S)).toBe(true);
		expect(needsReview("monthly", undefined, S)).toBe(true);
	});
	it("yearly uses its own field and reviewed value", () => {
		expect(needsReview("yearly", {}, S)).toBe(true);
		expect(needsReview("yearly", { projectStatus: "Completed" }, S)).toBe(false);
		expect(needsReview("yearly", { projectStatus: ["active", "completed"] }, S)).toBe(false);
		expect(needsReview("yearly", { projectStatus: "active" }, S)).toBe(true);
	});
});

describe("withFrontmatterValue", () => {
	const F = "dailyNotetStatus";
	it("replaces only the field's line", () => {
		const raw = "---\ntags:\n  - daily\ndailyNotetStatus: FALSE\ncssclasses: [a]\n---\n\n# Body\n- [ ] x\n";
		expect(withFrontmatterValue(raw, F, "true")).toBe(raw.replace("dailyNotetStatus: FALSE", "dailyNotetStatus: true"));
	});
	it("keeps indentation and CRLF line endings", () => {
		const raw = "---\r\n  dailyNotetStatus:   false  \r\nx: 1\r\n---\r\nbody\r\n";
		expect(withFrontmatterValue(raw, F, "true")).toBe("---\r\n  dailyNotetStatus: true\r\nx: 1\r\n---\r\nbody\r\n");
	});
	it("an empty field gets its value", () => {
		const raw = "---\ndailyNotetStatus:\nx: 1\n---\n";
		expect(withFrontmatterValue(raw, F, "true")).toBe("---\ndailyNotetStatus: true\nx: 1\n---\n");
	});
	it("replaces a list value with all its items", () => {
		const raw = "---\nprojectStatus:\n  - active\n  - later\nx: 1\n---\n";
		expect(withFrontmatterValue(raw, "projectStatus", "completed")).toBe("---\nprojectStatus: completed\nx: 1\n---\n");
	});
	it("adds the field at the end of the frontmatter", () => {
		const raw = "---\ntags: [daily]\n---\nbody";
		expect(withFrontmatterValue(raw, F, "true")).toBe("---\ntags: [daily]\ndailyNotetStatus: true\n---\nbody");
	});
	it("handles empty frontmatter", () => {
		expect(withFrontmatterValue("---\n---\nbody", F, "true")).toBe("---\ndailyNotetStatus: true\n---\nbody");
	});
	it("adds frontmatter when there is none", () => {
		expect(withFrontmatterValue("# Note\n", F, "true")).toBe("---\ndailyNotetStatus: true\n---\n# Note\n");
	});
	it("does not touch a similarly named field", () => {
		const raw = "---\nolddailyNotetStatus: false\n---\n";
		expect(withFrontmatterValue(raw, F, "true")).toBe("---\nolddailyNotetStatus: false\ndailyNotetStatus: true\n---\n");
	});
});
