import { describe, expect, it } from "vitest";
import { analyzeNote, domainLabel, firstLinkDomain, isNavLine, plainItemText, withMark } from "../src/core/parse";
import { example } from "./fixtures";

const S = example();

const NOTE = `---
tags:
  - daily
reviewed: FALSE
---

# 2026-11-20 Fri

[[2026-11-19 Thu|◀︎ Prev]] | [[2026-W47|📅 Week]] | [[2026-11-21 Sat|Next ▶︎]]

## Tasks
\`\`\`tasks
not done
\`\`\`
----
## Work Log
- [ ] write report #task
- [x] send email #task
- [ ] tidy desk
	- [ ] sub item
### Details
- [ ] deeper heading keeps Work
- [-] cancelled thing
- [/] in progress thing
---
## Just For Fun
- [ ] call a friend
- [ ] look at #tasks list
\`\`\`
- [ ] inside a code block
\`\`\`
---
## Media to watch
- [ ] [A show](https://www.example.com/show)
	**summary**: something
> [!note]
> - [ ] inside a callout

## Finished Today
\`\`\`tasks
done today
\`\`\`
`;

describe("analyzeNote", () => {
	const a = analyzeNote(NOTE, "2026-11-20 Fri", S);

	it("types items by their section", () => {
		const byText = Object.fromEntries(a.items.map((i) => [i.text, i]));
		expect(byText["write report #task"].typeId).toBe("work");
		expect(byText["deeper heading keeps Work"].typeId).toBe("work");
		expect(byText["call a friend"].typeId).toBe("fun");
		expect(byText["[A show](https://www.example.com/show)"].typeId).toBe("media");
		expect(byText["inside a callout"].typeId).toBe("media");
	});

	it("task tag needs a word boundary", () => {
		const byText = Object.fromEntries(a.items.map((i) => [i.text, i]));
		expect(byText["write report #task"].isTask).toBe(true);
		expect(byText["look at #tasks list"].isTask).toBe(false);
	});

	it("ignores code blocks and counts indented items on their own", () => {
		expect(a.items.find((i) => i.text.includes("inside a code block"))).toBeUndefined();
		expect(a.counts).toEqual({
			work: { open: 3, tasks: 1 },
			fun: { open: 2, tasks: 0 },
			media: { open: 2, tasks: 0 },
		});
		expect(a.open).toBe(8);
		expect(a.tasks).toBe(1);
		expect(a.settled).toBe(2); // [x] and [-]; [/] ignored
	});

	it("hides frontmatter, query blocks, nav line, title and empty headings", () => {
		const shown = a.renderText.split("\n").filter((l) => l.trim());
		expect(shown[0]).toBe("## Work Log");
		expect(a.renderText).not.toContain("## Tasks");
		expect(a.renderText).not.toContain("## Finished Today");
		expect(a.renderText).not.toContain("Prev");
		expect(a.renderText).not.toContain("# 2026-11-20 Fri");
		expect(a.renderText).not.toContain("reviewed");
		expect(a.renderText).not.toContain("----");
		expect(a.renderText.split("\n").length).toBe(NOTE.split("\n").length);
	});

	it("weekly title heading is hidden when it starts with the title", () => {
		const w = analyzeNote("# 2026-W47 ( 11/16 - 11/20 )\n\n## Daily Notes\n- [ ] x #task\n", "2026-W47", S);
		expect(w.renderText).not.toContain("2026-W47");
		expect(w.counts).toEqual({ other: { open: 0, tasks: 1 } });
	});

	it("a new item type picks up a previously unmatched heading", () => {
		const s = example();
		s.itemTypes.push({ id: "weekly-tasks", label: "Weekly tasks", color: "", headings: ["daily notes"],
			match: "exact", enabled: true, domainLabels: {} });
		const w = analyzeNote("## Daily Notes\n- [ ] x #task\n- [x] y #task\n", "2026-W47", s);
		expect(w.counts).toEqual({ "weekly-tasks": { open: 0, tasks: 1 } });
	});

	it("list order decides overlaps; disabled types count as Other", () => {
		const n = "## fun and media\n- [ ] x\n";
		expect(analyzeNote(n, "t", S).items[0].typeId).toBe("fun");
		const s = example();
		s.itemTypes[1].enabled = false;
		expect(analyzeNote(n, "t", s).items[0].typeId).toBe("media");
		s.itemTypes[2].enabled = false;
		expect(analyzeNote(n, "t", s).items[0].typeId).toBe("other");
	});

	it("an H1 resets to Other; hidden Other isn't counted", () => {
		const n = "## Just For Fun\n- [ ] a\n# Big\n- [ ] b\n";
		expect(analyzeNote(n, "t", S).items.map((i) => i.typeId)).toEqual(["fun", "other"]);
		const s = example();
		s.other.hidden = true;
		expect(analyzeNote(n, "t", s).open).toBe(1);
	});

	it("rendered items exclude hidden parts", () => {
		expect(a.renderedItems.length).toBe(a.items.length);
		const withQuery = analyzeNote("```tasks\n- [ ] in query\n```\n- [ ] real\n", "t", S);
		expect(withQuery.items.length).toBe(1);
	});
});

describe("helpers", () => {
	it("isNavLine", () => {
		expect(isNavLine("[[a|◀︎ Prev]] | [[b|Next ▶︎]]")).toBe(true);
		expect(isNavLine("← back to → there")).toBe(false);
		expect(isNavLine("← go →")).toBe(true);
	});
	it("withMark", () => {
		expect(withMark("\t- [ ] thing [x]", "x")).toBe("\t- [x] thing [x]");
		expect(withMark("> 1. [x] done", " ")).toBe("> 1. [ ] done");
	});
	it("plain text and domains", () => {
		expect(plainItemText("[A show](https://x.com) and [[Folder/Note|alias]] **bold**")).toBe("A show and alias bold");
		expect(firstLinkDomain("[A](https://www.anilist.co/x)")).toBe("anilist.co");
		expect(domainLabel("store.steampowered.com", { "steampowered.com": "Games" })).toBe("Games");
		expect(domainLabel("notsteampowered.com", { "steampowered.com": "Games" })).toBeNull();
	});
});

describe("comments", () => {
	it("items inside %% comments %% are not counted", () => {
		const n = "## Just For Fun\n%%\n- [ ] hidden\n%%\n%% - [ ] inline %%\n- [ ] shown\n";
		const a = analyzeNote(n, "t", S);
		expect(a.items.map((i) => i.text)).toEqual(["shown"]);
		expect(a.renderText).not.toContain("hidden");
	});
});
