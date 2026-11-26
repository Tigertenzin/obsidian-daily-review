import { describe, expect, it } from "vitest";
import {
	buildPages, compilePattern, DAY_PREFIX, ExtraEntry, extraNeedsReview, inExtraFolder, matchExtraFile, matchExtraName,
} from "../src/core/extras";
import { analyzeNote } from "../src/core/parse";
import { NoteEntry, sortEntries } from "../src/core/queue";
import { DEFAULT_EXTRA_FOLDER, ExtraFolder, mergeSettings } from "../src/core/settings";
import { example } from "./fixtures";

function folder(p: Partial<ExtraFolder> = {}): ExtraFolder {
	return { ...DEFAULT_EXTRA_FOLDER, id: "inbox", folder: "Inbox", ...p };
}
function note(p: Partial<NoteEntry>): NoteEntry {
	return { path: "x", title: "x", kind: "daily", start: "2026-11-20", end: "2026-11-20", anchor: "2026-11-20",
		isWeekend: false, needsReview: true, counts: {}, open: 0, tasks: 0, settled: 0, ...p };
}
function scrap(p: Partial<ExtraEntry>): ExtraEntry {
	return { path: "Inbox/s.md", title: "s", folderId: "inbox", date: "2026-11-20", needsReview: true,
		counts: {}, open: 0, tasks: 0, settled: 0, ...p };
}

describe("extra note names", () => {
	it("reads the date at the start and ignores what follows by default", () => {
		expect(matchExtraName("2026-11-22 call with Sam", "YYYY-MM-DD", "{date}.*")).toBe("2026-11-22");
		expect(matchExtraName("2026-11-22", "YYYY-MM-DD", "{date}.*")).toBe("2026-11-22");
		expect(matchExtraName("Ideas", "YYYY-MM-DD", "{date}.*")).toBeNull();
		expect(matchExtraName("2026-13-40 nope", "YYYY-MM-DD", "{date}.*")).toBeNull();
	});
	it("with only {date}, allows nothing else", () => {
		expect(matchExtraName("2026-11-22", "YYYY-MM-DD", "{date}")).toBe("2026-11-22");
		expect(matchExtraName("2026-11-22 x", "YYYY-MM-DD", "{date}")).toBeNull();
	});
	it("finds the date later in the name", () => {
		expect(matchExtraName("Meeting notes 2026-11-22", "YYYY-MM-DD", ".* {date}")).toBe("2026-11-22");
		expect(matchExtraName("Call 2026-11-22 dentist", "YYYY-MM-DD", "(call|meeting) {date}.*")).toBe("2026-11-22");
		expect(matchExtraName("Chat 2026-11-22", "YYYY-MM-DD", "(call|meeting) {date}.*")).toBeNull();
	});
	it("treats a pattern without {date} as what follows the date", () => {
		expect(matchExtraName("2026-11-22 - groceries", "YYYY-MM-DD", " - .+")).toBe("2026-11-22");
		expect(matchExtraName("2026-11-22 groceries", "YYYY-MM-DD", " - .+")).toBeNull();
		expect(matchExtraName("2026-11-22 anything", "YYYY-MM-DD", "")).toBe("2026-11-22");
	});
	it("reads other formats, including ones of varying length", () => {
		expect(matchExtraName("20261122 scan", "YYYYMMDD", "{date}.*")).toBe("2026-11-22");
		expect(matchExtraName("22 November 2026 trip", "D MMMM YYYY", "{date}.*")).toBe("2026-11-22");
		expect(matchExtraName("3 May 2026", "D MMMM YYYY", "{date}")).toBe("2026-05-03");
		expect(matchExtraName("2026-11-22 Sun notes", "YYYY-MM-DD ddd", "{date}.*")).toBe("2026-11-22");
		// Wrong weekday for the date
		expect(matchExtraName("2026-11-22 Mon", "YYYY-MM-DD ddd", "{date}")).toBeNull();
	});
	it("can exclude names with a lookahead", () => {
		expect(matchExtraName("2026-11-22 draft", "YYYY-MM-DD", "{date}(?! draft).*")).toBeNull();
		expect(matchExtraName("2026-11-22 final", "YYYY-MM-DD", "{date}(?! draft).*")).toBe("2026-11-22");
	});
	it("reports bad patterns", () => {
		expect(compilePattern("{date}(").error).toBeTruthy();
		expect(compilePattern("{date}{date}").error).toBeTruthy();
		expect(matchExtraName("2026-11-22", "YYYY-MM-DD", "{date}(")).toBeNull();
	});
});

