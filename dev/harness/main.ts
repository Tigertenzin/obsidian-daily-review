/**
 * Visual test page: runs the real ReviewView and NoteStore against the Obsidian mock and
 * a few generic example notes. URL parameters:
 *   device=phone|tablet|desktop   body classes Obsidian would set (phone adds the floating nav)
 *   theme=light|dark
 */
import { parse as parseYaml } from "yaml";
import { Events, installDomHelpers, moment, Platform, Scope, TFile } from "./obsidian-mock";
import { mergeSettings } from "../../src/core/settings";
import { NoteStore } from "../../src/store";
import { ReviewView } from "../../src/view";

installDomHelpers();

const params = new URLSearchParams(location.search);
const device = params.get("device") ?? "desktop";
const theme = params.get("theme") ?? "light";
document.body.addClass(theme === "dark" ? "theme-dark" : "theme-light");
if (device !== "desktop") {
	document.body.addClass("is-mobile");
	Platform.isMobile = true;
	Platform.isDesktop = false;
}
if (device === "phone") {
	document.body.addClass("is-phone", "is-floating-nav");
	Platform.isPhone = true;
}
if (device === "tablet") {
	document.body.addClass("is-tablet");
	Platform.isTablet = true;
}

// ------------------------------------------------------------------ example notes

const D = "YYYY-MM-DD";
const today = moment().startOf("day");
const notes: Record<string, string> = {};
function daily(daysAgo: number, body: string, reviewed = false) {
	const d = today.clone().subtract(daysAgo, "days");
	notes[`Journal/${d.format("YYYY-MM-DD ddd")}.md`] =
		`---\ntags:\n  - journal\nreviewed: ${reviewed}\n---\n\n# ${d.format("YYYY-MM-DD ddd")}\n\n` +
		`[[${d.clone().subtract(1, "day").format("YYYY-MM-DD ddd")}|◀︎ Prev]] | [[${d.clone().add(1, "day").format("YYYY-MM-DD ddd")}|Next ▶︎]]\n\n` +
		"## Tasks\n```tasks\nnot done\n```\n----\n" + body;
}
daily(1, `## Work Log
- [ ] Send the quarterly report to the team #task
- [x] Review pull requests #task
- [ ] Book a meeting room for Thursday

## Fun Stuff
- [ ] Finally fix the bike's rear brake
	- all I could do was drop it off and wait for a call
- [ ] Re-evaluate how I take notes: make it a better place to dump thoughts to sort out later, with a much longer line so it wraps on narrow screens
	- [ ] This might need some adjustments elsewhere too
- [-] Cancelled plan

## Media
- [ ] [A documentary about lighthouses](https://www.example.com/watch/lighthouses)
- [ ] [Some article](https://news.example.org/article)
`);
daily(2, "## Fun Stuff\n- [ ] Call a friend back\n- [x] Water the plants\n");
daily(3, "## Work Log\n- [ ] Update the budget spreadsheet #task\n- [ ] Tidy desk\n## Media\n- [ ] [A podcast episode](https://pods.example.net/ep/1)\n");
daily(5, "## Fun Stuff\n- [x] Went for a run\n");
daily(9, "## Work Log\n- [ ] Draft the project plan #task\n## Fun Stuff\n- [ ] Plan the weekend trip\n- [ ] Try the new bakery\n");
daily(12, "## Media\n- [ ] [Old bookmark](https://example.com/old)\n");
daily(0, "## Fun Stuff\n- [ ] Something for today\n");
daily(4, "## Fun Stuff\n- [x] Done already\n", true);
const lastWeek = today.clone().subtract(7, "days");
notes[`Journal/${lastWeek.format("GGGG-[W]WW")}.md`] =
	`---\ntags: [journal, weekly]\nreviewed: false\n---\n# ${lastWeek.format("GGGG-[W]WW")} ( notes )\n\n## Daily Notes\n- [ ] Check the mail #task\n- [x] Pay rent #task\n`;
const lastMonth = today.clone().subtract(1, "month");
notes[`Journal/${lastMonth.format("YYYY-MM MMM")}.md`] =
	`---\ntags: [journal, monthly]\n---\n# ${lastMonth.format("YYYY-MM")} (${lastMonth.format("MMM")})\n\n## Goals\n- [ ] Read two books\n`;
