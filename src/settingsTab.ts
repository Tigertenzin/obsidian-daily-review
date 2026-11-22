import { App, PluginSettingTab, setIcon, Setting } from "obsidian";
import { typeForHeading } from "./core/parse";
import {
	HighlightStyle, ItemType, Kind, KINDS, MatchMode, MissingStatus, OTHER_ID, UnknownMarks,
} from "./core/settings";
import type PeriodicNoteReviewPlugin from "./main";

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

export class ReviewSettingTab extends PluginSettingTab {
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

		// ------------------------------------------------------------ notes
		new Setting(el).setName("Notes").setHeading();
		new Setting(el)
			.setName("Notes folder")
			.setDesc("Periodic notes are found in this folder and its subfolders. Leave empty for the whole vault.")
			.addText((t) => t.setValue(this.s.folder).onChange((v) => {
				this.s.folder = v.trim();
				this.save();
			}));
		new Setting(el)
			.setName("Membership tag")
			.setDesc("Only notes with this tag (in frontmatter or the body) are included. Leave empty to include every note in the folder.")
			.addText((t) => t.setValue(this.s.membershipTag).onChange((v) => {
				this.s.membershipTag = v.trim();
				this.save();
			}));
		new Setting(el)
			.setName("Title only needs to start with the format")
			.setDesc("For example, a daily note titled \"2026-11-22 Sun - trip\" still counts.")
			.addToggle((t) => t.setValue(this.s.titlePrefixMatch).onChange((v) => {
				this.s.titlePrefixMatch = v;
				this.save();
			}));

		// ------------------------------------------------------------ kinds
		new Setting(el).setName("Note kinds").setHeading();
		el.createEl("p", {
			cls: "setting-item-description",
			text: "A note's kind comes from its tag (checked yearly, quarterly, monthly, weekly); a note with none of these tags is daily. Title formats use moment.js syntax.",
		});
		for (const k of KINDS) this.renderKind(el, k);

		// ------------------------------------------------------------ review state
		new Setting(el).setName("Review state").setHeading();
		new Setting(el)
			.setName("Status field")
			.setDesc("Frontmatter field that says whether a note has been reviewed.")
			.addText((t) => t.setValue(this.s.statusField).onChange((v) => {
				this.s.statusField = v.trim();
				this.save();
			}));
		new Setting(el)
			.setName("Unreviewed value")
			.setDesc("The value that means \"not reviewed yet\" (any case). Any other value counts as reviewed.")
			.addText((t) => t.setValue(this.s.unreviewedValue).onChange((v) => {
				this.s.unreviewedValue = v.trim();
				this.save();
			}));

		// ------------------------------------------------------------ item types
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

		// ------------------------------------------------------------ items
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

		// ------------------------------------------------------------ page
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
			}));
	}

	private renderKind(el: HTMLElement, k: Kind) {
		const ks = this.s.kinds[k];
		const box = el.createDiv({ cls: "pnr-kind" });
		new Setting(box)
			.setName(`${KIND_LABEL[k]} notes`)
			.setDesc(ks.enabled ? "Included in the review." : "Left out of the review.")
			.addToggle((t) => t.setValue(ks.enabled).onChange((v) => {
				ks.enabled = v;
				this.save();
				this.display();
			}));
		if (!ks.enabled) return;
		if (k !== "daily") {
			new Setting(box).setName("Tag").setClass("pnr-sub").addText((t) => t.setValue(ks.tag).onChange((v) => {
				ks.tag = v.trim();
				this.save();
			}));
		}
		new Setting(box).setName("Title format").setClass("pnr-sub").addText((t) => t.setValue(ks.titleFormat).onChange((v) => {
			ks.titleFormat = v;
			this.save();
		}));
		new Setting(box)
			.setName("Status field")
			.setDesc(ks.statusField ? "" : `Uses the shared field ("${this.s.statusField}").`)
			.setClass("pnr-sub")
			.addText((t) => t.setPlaceholder(this.s.statusField).setValue(ks.statusField).onChange((v) => {
				ks.statusField = v.trim();
				this.save();
			}));
		new Setting(box)
			.setName("Reviewed value")
			.setDesc("Leave empty to use the shared rule (anything but the unreviewed value counts as reviewed).")
			.setClass("pnr-sub")
			.addText((t) => t.setValue(ks.reviewedValue).onChange((v) => {
				ks.reviewedValue = v.trim();
				this.save();
			}));
		new Setting(box)
			.setName("When the status field is missing")
			.setClass("pnr-sub")
			.addDropdown((d) => d
				.addOptions({ reviewed: "Counts as reviewed", unreviewed: "Counts as not reviewed" })
				.setValue(ks.missingStatus)
				.onChange((v) => {
					ks.missingStatus = v as MissingStatus;
					this.save();
				}));
		new Setting(box)
			.setName("Can be marked reviewed from the review page")
			.setClass("pnr-sub")
			.addToggle((t) => t.setValue(ks.canMarkReviewed).onChange((v) => {
				ks.canMarkReviewed = v;
				this.save(false);
			}));
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
}
