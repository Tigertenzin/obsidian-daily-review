import { debounce, Notice, Plugin, setIcon, WorkspaceLeaf } from "obsidian";
import { isPast } from "./core/queue";
import { mergeSettings, Settings } from "./core/settings";
import { ReviewSettingTab } from "./settingsTab";
import { NoteStore } from "./store";
import { ReviewView, VIEW_TYPE } from "./view";

export default class PeriodicNoteReviewPlugin extends Plugin {
	settings!: Settings;
	store!: NoteStore;
	private statusEl: HTMLElement | null = null;
	private rebuildSoon = debounce(() => void this.store.rebuild(), 600, true);

	async onload() {
		this.settings = mergeSettings(await this.loadData());
		this.store = new NoteStore(this.app, () => this.settings);

		this.registerView(VIEW_TYPE, (leaf) => new ReviewView(leaf, this));
		this.registerHoverLinkSource(VIEW_TYPE, { display: "Periodic Note Review", defaultMod: true });
		this.addSettingTab(new ReviewSettingTab(this.app, this));
		this.addRibbonIcon("calendar-check", "Open daily review", () => void this.openView());

		this.addCommand({ id: "open", name: "Open daily review", callback: () => void this.openView() });
		this.addViewCommand("next-note", "Next note", (v) => v.step(1));
		this.addViewCommand("previous-note", "Previous note", (v) => v.step(-1));
		this.addViewCommand("mark-reviewed", "Mark current note reviewed", (v) => void v.markReviewed());
		this.addViewCommand("open-in-editor", "Open current note in editor", (v) => v.openInEditor(true));
		this.addCommand({
			id: "toggle-extra-layout",
			name: "Show extra notes below the daily note or as their own pages",
			callback: async () => {
				this.settings.extraLayout = this.settings.extraLayout === "below" ? "pages" : "below";
				await this.saveSettings(false);
				new Notice(this.settings.extraLayout === "below"
					? "Extra notes now show below their daily note."
					: "Extra notes now show as their own pages.");
			},
		});

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("pnr-status", "mod-clickable");
		this.statusEl.addEventListener("click", () => void this.openView());
		this.registerEvent(this.store.on("changed", () => this.updateStatusBar()));

		this.app.workspace.onLayoutReady(() => {
			void this.store.rebuild();
			// Index again once the metadata cache has finished reading every file.
			let first = true;
			this.registerEvent(this.app.metadataCache.on("resolved", () => {
				if (first) {
					first = false;
					void this.store.rebuild();
				}
			}));
			this.registerEvent(this.app.metadataCache.on("changed", (file, data) => void this.store.update(file, data)));
			this.registerEvent(this.app.vault.on("delete", (file) => this.store.remove(file.path)));
			this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.store.rename(file, oldPath)));
		});

		// Notice the date rolling over, so yesterday becomes reviewable without a reload.
		this.registerInterval(window.setInterval(() => this.store.checkDate(), 60_000));
	}

	onunload() {
		// Views are detached by Obsidian.
	}

	private addViewCommand(id: string, name: string, run: (v: ReviewView) => void) {
		this.addCommand({
			id,
			name,
			checkCallback: (checking) => {
				const view = this.activeView();
				if (!view) return false;
				if (!checking) run(view);
				return true;
			},
		});
	}

	private activeView(): ReviewView | null {
		const active = this.app.workspace.getActiveViewOfType(ReviewView);
		if (active) return active;
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
		return leaf?.view instanceof ReviewView ? leaf.view : null;
	}

	async openView() {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | undefined = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		workspace.setActiveLeaf(leaf, { focus: true });
	}

	private updateStatusBar() {
		if (!this.statusEl) return;
		const n = [...this.store.pages.values()].filter((e) => e.needsReview && isPast(e, this.store.today)).length;
		const show = this.settings.showStatusBar && this.store.ready && n > 0;
		this.statusEl.toggle(show);
		const style = this.settings.statusBarStyle;
		this.statusEl.empty();
		if (style !== "text") setIcon(this.statusEl.createSpan({ cls: "pnr-status-icon" }), "calendar-check");
		this.statusEl.createSpan({ text: style === "icon-number" ? `${n}` : `${n} to review` });
		this.statusEl.setAttr("aria-label", `${n} to review: open daily review`);
	}

	/** Save settings. With `rebuild`, re-read the notes (debounced while typing). */
	async saveSettings(rebuild = true) {
		await this.saveData(this.settings);
		this.store.invalidatePages();
		if (rebuild) this.rebuildSoon();
		else {
			this.updateStatusBar();
			this.store.trigger("changed", null);
		}
	}
}
