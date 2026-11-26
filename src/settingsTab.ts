import { AbstractInputSuggest, App, moment, PluginSettingTab, setIcon, Setting, TFolder } from "obsidian";
import { compilePattern, dateFormats, extraLabel, matchExtraName } from "./core/extras";
import { describeFormat } from "./core/queue";
import { typeForHeading } from "./core/parse";
import { statusFieldFor } from "./core/review";
import {
	DEFAULT_EXTRA_FOLDER, ExtraFolder, ExtraLayout, HighlightStyle, ItemType, Kind, KINDS, MatchMode, MissingStatus,
	OTHER_ID, UnknownMarks,
} from "./core/settings";
import type PeriodicNoteReviewPlugin from "./main";
import type { NoteStore } from "./store";

const KIND_LABEL: Record<Kind, string> = {
	daily: "Daily", weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly",
};

function listText(list: string[]): string {
	return list.join(", ");
}
function parseList(text: string): string[] {
	return text.split(",").map((s) => s.trim()).filter(Boolean);
}
function slug(label: string, taken: Set<string>): string {
	const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "type";
	let id = base;
	for (let n = 2; taken.has(id) || id === OTHER_ID; n++) id = `${base}-${n}`;
	return id;
}

const CURRENT_LABEL: Record<Kind, string> = {
	daily: "Today's note", weekly: "This week's note", monthly: "This month's note",
	quarterly: "This quarter's note", yearly: "This year's note",
};

function countText(n: number): string {
	if (n === 0) return "No notes in your folder match yet.";
	return `Matches ${n} ${n === 1 ? "note" : "notes"} in your folder.`;
}

/** Type-ahead for a folder path: every folder in the vault whose path contains the query. */
class FolderSuggest extends AbstractInputSuggest<string> {
	constructor(app: App, private input: HTMLInputElement, private onPick: (path: string) => void) {
		super(app, input);
	}

	protected getSuggestions(query: string): string[] {
		const q = query.trim().toLowerCase();
		return this.app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && !f.isRoot())
			.map((f) => f.path)
			.filter((p) => p.toLowerCase().includes(q))
			.sort((a, b) => a.localeCompare(b))
			.slice(0, 50);
	}

	renderSuggestion(path: string, el: HTMLElement): void {
		el.setText(path);
	}

	selectSuggestion(path: string): void {
		this.input.value = path;
		this.onPick(path);
		this.close();
	}
}

/** Pattern examples shown under each extra folder's file name pattern. */
const PATTERN_HINTS: [string, string][] = [
	["{date}.*", "The date, then anything (or nothing). \"2026-11-22 call with Sam\""],
	["{date}", "Only the date. \"2026-11-22\""],
	["{date} - .+", "The date, \" - \", then a name. \"2026-11-22 - groceries\""],
	[".* {date}", "The date at the end. \"Meeting notes 2026-11-22\""],
	["(Call|Meeting) {date}.*", "Only names that start with Call or Meeting."],
	["{date}(?! draft).*", "Anything after the date, except \" draft\"."],
];

type SettingsTabId = "notes" | "extra" | "types" | "checkboxes" | "page";
const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
	{ id: "notes", label: "Notes" },
	{ id: "extra", label: "Extra folders" },
	{ id: "types", label: "Item types" },
	{ id: "checkboxes", label: "Checkboxes" },
	{ id: "page", label: "Review page" },
];

export class ReviewSettingTab extends PluginSettingTab {
	/** The settings tab shown; kept while the settings window stays open. */
	private tab: SettingsTabId = "notes";
	private sharedFieldHints: { kind: Kind; el: HTMLElement; input?: HTMLInputElement }[] = [];
	private formatPreviews: { kind: Kind; el: HTMLElement }[] = [];
	private lastCounts: ReturnType<NoteStore["countByKind"]> | null = null;
	private countTimer = 0;

	constructor(app: App, private plugin: PeriodicNoteReviewPlugin) {
		super(app, plugin);
	}

	private get s() {
		return this.plugin.settings;
	}

	private save(rebuild = true) {
		void this.plugin.saveSettings(rebuild);
	}

	display(): void {
		const el = this.containerEl;
		el.empty();
		el.addClass("pnr-settings");

		this.sharedFieldHints = [];
		this.formatPreviews = [];

		el.createDiv({
			cls: "setting-item-description pnr-version",
			text: `Periodic Note Review ${this.plugin.manifest.version} is running. After an update, restart Obsidian (or turn the plugin off and on) if this doesn't show the new version.`,
		});

		const tabs = el.createDiv({ cls: "pnr-settings-tabs", attr: { role: "tablist" } });
		for (const t of SETTINGS_TABS) {
			const b = tabs.createEl("button", { cls: "pnr-settings-tab", text: t.label, attr: { role: "tab" } });
			b.toggleClass("is-active", t.id === this.tab);
			b.setAttr("aria-selected", t.id === this.tab ? "true" : "false");
			b.addEventListener("click", () => {
				this.tab = t.id;
				this.display();
			});
		}
		const page = el.createDiv({ cls: "pnr-settings-page" });
		switch (this.tab) {
			case "notes": this.renderNotesTab(page); break;
			case "extra": this.renderExtraTab(page); break;
			case "types": this.renderTypesTab(page); break;
			case "checkboxes": this.renderCheckboxesTab(page); break;
			case "page": this.renderPageTab(page); break;
		}
	}