const lastYear = today.clone().subtract(1, "year");
notes[`Journal/Year ${lastYear.format("YYYY")}.md`] = `---\ntags: [journal, yearly]\n---\n## Highlights\n- [ ] Write the year review\n`;

// ------------------------------------------------------------------ mock app

function cacheFor(text: string) {
	const fm = text.match(/^---\n([\s\S]*?)\n---/);
	const frontmatter = fm ? (parseYaml(fm[1]) as Record<string, unknown>) : undefined;
	const raw = frontmatter?.tags;
	const tags = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).map((t) => "#" + t);
	return { frontmatter, tags };
}

const files = new Map(Object.keys(notes).map((p) => [p, new TFile(p)]));
const metadataEvents = new Events();
const app: any = {
	scope: null,
	vault: {
		getMarkdownFiles: () => [...files.values()],
		getAbstractFileByPath: (p: string) => files.get(p) ?? null,
		cachedRead: async (f: TFile) => notes[f.path],
		process: async (f: TFile, fn: (s: string) => string) => {
			notes[f.path] = fn(notes[f.path]);
			setTimeout(() => metadataEvents.trigger("changed", f, notes[f.path]), 30);
			return notes[f.path];
		},
	},
	metadataCache: { getFileCache: (f: TFile) => (notes[f.path] ? cacheFor(notes[f.path]) : null) },
	workspace: {
		trigger: () => {},
		openLinkText: async (l: string) => console.log("[open link]", l),
		getLeaf: () => ({ openFile: async (f: TFile) => console.log("[open file]", f.path) }),
	},
	plugins: { enabledPlugins: new Set(), plugins: {} },
};

const settings = mergeSettings({ folder: "Journal", membershipTag: "journal", titlePrefixMatch: true });
settings.kinds.daily.titleFormat = "YYYY-MM-DD ddd";
settings.kinds.monthly.titleFormat = "YYYY-MM MMM";
settings.kinds.quarterly.enabled = false;
settings.kinds.yearly.titleFormat = "[Year ]YYYY";
settings.itemTypes = [
	{ id: "work", label: "Work", color: "#e5484d", headings: ["work log"], match: "contains", enabled: true, domainLabels: {} },
	{ id: "fun", label: "Fun Stuff", color: "#46a758", headings: ["fun stuff"], match: "contains", enabled: true, domainLabels: {} },
	{ id: "media", label: "Media", color: "#d4a72c", headings: ["media"], match: "contains", enabled: true,
		domainLabels: { "example.com": "Video" } },
];

const store = new NoteStore(app, () => settings);
metadataEvents.on("changed", (f: TFile, data: string) => void store.update(f, data));
const plugin: any = {
	settings,
	store,
	saveSettings: async (rebuild = true) => {
		if (rebuild) await store.rebuild();
		else store.trigger("changed", null);
	},
};

// ------------------------------------------------------------------ Obsidian-like page

const appContainer = document.body.createDiv({ cls: "app-container" });
const leafEl = appContainer.createDiv({ cls: "workspace-leaf mod-active" });
const header = leafEl.createDiv({ cls: "view-header" });
header.createDiv({ cls: "view-header-title-container" }).createDiv({ cls: "view-header-title", text: "Periodic Note Review" });
const leafContent = leafEl.createDiv({ cls: "workspace-leaf-content", attr: { "data-type": "periodic-note-review" } });
if (device === "phone") {
	const nav = document.body.createDiv({ cls: "mobile-navbar" });
	const actions = nav.createDiv({ cls: "mobile-navbar-actions" });
	for (const i of ["‹", "›", "⌕", "+", "3", "≡"]) actions.createDiv({ cls: "mobile-navbar-action", text: i });
}

const view = new ReviewView({ app, containerEl: leafContent }, plugin);
(window as any).pnr = { view, store, settings, notes };
document.addEventListener("keydown", (e) => view.scope?.handle(e as KeyboardEvent));

await store.rebuild();
await view.onOpen();
(window as any).pnrReady = true;
