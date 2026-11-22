import { describe, expect, it } from "vitest";
import { needsReview, withFrontmatterValue } from "../src/core/review";
import { example } from "./fixtures";
import { DEFAULT_SETTINGS } from "../src/core/settings";

const S = example();

describe("needsReview", () => {
	it("false, FALSE and 'false' are unreviewed; anything else reviewed", () => {
		expect(needsReview("daily", { reviewed: false }, S)).toBe(true);
		expect(needsReview("daily", { reviewed: "FALSE" }, S)).toBe(true);
		expect(needsReview("daily", { reviewed: true }, S)).toBe(false);
		expect(needsReview("daily", { reviewed: "done" }, S)).toBe(false);
	});
	it("missing (or empty) field depends on the kind", () => {
		expect(needsReview("daily", {}, S)).toBe(false);
		expect(needsReview("daily", { reviewed: null }, S)).toBe(false);
		expect(needsReview("weekly", {}, S)).toBe(true);
		expect(needsReview("monthly", undefined, S)).toBe(true);
	});
	it("yearly uses its own field and reviewed value", () => {
		expect(needsReview("yearly", {}, S)).toBe(true);
		expect(needsReview("yearly", { status: "Done" }, S)).toBe(false);
		expect(needsReview("yearly", { status: ["active", "done"] }, S)).toBe(false);
		expect(needsReview("yearly", { status: "active" }, S)).toBe(true);
	});
});

describe("withFrontmatterValue", () => {
	const F = "reviewed";
	it("replaces only the field's line", () => {
		const raw = "---\ntags:\n  - daily\nreviewed: FALSE\ncssclasses: [a]\n---\n\n# Body\n- [ ] x\n";
		expect(withFrontmatterValue(raw, F, "true")).toBe(raw.replace("reviewed: FALSE", "reviewed: true"));
	});
	it("keeps indentation and CRLF line endings", () => {
		const raw = "---\r\n  reviewed:   false  \r\nx: 1\r\n---\r\nbody\r\n";
		expect(withFrontmatterValue(raw, F, "true")).toBe("---\r\n  reviewed: true\r\nx: 1\r\n---\r\nbody\r\n");
	});
	it("an empty field gets its value", () => {
		const raw = "---\nreviewed:\nx: 1\n---\n";
		expect(withFrontmatterValue(raw, F, "true")).toBe("---\nreviewed: true\nx: 1\n---\n");
	});
	it("replaces a list value with all its items", () => {
		const raw = "---\nstatus:\n  - active\n  - later\nx: 1\n---\n";
		expect(withFrontmatterValue(raw, "status", "done")).toBe("---\nstatus: done\nx: 1\n---\n");
	});
	it("adds the field at the end of the frontmatter", () => {
		const raw = "---\ntags: [daily]\n---\nbody";
		expect(withFrontmatterValue(raw, F, "true")).toBe("---\ntags: [daily]\nreviewed: true\n---\nbody");
	});
	it("handles empty frontmatter", () => {
		expect(withFrontmatterValue("---\n---\nbody", F, "true")).toBe("---\nreviewed: true\n---\nbody");
	});
	it("adds frontmatter when there is none", () => {
		expect(withFrontmatterValue("# Note\n", F, "true")).toBe("---\nreviewed: true\n---\n# Note\n");
	});
	it("does not touch a similarly named field", () => {
		const raw = "---\noldreviewed: false\n---\n";
		expect(withFrontmatterValue(raw, F, "true")).toBe("---\noldreviewed: false\nreviewed: true\n---\n");
	});
});

describe("generic defaults", () => {
	it("a note is unreviewed until its 'reviewed' field is set", () => {
		const D = DEFAULT_SETTINGS;
		expect(needsReview("daily", {}, D)).toBe(true);
		expect(needsReview("yearly", { reviewed: false }, D)).toBe(true);
		expect(needsReview("daily", { reviewed: true }, D)).toBe(false);
	});
});