	private renderNotesTab(el: HTMLElement) {
		new Setting(el).setName("General").setHeading();
		new Setting(el)
			.setName("Notes folder")
			.setDesc("Periodic notes are found in this folder and its subfolders. Leave empty for the whole vault.")
			.addText((t) => t.setValue(this.s.folder).onChange((v) => {
				this.s.folder = v.trim();
				this.save();
				this.refreshPreviews();
			}));
		new Setting(el)
			.setName("Membership tag")
			.setDesc("Only notes with this tag (in frontmatter or the body) are included. Leave empty to include every note in the folder.")
			.addText((t) => t.setValue(this.s.membershipTag).onChange((v) => {
				this.s.membershipTag = v.trim();
				this.save();
				this.refreshPreviews();
			}));
		new Setting(el)
			.setName("Title only needs to start with the format")
			.setDesc("For example, a daily note titled \"2026-11-22 trip\" still counts.")
			.addToggle((t) => t.setValue(this.s.titlePrefixMatch).onChange((v) => {
				this.s.titlePrefixMatch = v;
				this.save();
				this.refreshPreviews();
			}));
		new Setting(el)
			.setName("Status field")
			.setDesc("Frontmatter field that says whether a note has been reviewed. Every kind of note uses it, unless that kind sets its own below.")
			.addText((t) => t.setValue(this.s.statusField).onChange((v) => {
				this.s.statusField = v.trim();
				this.save();
				this.refreshSharedFieldHints();
			}));
		new Setting(el)
			.setName("Unreviewed value")
			.setDesc("The value that means \"not reviewed yet\" (any case). Any other value counts as reviewed.")
			.addText((t) => t.setValue(this.s.unreviewedValue).onChange((v) => {
				this.s.unreviewedValue = v.trim();
				this.save();
			}));
		const intro = el.createEl("p", { cls: "setting-item-description pnr-kinds-intro" });
		intro.appendText("A note's kind comes from its tag (checked yearly, quarterly, monthly, then weekly). A note with none of these tags gets the first kind whose title format fits, from daily to yearly. Title formats use moment.js tokens, such as YYYY (2026), MM (11), MMM (Nov), DD (22), ddd (Sun) and GGGG-[W]WW (2026-W47); text in [brackets] is kept as written. ");
		intro.createEl("a", { text: "All format tokens", href: "https://momentjs.com/docs/#/displaying/format/" });
		intro.appendText(".");

		// ------------------------------------------------------------ one section per kind
		for (const k of KINDS) this.renderKind(el, k);
		this.refreshPreviews();
	}

	private renderExtraTab(el: HTMLElement) {
		this.renderExtraFolders(el);
	}

	private renderTypesTab(el: HTMLElement) {
		new Setting(el).setName("Item types").setHeading();
		el.createEl("p", {
			cls: "setting-item-description",
			text: "An item's type comes from the section heading it sits under. Each section heading takes the first type in this list whose pattern matches; headings no type matches are Other.",
		});
		new Setting(el)
			.setName("Section heading level")
			.setDesc("Headings at this level start a new section. Deeper headings keep their section's type.")
			.addDropdown((d) => {
				for (let n = 1; n <= 6; n++) d.addOption(String(n), `H${n}`);
				d.setValue(String(this.s.sectionLevel)).onChange((v) => {
					this.s.sectionLevel = Number(v);
					this.save();
					this.display();
				});
			});
		const typesEl = el.createDiv({ cls: "pnr-types" });
		this.s.itemTypes.forEach((t, i) => this.renderType(typesEl, t, i));
		this.renderOther(typesEl);
		new Setting(el).addButton((b) => b.setButtonText("Add item type").onClick(() => {
			const ids = new Set(this.s.itemTypes.map((t) => t.id));
			this.s.itemTypes.push({
				id: slug("New type", ids), label: "New type", color: "#d98c3f", headings: [],
				match: "contains", enabled: true, domainLabels: {},
			});
			this.save();
			this.display();
		}));
		this.renderUnmatched(el);
	}