describe("extra folders", () => {
	it("checks folders and subfolders", () => {
		expect(inExtraFolder("Inbox/a.md", folder())).toBe(true);
		expect(inExtraFolder("Inbox/sub/a.md", folder())).toBe(true);
		expect(inExtraFolder("Inbox/sub/a.md", folder({ subfolders: false }))).toBe(false);
		expect(inExtraFolder("Inboxes/a.md", folder())).toBe(false);
		expect(inExtraFolder("a.md", folder({ folder: "" }))).toBe(true);
	});
	it("uses the first enabled folder that fits", () => {
		const s = mergeSettings({});
		s.extraFolders = [folder({ id: "off", enabled: false }), folder({ id: "on" })];
		expect(matchExtraFile("Inbox/2026-11-22 x.md", "2026-11-22 x", s)?.folder.id).toBe("on");
		expect(matchExtraFile("Elsewhere/2026-11-22 x.md", "2026-11-22 x", s)).toBeNull();
	});
	it("reads review state from the daily field unless the folder names one", () => {
		const s = example();
		s.statusField = "reviewed";
		expect(extraNeedsReview(folder(), { reviewed: false }, s)).toBe(true);
		expect(extraNeedsReview(folder(), { reviewed: true }, s)).toBe(false);
		expect(extraNeedsReview(folder(), {}, s)).toBe(true);
		expect(extraNeedsReview(folder({ missingStatus: "reviewed" }), {}, s)).toBe(false);
		expect(extraNeedsReview(folder({ statusField: "seen" }), { reviewed: false, seen: true }, s)).toBe(false);
	});
	it("can give items under no matching heading a type", () => {
		const s = example();
		const raw = "- [ ] loose\n## Work log\n- [ ] work\n## Random\n- [ ] random\n";
		expect(analyzeNote(raw, "x", s, "fun").counts).toEqual({ fun: { open: 2, tasks: 0 }, work: { open: 1, tasks: 0 } });
		expect(analyzeNote(raw, "x", s).counts).toEqual({ other: { open: 2, tasks: 0 }, work: { open: 1, tasks: 0 } });
	});
});

describe("pages", () => {
	const day = note({ path: "Journal/2026-11-20.md", needsReview: false, open: 2, counts: { work: { open: 2, tasks: 0 } } });
	const week = note({ path: "Journal/2026-W47.md", kind: "weekly", start: "2026-11-16", end: "2026-11-22", anchor: "2026-11-22" });
	const a = scrap({ path: "Inbox/2026-11-20 a.md", title: "2026-11-20 a", open: 1, counts: { other: { open: 1, tasks: 0 } } });
	const b = scrap({ path: "Calls/2026-11-20 b.md", title: "2026-11-20 b", folderId: "calls", needsReview: false });
	const lone = scrap({ path: "Inbox/2026-11-18 c.md", title: "2026-11-18 c", date: "2026-11-18" });

	it("puts a day's scraps on its daily note's page, below", () => {
		const pages = buildPages([day, week], [a, b, lone], "below", ["calls", "inbox"]);
		const p = pages.get(day.path)!;
		expect(p.scraps.map((x) => x.title)).toEqual(["2026-11-20 b", "2026-11-20 a"]);
		// The daily note is reviewed, one scrap isn't: the page still needs review, with the scrap's counts.
		expect(p.needsReview).toBe(true);
		expect(p.counts).toEqual({ other: { open: 1, tasks: 0 } });
		expect(pages.get(week.path)!.scraps).toEqual([]);
		const alone = pages.get(DAY_PREFIX + "2026-11-18")!;
		expect(alone.note).toBeNull();
		expect(alone.kind).toBe("daily");
		expect(alone.start).toBe("2026-11-18");
		expect(pages.size).toBe(3);
	});
	it("gives each scrap its own page after its day", () => {
		const pages = buildPages([day, week], [a, b, lone], "pages", ["inbox", "calls"]);
		expect(pages.size).toBe(5);
		expect(pages.get(day.path)!.scraps).toEqual([]);
		expect(pages.get(day.path)!.needsReview).toBe(false);
		const order = sortEntries([...pages.values()], "oldest").map((p) => p.title);
		expect(order).toEqual(["2026-11-18 c", "x", "2026-11-20 a", "2026-11-20 b", "x"]);
		expect(pages.get(b.path)!.needsReview).toBe(false);
	});
	it("counts everything on a page once nothing on it needs review", () => {
		const reviewed = scrap({ path: "Inbox/r.md", needsReview: false, open: 3, counts: { fun: { open: 3, tasks: 0 } } });
		const p = buildPages([day], [reviewed], "below", [])!.get(day.path)!;
		expect(p.needsReview).toBe(false);
		expect(p.open).toBe(5);
	});
});

describe("scrap names", () => {
	it("drops the date and the separators around it", async () => {
		const { scrapName } = await import("../src/core/extras");
		expect(scrapName("2026-11-22 call with Sam", "2026-11-22", "YYYY-MM-DD")).toBe("call with Sam");
		expect(scrapName("Call 2026-11-22 with Sam", "2026-11-22", "YYYY-MM-DD")).toBe("Call with Sam");
		expect(scrapName("2026-11-22 - groceries", "2026-11-22", "YYYY-MM-DD")).toBe("groceries");
		expect(scrapName("2026-11-22", "2026-11-22", "YYYY-MM-DD")).toBe("2026-11-22");
	});
});