	private renderCheckboxesTab(el: HTMLElement) {
		new Setting(el).setName("Checkboxes").setHeading();
		new Setting(el)
			.setName("Open marks")
			.setDesc("Characters between the brackets that mean open, separated by commas. Use a space for [ ].")
			.addText((t) => t.setValue(this.s.openMarks.map((m) => (m === " " ? "space" : m)).join(", ")).onChange((v) => {
				this.s.openMarks = v.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (x === "space" ? " " : x[0]));
				this.save();
			}));
		new Setting(el)
			.setName("Settled marks")
			.setDesc("Characters that mean done or cancelled, separated by commas.")
			.addText((t) => t.setValue(listText(this.s.settledMarks)).onChange((v) => {
				this.s.settledMarks = parseList(v).map((x) => x[0]);
				this.save();
			}));
		new Setting(el)
			.setName("Other marks")
			.setDesc("How to treat any other mark, such as [/] or [>].")
			.addDropdown((d) => d
				.addOptions({ ignore: "Ignore", open: "Open", settled: "Settled" })
				.setValue(this.s.unknownMarks)
				.onChange((v) => {
					this.s.unknownMarks = v as UnknownMarks;
					this.save();
				}));
		new Setting(el)
			.setName("Task tag")
			.setDesc("Items carrying this tag are counted as tasks (shown as squares in the queue).")
			.addText((t) => t.setValue(this.s.taskTag).onChange((v) => {
				this.s.taskTag = v.trim();
				this.save();
			}));
	}

	private renderPageTab(el: HTMLElement) {
		new Setting(el).setName("The page").setHeading();
		new Setting(el)
			.setName("Highlight open items with")
			.addDropdown((d) => d
				.addOptions({ tint: "A light background tint", bar: "A coloured bar on the left", checkbox: "A coloured checkbox", none: "Nothing" })
				.setValue(this.s.highlightStyle)
				.onChange((v) => {
					this.s.highlightStyle = v as HighlightStyle;
					this.save(false);
				}));
		new Setting(el)
			.setName("Hidden code block languages")
			.setDesc("Fenced blocks in these languages are queries showing other notes, so they're left off the page. Separate with commas.")
			.addText((t) => t.setValue(listText(this.s.hiddenBlockLanguages)).onChange((v) => {
				this.s.hiddenBlockLanguages = parseList(v);
				this.save();
			}));
		new Setting(el)
			.setName("Hide the navigation line")
			.setDesc("A line that starts with ◀ or ← and ends with ▶ or →, such as previous/next links.")
			.addToggle((t) => t.setValue(this.s.hideNavLine).onChange((v) => {
				this.s.hideNavLine = v;
				this.save();
			}));
		new Setting(el)
			.setName("Hide the title heading")
			.setDesc("The first H1, when it starts with the note's title.")
			.addToggle((t) => t.setValue(this.s.hideTitleHeading).onChange((v) => {
				this.s.hideTitleHeading = v;
				this.save();
			}));
		new Setting(el)
			.setName("Show future notes in the queue")
			.setDesc("Notes for days and periods that haven't started yet. When off, they're folded away under \"Upcoming\" at the end of the queue. Opening or folding \"Upcoming\" in the queue changes this too, so it's remembered.")
			.addToggle((t) => t.setValue(this.s.showFuture).onChange((v) => {
				this.s.showFuture = v;
				this.save(false);
			}));
		new Setting(el)
			.setName("Check items off from the page")
			.setDesc("Clicking a checkbox on the page checks or unchecks it in the note.")
			.addToggle((t) => t.setValue(this.s.allowCheckingItems).onChange((v) => {
				this.s.allowCheckingItems = v;
				this.save(false);
			}));
		new Setting(el)
			.setName("Use the Tasks plugin for tasks")
			.setDesc("Items with the task tag are toggled by the Tasks plugin, so its done date and recurrence settings apply.")
			.addToggle((t) => t.setValue(this.s.useTasksPlugin).onChange((v) => {
				this.s.useTasksPlugin = v;
				this.save(false);
			}));
		new Setting(el)
			.setName("Show \"N to review\" in the status bar")
			.addToggle((t) => t.setValue(this.s.showStatusBar).onChange((v) => {
				this.s.showStatusBar = v;
				this.save(false);
				this.display();
			}));
		if (this.s.showStatusBar) {
			new Setting(el)
				.setName("Status bar style")
				.setDesc("Desktop only: Obsidian's phone and tablet apps have no status bar.")
				.addDropdown((d) => d
					.addOption("icon-text", "Icon and text (18 to review)")
					.addOption("icon-number", "Icon and number (18)")
					.addOption("text", "Text only")
					.setValue(this.s.statusBarStyle)
					.onChange((v) => {
						this.s.statusBarStyle = v as typeof this.s.statusBarStyle;
						this.save(false);
					}));
		}
	}

	private renderKind(el: HTMLElement, k: Kind) {
		const ks = this.s.kinds[k];
		new Setting(el).setName(`${KIND_LABEL[k]} notes`).setHeading();
		new Setting(el)
			.setName("Include in the review")
			.setDesc(ks.enabled ? "" : `${KIND_LABEL[k]} notes are left out of the queue and the counts.`)
			.addToggle((t) => t.setValue(ks.enabled).onChange((v) => {
				ks.enabled = v;
				this.save();
				this.display();
			}));
		if (!ks.enabled) return;
		if (k !== "daily") {
			new Setting(el)
				.setName("Tag")
				.setDesc(`Notes with this tag are ${k} notes.`)
				.addText((t) => t.setValue(ks.tag).onChange((v) => {
					ks.tag = v.trim();
					this.save();
					this.refreshPreviews();
				}));
		}
		const format = new Setting(el).setName("Title format");
		const preview = format.descEl.createDiv({ cls: "pnr-format-preview" });
		this.formatPreviews.push({ kind: k, el: preview });
		format.addText((t) => t.setValue(ks.titleFormat).onChange((v) => {
			ks.titleFormat = v;
			this.save();
			this.refreshPreviews();
		}));

		const field = new Setting(el).setName("Status field (optional)");
		const hint = field.descEl.createSpan();
		this.sharedFieldHints.push({ kind: k, el: hint });
		field.addText((t) => {
			t.setPlaceholder(this.s.statusField).setValue(ks.statusField).onChange((v) => {
				ks.statusField = v.trim();
				this.save();
				this.refreshSharedFieldHints();
			});
			this.sharedFieldHints[this.sharedFieldHints.length - 1].input = t.inputEl;
		});
		new Setting(el)
			.setName("Reviewed value (optional)")
			.setDesc("Leave empty to use the shared rule: any value other than the unreviewed value counts as reviewed. If set, only this value does (for example \"completed\").")
			.addText((t) => t.setValue(ks.reviewedValue).onChange((v) => {
				ks.reviewedValue = v.trim();
				this.save();
			}));
		new Setting(el)
			.setName("When the status field is missing")
			.addDropdown((d) => d
				.addOptions({ reviewed: "Counts as reviewed", unreviewed: "Counts as not reviewed" })
				.setValue(ks.missingStatus)
				.onChange((v) => {
					ks.missingStatus = v as MissingStatus;
					this.save();
				}));
		new Setting(el)
			.setName("Can be marked reviewed from the review page")
			.addToggle((t) => t.setValue(ks.canMarkReviewed).onChange((v) => {
				ks.canMarkReviewed = v;
				this.save(false);
			}));
		this.refreshSharedFieldHints();
	}

	/** Keep each kind's "uses the shared field" hint and placeholder in step. */
	private refreshSharedFieldHints() {
		for (const h of this.sharedFieldHints) {
			const own = this.s.kinds[h.kind].statusField.trim();
			h.el.setText(own
				? `This kind reads and writes "${own}" instead of the shared field.`
				: `Empty: uses the shared status field, "${this.s.statusField}".`);
			h.input?.setAttr("placeholder", this.s.statusField);
		}
	}

	private fillCount(el: HTMLElement, kind: Kind) {
		if (!this.lastCounts) return;
		el.empty();
		el.createDiv({ text: countText(this.lastCounts.counts[kind]) });
		const miss = this.lastCounts.misses[kind];
		if (miss.count > 0) {
			const tag = this.s.kinds[kind].tag;
			const w = el.createDiv({ cls: "pnr-format-warn" });
			w.appendText(`${miss.count} ${miss.count === 1 ? "note" : "notes"} tagged #${tag} don't fit this format, such as `);
			w.createEl("code", { text: miss.example });
			w.appendText(".");
		}
	}

	/** Title format previews: today's title, how it's read, and how many notes match. */
	private refreshPreviews() {
		for (const p of this.formatPreviews) {
			const ks = this.s.kinds[p.kind];
			p.el.empty();
			const ex = describeFormat(p.kind, ks.titleFormat);
			const line = p.el.createDiv();
			line.appendText(`${CURRENT_LABEL[p.kind]}: `);
			line.createEl("code", { text: ex.title || "(empty)" });
			if (ex.ok) p.el.createDiv({ text: `Read as ${ex.readAs}` });
			else p.el.createDiv({ cls: "pnr-format-warn", text: "This title can't be read back as this period. Check the format." });
			const count = p.el.createDiv({ cls: "pnr-format-count", text: "Counting notes…" });
			if (this.lastCounts) this.fillCount(count, p.kind);
		}
		window.clearTimeout(this.countTimer);
		this.countTimer = window.setTimeout(() => {
			this.lastCounts = this.plugin.store.countByKind(this.s);
			for (const p of this.formatPreviews) {
				const el = p.el.querySelector<HTMLElement>(".pnr-format-count");
				if (el) this.fillCount(el, p.kind);
			}
		}, 350);
	}

	private renderType(parent: HTMLElement, t: ItemType, i: number) {
		const box = parent.createDiv({ cls: "pnr-type-box" });
		box.style.setProperty("--pnr-color", t.color || "var(--interactive-accent)");
		const types = this.s.itemTypes;

		new Setting(box)
			.setName(t.label || "(unnamed)")
			.setClass("pnr-type-head")
			.addColorPicker((c) => c.setValue(t.color || "#888888").onChange((v) => {
				t.color = v;
				box.style.setProperty("--pnr-color", v);
				this.save(false);
			}))
			.addExtraButton((b) => b.setIcon("arrow-up").setTooltip("Move up").setDisabled(i === 0).onClick(() => {
				[types[i - 1], types[i]] = [types[i], types[i - 1]];
				this.save();
				this.display();
			}))
			.addExtraButton((b) => b.setIcon("arrow-down").setTooltip("Move down").setDisabled(i === types.length - 1).onClick(() => {
				[types[i + 1], types[i]] = [types[i], types[i + 1]];
				this.save();
				this.display();
			}))
			.addExtraButton((b) => b.setIcon("trash-2").setTooltip("Delete").onClick(() => {
				types.splice(i, 1);
				this.save();
				this.display();
			}))
			.addToggle((tg) => tg.setTooltip("Enabled").setValue(t.enabled).onChange((v) => {
				t.enabled = v;
				this.save();
				this.display();
			}));

		new Setting(box).setName("Label").setClass("pnr-sub").addText((x) => x.setValue(t.label).onChange((v) => {
			t.label = v;
			box.querySelector(".pnr-type-head .setting-item-name")?.setText(v || "(unnamed)");
			this.save(false);
		}));
		const preview = createDiv({ cls: "pnr-preview" });
		new Setting(box)
			.setName("Heading patterns")
			.setDesc("Separate with commas. Case doesn't matter.")
			.setClass("pnr-sub")
			.addDropdown((d) => d
				.addOptions({ contains: "Heading contains", exact: "Heading is exactly", regex: "Regular expression" })
				.setValue(t.match)
				.onChange((v) => {
					t.match = v as MatchMode;
					this.save();
					this.renderPreview(preview, t);
				}))
			.addText((x) => x.setValue(listText(t.headings)).onChange((v) => {
				t.headings = parseList(v);
				this.save();
				this.renderPreview(preview, t);
			}));
		box.appendChild(preview);
		this.renderPreview(preview, t);

		const domains = new Setting(box)
			.setName("Labels from link domains")
			.setDesc("Optional. One per line, as domain = label. Open items whose first link points at a listed site (or its subdomain) show the label; other sites show their domain.")
			.setClass("pnr-sub")
			.addTextArea((x) => {
				x.setValue(Object.entries(t.domainLabels).map(([d, l]) => `${d} = ${l}`).join("\n"))
					.onChange((v) => {
						const map: Record<string, string> = {};
						for (const line of v.split("\n")) {
							const [d, ...rest] = line.split("=");
							if (d?.trim() && rest.join("=").trim()) map[d.trim()] = rest.join("=").trim();
						}
						t.domainLabels = map;
						this.save(false);
					});
				x.inputEl.rows = 3;
			});
		domains.settingEl.addClass("pnr-domains");
	}

	private renderOther(parent: HTMLElement) {
		const o = this.s.other;
		const box = parent.createDiv({ cls: "pnr-type-box is-other" });
		box.style.setProperty("--pnr-color", o.color || "var(--text-muted)");
		new Setting(box)
			.setName(`${o.label} (built in)`)
			.setDesc("Items under headings no type matches, or with no heading above them.")
			.setClass("pnr-type-head")
			.addColorPicker((c) => c.setValue(o.color || "#888888").onChange((v) => {
				o.color = v;
				box.style.setProperty("--pnr-color", v);
				this.save(false);
			}));
		new Setting(box).setName("Label").setClass("pnr-sub").addText((x) => x.setValue(o.label).onChange((v) => {
			o.label = v || "Other";
			this.save(false);
		}));
		new Setting(box)
			.setName("Hide")
			.setDesc("Hidden items still show on the page, but aren't highlighted or counted.")
			.setClass("pnr-sub")
			.addToggle((x) => x.setValue(o.hidden).onChange((v) => {
				o.hidden = v;
				this.save();
			}));
	}

	/** "Matches in your notes: Fun (40), Just for fun (2)…" */
	private renderPreview(el: HTMLElement, t: ItemType) {
		el.empty();
		const index = this.plugin.store.headingIndex();
		const mine = index.filter(([h]) => typeForHeading(h, this.s) === t.id);
		if (!this.plugin.store.ready) {
			el.setText("Reading your notes…");
			return;
		}
		if (!t.enabled) {
			el.setText("Turned off: its items count as Other.");
			return;
		}
		if (mine.length === 0) {
			el.addClass("is-empty");
			el.setText("No headings in your notes match this type.");
			return;
		}
		el.removeClass("is-empty");
		el.createSpan({ cls: "pnr-preview-label", text: "Matches in your notes: " });
		const shown = mine.slice(0, 8).map(([h, n]) => `${h} (${n})`).join(", ");
		el.appendText(shown + (mine.length > 8 ? `, and ${mine.length - 8} more` : ""));
	}

	private renderUnmatched(el: HTMLElement) {
		const index = this.plugin.store.headingIndex().filter(([h]) => typeForHeading(h, this.s) === OTHER_ID);
		if (!this.plugin.store.ready || index.length === 0) return;
		const box = el.createEl("details", { cls: "pnr-unmatched" });
		const sum = box.createEl("summary");
		setIcon(sum.createSpan(), "info");
		sum.createSpan({ text: ` ${index.length} section headings in your notes count as ${this.s.other.label}` });
		box.createDiv({
			cls: "pnr-preview",
			text: index.slice(0, 40).map(([h, n]) => `${h || "(empty)"} (${n})`).join(", ") + (index.length > 40 ? "…" : ""),
		});
	}

	// ---------------------------------------------------------------- extra folders

	private renderExtraFolders(el: HTMLElement) {
		new Setting(el).setName("Extra folders").setHeading();
		el.createEl("p", {
			cls: "setting-item-description",
			text: "Notes elsewhere with a date in their file name, such as quick notes, call notes or clippings. Each one shows up as a scrap with the daily note for its date, or on a page of its own for days without one. Scraps have their own review state, and their open items count toward that day.",
		});
		new Setting(el)
			.setName("Show a day's scraps")
			.setDesc("Below: the daily note and its scraps make one page, with each scrap on a sheet of its own under the note. Own pages: each scrap is a page after its day's note. The \"Show extra notes below the daily note or as their own pages\" command switches between them.")
			.addDropdown((d) => d
				.addOptions({ below: "Below the daily note", pages: "As their own pages" })
				.setValue(this.s.extraLayout)
				.onChange((v) => {
					this.s.extraLayout = v as ExtraLayout;
					this.save(false);
					this.display();
				}));
		if (this.s.extraLayout === "below") {
			new Setting(el)
				.setName("Marking scraps reviewed")
				.setDesc("Separately: each scrap has its own Mark reviewed button at its top right, and the page's button marks the daily note (or, once that's reviewed, the scraps left). Together: the page's button marks the daily note and all its scraps at once.")
				.addDropdown((d) => d
					.addOptions({ separate: "Separately, with their own buttons", together: "Together with the daily note" })
					.setValue(this.s.scrapReview)
					.onChange((v) => {
						this.s.scrapReview = v as "separate" | "together";
						this.save(false);
					}));
			new Setting(el)
				.setName("Scraps in the queue")
				.setDesc("How a day's scraps show in its queue row: one icon with a count, or one icon per scrap in its folder's colour.")
				.addDropdown((d) => d
					.addOptions({ count: "One icon and a count", each: "One icon per scrap" })
					.setValue(this.s.scrapQueueStyle)
					.onChange((v) => {
						this.s.scrapQueueStyle = v as "count" | "each";
						this.save(false);
					}));
			new Setting(el)
				.setName("Fold reviewed scraps")
				.setDesc("Show a reviewed scrap as just its title bar, with a chevron to open it.")
				.addToggle((t) => t.setValue(this.s.collapseReviewedScraps).onChange((v) => {
					this.s.collapseReviewedScraps = v;
					this.save(false);
				}));
			new Setting(el)
				.setName("Hide a reviewed daily note while its scraps aren't")
				.setDesc("When a day's note is reviewed but some of its scraps aren't, show only the scraps. A \"Show it\" link brings the note back.")
				.addToggle((t) => t.setValue(this.s.hideReviewedNote).onChange((v) => {
					this.s.hideReviewedNote = v;
					this.save(false);
				}));
		}
		const list = el.createDiv({ cls: "pnr-types" });
		this.s.extraFolders.forEach((f, i) => this.renderExtraFolder(list, f, i));
		new Setting(el).addButton((b) => b.setButtonText("Add extra folder").onClick(() => {
			const taken = new Set(this.s.extraFolders.map((f) => f.id));
			let n = this.s.extraFolders.length + 1;
			while (taken.has(`extra-${n}`)) n++;
			this.s.extraFolders.push({ ...DEFAULT_EXTRA_FOLDER, id: `extra-${n}` });
			this.save();
			this.display();
		}));
	}

	private renderExtraFolder(parent: HTMLElement, f: ExtraFolder, i: number) {
		const box = parent.createDiv({ cls: "pnr-type-box pnr-extra-box" });
		const setColor = () => box.style.setProperty("--pnr-color", f.color || "var(--color-yellow)");
		setColor();
		const folders = this.s.extraFolders;
		const preview = createDiv({ cls: "pnr-preview pnr-extra-preview" });
		const refresh = () => this.refreshExtraPreview(preview, f);
		const changed = (rebuild = true) => {
			this.save(rebuild);
			refresh();
		};

		const head = new Setting(box)
			.setName(extraLabel(f))
			.setClass("pnr-type-head")
			.addColorPicker((c) => c.setValue(f.color || "#e0b400").onChange((v) => {
				f.color = v;
				setColor();
				this.save(false);
			}))
			.addExtraButton((b) => b.setIcon("arrow-up").setTooltip("Move up").setDisabled(i === 0).onClick(() => {
				[folders[i - 1], folders[i]] = [folders[i], folders[i - 1]];
				this.save();
				this.display();
			}))
			.addExtraButton((b) => b.setIcon("arrow-down").setTooltip("Move down").setDisabled(i === folders.length - 1).onClick(() => {
				[folders[i + 1], folders[i]] = [folders[i], folders[i + 1]];
				this.save();
				this.display();
			}))
			.addExtraButton((b) => b.setIcon("trash-2").setTooltip("Remove").onClick(() => {
				folders.splice(i, 1);
				this.save();
				this.display();
			}))
			.addToggle((tg) => tg.setTooltip("Enabled").setValue(f.enabled).onChange((v) => {
				f.enabled = v;
				changed();
			}));
		const setTitle = () => head.nameEl.setText(extraLabel(f));

		new Setting(box)
			.setName("Folder")
			.setDesc("Start typing to search your folders. Leave empty for the whole vault.")
			.setClass("pnr-sub")
			.addText((t) => {
				t.setPlaceholder("Folder path").setValue(f.folder).onChange((v) => {
					f.folder = v.trim();
					setTitle();
					changed();
				});
				new FolderSuggest(this.app, t.inputEl, (path) => {
					f.folder = path;
					setTitle();
					changed();
				});
			});
		new Setting(box)
			.setName("Include subfolders")
			.setClass("pnr-sub")
			.addToggle((t) => t.setValue(f.subfolders).onChange((v) => {
				f.subfolders = v;
				changed();
			}));
		new Setting(box)
			.setName("Label")
			.setDesc("Shown on each scrap. Leave empty to use the folder's name.")
			.setClass("pnr-sub")
			.addText((t) => t.setPlaceholder(extraLabel({ ...f, label: "" })).setValue(f.label).onChange((v) => {
				f.label = v;
				setTitle();
				this.save(false);
			}));

		const fmt = new Setting(box).setName("Date format").setClass("pnr-sub");
		const fmtHint = fmt.descEl.createDiv();
		const showFormat = () => {
			fmtHint.empty();
			const format = f.dateFormat.trim();
			const today = moment();
			const line = fmtHint.createDiv();
			line.appendText("moment.js tokens, as in the title formats. A time can be part of it (HHmm reads 2008 as 20:08); it's shown on the scrap and left out of its name. Separate alternatives with |, such as ");
			line.createEl("code", { text: "YYYY-MM-DD HHmm | YYYY-MM-DD" });
			line.appendText(" for names with or without a time. Now: ");
			const formats = dateFormats(format);
			line.createEl("code", { text: formats.map((x) => today.format(x)).join(", ") || "(empty)" });
			const bad = formats.some((x) => {
				const back = moment(today.format(x), x, true);
				return !back.isValid() || !back.isSame(today, "day");
			});
			if (formats.length === 0 || bad) {
				fmtHint.createDiv({ cls: "pnr-format-warn", text: "This format doesn't read back as today. It needs a year, month and day, such as YYYY-MM-DD or YYYYMMDD." });
			}
		};
		fmt.addText((t) => t.setPlaceholder("YYYY-MM-DD").setValue(f.dateFormat).onChange((v) => {
			f.dateFormat = v;
			showFormat();
			changed();
		}));
		showFormat();

		const pat = new Setting(box).setName("File name pattern").setClass("pnr-sub pnr-pattern");
		pat.descEl.appendText("A regular expression for the whole file name (without .md), ignoring case. ");
		pat.descEl.createEl("code", { text: "{date}" });
		pat.descEl.appendText(" stands for the date; ");
		pat.descEl.createEl("code", { text: ".*" });
		pat.descEl.appendText(" after it ignores any extra text. Without {date}, the name must start with the date and the pattern is what may follow it.");
		const patWarn = pat.descEl.createDiv({ cls: "pnr-format-warn" });
		const showPatternError = () => {
			const c = compilePattern(f.pattern);
			patWarn.setText(c.error !== undefined ? `Not a valid pattern: ${c.error}` : "");
		};
		let patInput: HTMLInputElement | null = null;
		pat.addText((t) => {
			patInput = t.inputEl;
			t.setPlaceholder("{date}.*").setValue(f.pattern).onChange((v) => {
				f.pattern = v;
				showPatternError();
				changed();
			});
		});
		showPatternError();
		const hints = box.createEl("details", { cls: "pnr-pattern-hints" });
		hints.createEl("summary", { text: "Pattern examples" });
		const table = hints.createDiv({ cls: "pnr-hint-list" });
		for (const [p, what] of PATTERN_HINTS) {
			const row = table.createDiv({ cls: "pnr-hint-row" });
			const code = row.createEl("button", { cls: "pnr-hint-code", text: p, attr: { "aria-label": "Use this pattern" } });
			code.addEventListener("click", () => {
				f.pattern = p;
				if (patInput) patInput.value = p;
				showPatternError();
				changed();
			});
			row.createSpan({ cls: "pnr-hint-text", text: what });
		}
		hints.createDiv({
			cls: "pnr-hint-foot",
			text: "Handy pieces: .* any text, .+ at least one character, \\d a digit, (a|b) either, (x)? optional, \\. a literal dot. Click an example to use it.",
		});

		const field = new Setting(box).setName("Review field").setClass("pnr-sub");
		const daily = statusFieldFor("daily", this.s);
		field.setDesc(`A true/false frontmatter property. Leave empty to use the daily notes' field, "${daily}". Mark reviewed writes true; "${this.s.unreviewedValue}" means still to review.`);
		field.addText((t) => t.setPlaceholder(daily).setValue(f.statusField).onChange((v) => {
			f.statusField = v.trim();
			changed();
		}));
		new Setting(box)
			.setName("When the field is missing")
			.setDesc("\"Counts as reviewed\" keeps an old backlog out of the queue: only scraps with the field set to false show up.")
			.setClass("pnr-sub")
			.addDropdown((d) => d
				.addOptions({ unreviewed: "Counts as not reviewed", reviewed: "Counts as reviewed" })
				.setValue(f.missingStatus)
				.onChange((v) => {
					f.missingStatus = v as MissingStatus;
					changed();
				}));
		new Setting(box)
			.setName("Title")
			.setDesc("What a scrap is called on the page and in the queue. With the first H1, that heading isn't repeated in the note below it; notes without one use the file name.")
			.setClass("pnr-sub")
			.addDropdown((d) => d
				.addOptions({ filename: "File name, without the date", heading: "The note's first H1 heading" })
				.setValue(f.titleFrom)
				.onChange((v) => {
					f.titleFrom = v as "filename" | "heading";
					changed();
				}));
		new Setting(box)
			.setName("Type for items under no matching heading")
			.setDesc("Scraps often have no section headings. Their items can count as one of your item types instead of Other.")
			.setClass("pnr-sub")
			.addDropdown((d) => {
				d.addOption("", this.s.other.label);
				for (const t of this.s.itemTypes) if (t.enabled) d.addOption(t.id, t.label);
				d.setValue(f.defaultType).onChange((v) => {
					f.defaultType = v;
					this.save();
				});
			});

		box.appendChild(preview);
		refresh();
	}

	private extraTimers = new WeakMap<HTMLElement, number>();

	/** "9 of 12 notes in this folder match (4 to review). For example …" */
	private refreshExtraPreview(el: HTMLElement, f: ExtraFolder) {
		window.clearTimeout(this.extraTimers.get(el));
		this.extraTimers.set(el, window.setTimeout(() => {
			el.empty();
			if (!f.enabled) {
				el.setText("Turned off: these notes aren't shown.");
				return;
			}
			const st = this.plugin.store.extraFolderStats(f, this.s);
			if (st.error) {
				el.addClass("is-empty");
				el.setText("Fix the pattern to see which notes match.");
				return;
			}
			el.toggleClass("is-empty", st.matched === 0);
			const where = f.folder.trim() ? "this folder" : "the vault";
			if (st.files === 0) {
				el.setText(f.folder.trim() ? "No notes in this folder." : "No notes found.");
				return;
			}
			const head = el.createDiv();
			head.createSpan({ cls: "pnr-preview-label", text: `${st.matched} of ${st.files} ${st.files === 1 ? "note" : "notes"} in ${where} match` });
			head.appendText(st.matched > 0 ? ` (${st.toReview} to review).` : ".");
			for (const x of st.examples) {
				const line = el.createDiv();
				line.createEl("code", { text: x.name });
				line.appendText(` → ${moment(x.date, "YYYY-MM-DD").format("ddd D MMM YYYY")}${x.time ? `, ${x.time}` : ""}, shown as “${x.shown}”`);
			}
			if (st.misses.length > 0) {
				const line = el.createDiv({ cls: "pnr-preview-misses" });
				line.appendText("Don't match: ");
				st.misses.forEach((m, i) => {
					if (i > 0) line.appendText(", ");
					line.createEl("code", { text: m });
				});
			}
			// A name built from today's date, to show the pattern accepting it.
			const sample = moment().format(dateFormats(f.dateFormat)[0] ?? "YYYY-MM-DD");
			if (st.matched === 0 && !matchExtraName(sample, f.dateFormat, f.pattern)) {
				el.createDiv({ cls: "pnr-format-warn", text: `A name that is just today's date ("${sample}") doesn't match either.` });
			}
		}, 300));
	}
}
