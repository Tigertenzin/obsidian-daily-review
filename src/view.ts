import {
	Component, ItemView, Keymap, MarkdownRenderer, moment, Notice, Scope, setIcon, TFile, WorkspaceLeaf,
} from "obsidian";
import {
	analyzeNote, domainLabel, firstLinkDomain, Item, NoteAnalysis, typeForHeading, withMark,
} from "./core/parse";
import { daysAgo } from "./core/periods";
import {
	FILTERS, FilterId, groupLabel, isPast, longAge, mastheadFor, matchesFilter, matchesTypeFilter, NoteEntry,
	openByType, rangeLabel, TypeFilterState,
	shortAge, sortEntries, ticksFor, weekNumber,
} from "./core/queue";
import { reviewedValueFor, statusFieldFor, unreviewedValueFor, withFrontmatterValue } from "./core/review";
import { Kind, OTHER_ID, SortMode } from "./core/settings";
import type PeriodicNoteReviewPlugin from "./main";

export const VIEW_TYPE = "periodic-note-review";

const NARROW_WIDTH = 900;
/** How long "Mark reviewed" waits for the second click or Enter. */
const CONFIRM_MS = 4000;
/** How long the Undo bar stays after marking a note reviewed. */
const UNDO_MS = 6000;
const MAX_TICKS = 9;
const SORTS: { id: SortMode; label: string }[] = [
	{ id: "oldest", label: "Oldest first" },
	{ id: "newest", label: "Newest first" },
	{ id: "most-open", label: "Most open items" },
	{ id: "most-tasks", label: "Most tasks" },
];

interface TasksApi {
	executeToggleTaskDoneCommand(line: string, path: string): string;
}

export class ReviewView extends ItemView {
	private currentPath: string | null = null;
	private filter: FilterId = "all";
	private typeFilter = new Map<string, TypeFilterState>();
	private queueOpen = false;
	private busy = false;
	/** "Mark reviewed" has been pressed once and is waiting for confirmation. */
	private armed: { path: string; until: number; timer: number } | null = null;
	/** The last "Mark reviewed", while it can still be undone. */
	private undo: {
		path: string; label: string; kind: Kind; field: string; before: string; after: string;
		until: number; timer: number;
	} | null = null;
	private actionsEl!: HTMLElement;

	private topEl!: HTMLElement;
	private mainEl!: HTMLElement;
	private sheetEl!: HTMLElement;
	private queueEl!: HTMLElement;

	private noteComponent: Component | null = null;
	private renderToken = 0;
	private analysis: NoteAnalysis | null = null;
	/** Rendered checkbox list items, matched by order to analysis.renderedItems. */
	private itemEls: HTMLElement[] = [];
	private itemsMatched = false;

	constructor(leaf: WorkspaceLeaf, private plugin: PeriodicNoteReviewPlugin) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
		this.registerKeys(this.scope);
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return "Periodic Note Review";
	}
	getIcon() {
		return "calendar-check";
	}

	private get store() {
		return this.plugin.store;
	}
	private get settings() {
		return this.plugin.settings;
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("pnr-view");
		root.setAttr("tabindex", "-1");
		this.topEl = root.createDiv({ cls: "pnr-top" });
		const body = root.createDiv({ cls: "pnr-body" });
		this.mainEl = body.createDiv({ cls: "pnr-main" });
		this.sheetEl = this.mainEl.createDiv({ cls: "pnr-sheet-wrap" });
		this.actionsEl = this.mainEl.createDiv({ cls: "pnr-actions-host", attr: { "aria-live": "polite" } });
		this.queueEl = body.createDiv({ cls: "pnr-queue" });

		const ro = new ResizeObserver(() => this.updateWidthClass());
		ro.observe(root);
		this.register(() => ro.disconnect());
		this.updateWidthClass();

		this.registerSwipe(this.mainEl);
		this.registerEvent(this.store.on("changed", (path: string | null) => this.onStoreChanged(path)));

		if (this.store.ready) this.pickStartNote();
		this.renderAll();
	}

	async onClose() {
		if (this.armed) window.clearTimeout(this.armed.timer);
		if (this.undo) window.clearTimeout(this.undo.timer);
		this.noteComponent = null;
	}

	// ---------------------------------------------------------------- data

	/** Notes listed in the queue: still to review (plus reviewed ones if shown). */
	private listed(): NoteEntry[] {
		return [...this.store.entries.values()].filter((e) => e.needsReview || this.settings.showReviewed);
	}

	/** The queue in its current filter and sort. */
	private visible(): NoteEntry[] {
		const today = this.store.today;
		return sortEntries(
			this.listed().filter((e) => matchesFilter(e, this.filter, today) && matchesTypeFilter(e, this.typeFilter)),
			this.settings.sort,
		);
	}

	private toReview(): NoteEntry[] {
		return [...this.store.entries.values()].filter((e) => e.needsReview && isPast(e, this.store.today));
	}

	private current(): NoteEntry | null {
		return this.currentPath ? this.store.entries.get(this.currentPath) ?? null : null;
	}

	private pickStartNote() {
		const first = this.visible().find((e) => e.needsReview && isPast(e, this.store.today));
		this.currentPath = first?.path ?? null;
	}

	private onStoreChanged(path: string | null) {
		if (!this.topEl) return;
		if (path === null) {
			if (!this.current()) this.pickStartNote();
			this.renderAll();
			return;
		}
		const cur = this.current();
		if (path === this.currentPath) {
			if (!cur) {
				// Deleted, or no longer a periodic note: move on.
				this.goToNextAfter(null);
				return;
			}
			if (!cur.needsReview && !this.settings.showReviewed && !this.busy) {
				// Marked reviewed somewhere else.
				this.goToNextAfter(cur);
				return;
			}
			this.renderTop();
			this.renderQueue();
			void this.renderNote(true);
			return;
		}
		if (!cur && this.currentPath === null && this.store.ready) this.pickStartNote();
		this.renderTop();
		this.renderQueue();
		if (!this.currentPath) void this.renderNote(false);
	}

	// ---------------------------------------------------------------- layout

	private updateWidthClass() {
		const narrow = this.contentEl.clientWidth > 0 && this.contentEl.clientWidth < NARROW_WIDTH;
		this.contentEl.toggleClass("is-narrow", narrow);
		if (!narrow) this.setQueueOpen(false);
	}

	private setQueueOpen(open: boolean) {
		this.queueOpen = open;
		this.contentEl.toggleClass("is-queue-open", open);
		if (open) window.requestAnimationFrame(() => this.revealCurrentRow());
	}

	private queueVisible(): boolean {
		return !this.contentEl.hasClass("is-narrow") || this.queueOpen;
	}

	/**
	 * Scroll the queue list (and nothing else) so the current row is in view.
	 * Element.scrollIntoView would also scroll every ancestor, including sideways
	 * toward the off-screen drawer on narrow panes.
	 */
	private revealCurrentRow() {
		if (!this.queueVisible()) return;
		const list = this.queueEl.querySelector<HTMLElement>(".pnr-queue-list");
		const row = list?.querySelector<HTMLElement>(".pnr-row.is-current");
		if (!list || !row) return;
		const top = row.offsetTop;
		const bottom = top + row.offsetHeight;
		const pad = 40;
		if (top - pad < list.scrollTop) list.scrollTop = Math.max(0, top - pad);
		else if (bottom + pad > list.scrollTop + list.clientHeight) list.scrollTop = bottom + pad - list.clientHeight;
	}

	/** Undo any sideways scroll an ancestor may have picked up. */
	private resetSideways() {
		for (let el: HTMLElement | null = this.mainEl; el && el !== document.body; el = el.parentElement) {
			if (el.scrollLeft !== 0) el.scrollLeft = 0;
		}
	}

	private renderAll() {
		this.renderTop();
		this.renderQueue();
		void this.renderNote(false);
	}

	private colorFor(typeId: string): string {
		if (typeId === OTHER_ID) return this.settings.other.color || "var(--text-muted)";
		const t = this.settings.itemTypes.find((x) => x.id === typeId);
		return t?.color || "var(--interactive-accent)";
	}

	private labelFor(typeId: string): string {
		if (typeId === OTHER_ID) return this.settings.other.label;
		return this.settings.itemTypes.find((x) => x.id === typeId)?.label ?? typeId;
	}

	private typeOrder(): string[] {
		return [...this.settings.itemTypes.map((t) => t.id), OTHER_ID];
	}

	// ---------------------------------------------------------------- top bar

	private renderTop() {
		const el = this.topEl;
		el.empty();
		const n = this.toReview().length;
		const today = this.store.today;

		const tally = el.createDiv({ cls: "pnr-tally" });
		tally.createSpan({ cls: "pnr-tally-count", text: `${n} to review` });
		this.renderTypePills(tally);

		const controls = el.createDiv({ cls: "pnr-controls" });
		const chips = controls.createDiv({ cls: "pnr-chips" });
		const listed = this.listed().filter((e) => matchesTypeFilter(e, this.typeFilter));
		for (const f of FILTERS) {
			if (f.id !== "all" && !this.settings.kinds[f.id as Kind]?.enabled && this.filter !== f.id) continue;
			const count = listed.filter((e) => matchesFilter(e, f.id, today)).length;
			if (count === 0 && this.filter !== f.id) continue;
			const chip = chips.createEl("button", { cls: "pnr-chip" });
			chip.toggleClass("is-active", this.filter === f.id);
			chip.createSpan({ text: f.label });
			chip.createSpan({ cls: "pnr-chip-count", text: String(count) });
			chip.addEventListener("click", () => {
				this.filter = f.id;
				this.afterFilterChange();
			});
		}

		const right = controls.createDiv({ cls: "pnr-controls-right" });
		const sort = right.createEl("select", { cls: "dropdown pnr-sort" });
		for (const s of SORTS) {
			const o = sort.createEl("option", { text: s.label, value: s.id });
			if (s.id === this.settings.sort) o.selected = true;
		}
		sort.addEventListener("change", async () => {
			this.settings.sort = sort.value as SortMode;
			await this.plugin.saveSettings(false);
		});

		const qBtn = right.createEl("button", { cls: "pnr-queue-toggle", attr: { "aria-label": "Show queue" } });
		setIcon(qBtn.createSpan(), "list");
		qBtn.createSpan({ text: `Queue ${this.visible().length}` });
		qBtn.addEventListener("click", () => this.setQueueOpen(!this.queueOpen));
	}

	/** One pill per item type with open items: a coloured dot and the count left. */
	private renderTypePills(parent: HTMLElement) {
		const today = this.store.today;
		const pool = this.listed().filter((e) => e.needsReview && matchesFilter(e, this.filter, today));
		const totals = openByType(pool);
		const pills = parent.createDiv({ cls: "pnr-type-pills" });
		for (const id of this.typeOrder()) {
			if (id === OTHER_ID && this.settings.other.hidden) continue;
			const state = this.typeFilter.get(id);
			const count = totals[id] ?? 0;
			if (count === 0 && !state) continue;
			const label = this.labelFor(id);
			const pill = pills.createEl("button", { cls: "pnr-type-pill" });
			pill.style.setProperty("--pnr-color", this.colorFor(id));
			if (state) pill.addClass(`is-${state}`);
			pill.createSpan({ cls: "pnr-type-dot" });
			pill.createSpan({ cls: "pnr-type-pill-label", text: label });
			pill.createSpan({ cls: "pnr-type-pill-count", text: String(count) });
			pill.setAttr("aria-label",
				state === "include" ? `Showing only notes with ${label} open. Click to hide notes with only ${label} left.`
				: state === "exclude" ? `Hiding notes with only ${label} left. Click to show everything.`
				: `${count} ${label} open. Click to show only notes with ${label} open.`);
			pill.setAttr("aria-pressed", state ? "true" : "false");
			pill.addEventListener("click", () => {
				if (!state) this.typeFilter.set(id, "include");
				else if (state === "include") this.typeFilter.set(id, "exclude");
				else this.typeFilter.delete(id);
				this.afterFilterChange();
			});
		}
	}

	/** Keep the current note if it's still listed; otherwise go to the first one to review. */
	private afterFilterChange() {
		const vis = this.visible();
		if (!vis.some((e) => e.path === this.currentPath)) {
			this.currentPath = (vis.find((e) => e.needsReview && isPast(e, this.store.today)) ?? vis[0])?.path ?? null;
		}
		this.renderAll();
	}

	// ---------------------------------------------------------------- queue

	private renderQueue() {
		const el = this.queueEl;
		const prevScroll = el.querySelector(".pnr-queue-list")?.scrollTop ?? 0;
		el.empty();

		const head = el.createDiv({ cls: "pnr-queue-head" });
		head.createSpan({ cls: "pnr-queue-title", text: "Queue" });
		const label = head.createEl("label", { cls: "pnr-show-reviewed" });
		const cb = label.createEl("input", { type: "checkbox" });
		cb.checked = this.settings.showReviewed;
		label.appendText("Show reviewed");
		cb.addEventListener("change", async () => {
			this.settings.showReviewed = cb.checked;
			await this.plugin.saveSettings(false);
		});
		const close = head.createEl("button", { cls: "pnr-queue-close clickable-icon", attr: { "aria-label": "Close queue" } });
		setIcon(close, "x");
		close.addEventListener("click", () => this.setQueueOpen(false));

		const list = el.createDiv({ cls: "pnr-queue-list" });
		const vis = this.visible();
		const today = this.store.today;
		const dateSort = this.settings.sort === "oldest" || this.settings.sort === "newest";
		let lastGroup = "";
		let lastPast: boolean | null = null;

		if (vis.length === 0) list.createDiv({ cls: "pnr-queue-empty", text: "Nothing here." });

		for (const e of vis) {
			const past = isPast(e, today);
			if (dateSort) {
				if (lastPast !== null && past !== lastPast) list.createDiv({ cls: "pnr-today-divider", text: "today" });
				lastPast = past;
				const g = groupLabel(e);
				if (g !== lastGroup) {
					list.createDiv({ cls: "pnr-group", text: g });
					lastGroup = g;
				}
			}
			this.renderRow(list, e, today);
		}

		list.scrollTop = prevScroll;
		window.requestAnimationFrame(() => this.revealCurrentRow());
	}

	private renderRow(list: HTMLElement, e: NoteEntry, today: string): HTMLElement {
		const row = list.createDiv({ cls: "pnr-row" });
		row.setAttr("role", "button");
		row.setAttr("tabindex", "0");
		row.toggleClass("is-current", e.path === this.currentPath);
		row.toggleClass("is-reviewed", !e.needsReview);
		row.toggleClass("is-band", e.kind !== "daily");
		const d = daysAgo(e.anchor, today);
		row.addClass(d <= 0 ? "age-progress" : d < 7 ? "age-recent" : "age-old");

		const date = row.createDiv({ cls: "pnr-row-date" });
		const s = moment(e.start, "YYYY-MM-DD");
		switch (e.kind) {
			case "daily":
				date.createSpan({ cls: "pnr-row-day", text: s.format("D") });
				date.createSpan({ cls: "pnr-row-sub", text: s.format("ddd") });
				break;
			case "weekly":
				date.createSpan({ cls: "pnr-row-label", text: `Week ${weekNumber(e, this.settings.kinds.weekly.titleFormat)}` });
				date.createSpan({ cls: "pnr-row-sub", text: rangeLabel(e.start, e.end) });
				break;
			case "monthly":
				date.createSpan({ cls: "pnr-row-label", text: s.format("MMMM") });
				date.createSpan({ cls: "pnr-row-sub", text: "month note" });
				break;
			case "quarterly":
				date.createSpan({ cls: "pnr-row-label", text: `Q${s.quarter()}` });
				date.createSpan({ cls: "pnr-row-sub", text: "quarter note" });
				break;
			case "yearly":
				date.createSpan({ cls: "pnr-row-label", text: s.format("YYYY") });
				date.createSpan({ cls: "pnr-row-sub", text: "year note" });
				break;
		}

		const ticks = row.createDiv({ cls: "pnr-ticks" });
		const all = ticksFor(e, this.settings);
		if (!e.needsReview) {
			ticks.createSpan({ cls: "pnr-row-clear", text: "reviewed" });
		} else if (all.length === 0) {
			ticks.createSpan({ cls: "pnr-row-clear", text: "clear" });
		} else {
			for (const t of all.slice(0, MAX_TICKS)) {
				const tick = ticks.createSpan({ cls: t.task ? "pnr-tick is-task" : "pnr-tick" });
				tick.style.setProperty("--pnr-color", this.colorFor(t.typeId));
			}
			if (all.length > MAX_TICKS) ticks.createSpan({ cls: "pnr-tick-more", text: `+${all.length - MAX_TICKS}` });
			row.setAttr("aria-label", this.countSummary(e));
		}

		row.createDiv({ cls: "pnr-row-age", text: shortAge(e, today) });
		const go = () => {
			this.goTo(e.path);
			if (this.contentEl.hasClass("is-narrow")) this.setQueueOpen(false);
		};
		row.addEventListener("click", go);
		row.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				evt.stopPropagation();
				go();
			}
		});
		return row;
	}

	private countSummary(e: NoteEntry): string {
		return this.typeOrder()
			.filter((id) => e.counts[id])
			.map((id) => `${e.counts[id].open + e.counts[id].tasks} ${this.labelFor(id)}`)
			.join(", ");
	}

	// ---------------------------------------------------------------- navigation

	goTo(path: string | null) {
		if (this.armed && this.armed.path !== path) this.disarm(false);
		this.currentPath = path;
		this.mainEl.scrollTop = 0;
		this.resetSideways();
		// Take focus back from whichever button was clicked, so Enter means "mark reviewed".
		if (this.contentEl.contains(document.activeElement) || document.activeElement === document.body) {
			this.contentEl.focus({ preventScroll: true });
		}
		this.renderTop();
		this.renderQueue();
		void this.renderNote(false);
	}

	step(delta: number) {
		const vis = this.visible();
		if (vis.length === 0) return;
		const i = vis.findIndex((e) => e.path === this.currentPath);
		let next: number;
		if (i === -1) next = delta > 0 ? 0 : vis.length - 1;
		else next = i + delta;
		if (next < 0 || next >= vis.length) return;
		this.goTo(vis[next].path);
	}

	/**
	 * After the current note leaves the queue: go to the note that now holds its position
	 * if that's a past note still to review, else the next one after it, else the empty
	 * state. Never moves on to an in-progress note.
	 */
	private goToNextAfter(prev: NoteEntry | null, prevIndex?: number) {
		const vis = this.visible();
		const today = this.store.today;
		let from = prevIndex ?? 0;
		if (prev && prevIndex === undefined) {
			const i = vis.findIndex((e) => e.path === prev.path);
			if (i !== -1) from = i + 1;
		}
		const candidates = [...vis.slice(from), ...vis.slice(0, from)];
		const next = candidates.find((e) => e.needsReview && isPast(e, today) && e.path !== prev?.path);
		this.goTo(next?.path ?? null);
	}

	openInEditor(newTab = true) {
		const file = this.currentFile();
		if (!file) return;
		void this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
	}

	private currentFile(): TFile | null {
		if (!this.currentPath) return null;
		const f = this.app.vault.getAbstractFileByPath(this.currentPath);
		return f instanceof TFile ? f : null;
	}

	// ---------------------------------------------------------------- the note

	private async renderNote(keepScroll: boolean) {
		const token = ++this.renderToken;
		const e = this.current();
		const file = this.currentFile();
		if (!e || !file) {
			this.renderEmpty();
			return;
		}
		const raw = await this.app.vault.cachedRead(file);
		if (token !== this.renderToken) return;
		const a = analyzeNote(raw, file.basename, this.settings);

		const sheet = createDiv({ cls: "pnr-sheet" });
		const cssclasses = this.app.metadataCache.getFileCache(file)?.frontmatter?.cssclasses;
		const extra = Array.isArray(cssclasses) ? cssclasses : typeof cssclasses === "string" ? cssclasses.split(/[\s,]+/) : [];
		for (const c of extra) if (typeof c === "string" && c) sheet.addClass(c);

		this.renderMasthead(sheet, e);
		this.renderSummary(sheet, a);

		const noteEl = sheet.createDiv({ cls: "pnr-note markdown-rendered markdown-preview-view" });
		const component = new Component();
		component.load();
		await MarkdownRenderer.render(this.app, a.renderText, noteEl, file.path, component);
		if (token !== this.renderToken) {
			component.unload();
			return;
		}

		const scroll = this.mainEl.scrollTop;
		if (this.noteComponent) this.removeChild(this.noteComponent);
		this.noteComponent = component;
		this.addChild(component);
		this.analysis = a;
		this.sheetEl.empty();
		this.sheetEl.appendChild(sheet);
		this.renderActions();
		this.decorate(noteEl, a, file);
		if (keepScroll) this.mainEl.scrollTop = scroll;
		for (const s of ["tint", "bar", "checkbox", "none"]) {
			this.contentEl.toggleClass("pnr-highlight-" + s, s === this.settings.highlightStyle);
		}
	}

	private renderMasthead(sheet: HTMLElement, e: NoteEntry) {
		const m = mastheadFor(e, this.settings);
		const head = sheet.createDiv({ cls: "pnr-masthead" });
		head.createDiv({ cls: "pnr-kicker", text: m.kicker });
		head.createDiv({ cls: "pnr-headline", text: m.headline });
		const meta = head.createDiv({ cls: "pnr-meta" });
		meta.createSpan({ text: longAge(e, this.store.today) });
		const vis = this.visible();
		const i = vis.findIndex((x) => x.path === e.path);
		if (i !== -1) meta.createSpan({ text: `${i + 1} / ${vis.length}` });
		if (!e.needsReview) meta.createSpan({ cls: "pnr-reviewed-pill", text: "Reviewed" });
		else if (!isPast(e, this.store.today)) meta.createSpan({ cls: "pnr-progress-pill", text: "In progress" });
	}

	private renderSummary(sheet: HTMLElement, a: NoteAnalysis) {
		const sum = sheet.createDiv({ cls: "pnr-summary" });
		if (a.open === 0) {
			sum.createSpan({ cls: "pnr-summary-clear", text: "Nothing left open. Safe to mark reviewed." });
			if (a.settled > 0) sum.createSpan({ cls: "pnr-summary-meta", text: `${a.settled} settled` });
			return;
		}
		for (const id of this.typeOrder()) {
			const c = a.counts[id];
			if (!c) continue;
			const chip = sum.createEl("button", { cls: "pnr-type-chip" });
			chip.style.setProperty("--pnr-color", this.colorFor(id));
			chip.createSpan({ cls: "pnr-type-dot" });
			chip.createSpan({ text: `${c.open + c.tasks} ${this.labelFor(id)}` });
			if (c.tasks > 0) chip.setAttr("aria-label", `${c.tasks} tagged ${this.settings.taskTag}`);
			chip.addEventListener("click", () => this.scrollToFirst(id));
		}
		const parts = [`${a.open} open`];
		if (a.tasks) parts.push(`${a.tasks} ${a.tasks === 1 ? "task" : "tasks"}`);
		if (a.settled) parts.push(`${a.settled} settled`);
		sum.createSpan({ cls: "pnr-summary-meta", text: parts.join(" · ") });
	}

	/**
	 * The bar under the note: the Undo strip (while the last "Mark reviewed" can be undone),
	 * then the buttons. While "Mark reviewed" waits for confirmation, a tint across the
	 * button bar drains right to left; it's cancelled when the tint runs out.
	 */
	private renderActions() {
		const host = this.actionsEl;
		host.empty();
		const e = this.current();
		const now = Date.now();

		if (this.undo) {
			const u = this.undo;
			const btn = host.createEl("button", {
				cls: "pnr-btn pnr-undo-btn pnr-has-timer",
				attr: { "aria-label": `Undo: mark ${u.label} unreviewed (u)` },
			});
			this.addTimer(btn, UNDO_MS, u.until - now);
			setIcon(btn.createSpan(), "undo-2");
			btn.createSpan({ text: "Undo" });
			btn.addEventListener("click", () => void this.undoLast());
		}
		if (!e) return;

		const bar = host.createDiv({ cls: "pnr-actions" });
		const armed = this.armed?.path === e.path ? this.armed : null;

		const prev = bar.createEl("button", { cls: "pnr-btn pnr-prev", attr: { "aria-label": "Previous note (←)" } });
		setIcon(prev, "chevron-left");
		prev.addEventListener("click", () => this.step(-1));

		const open = bar.createEl("button", { cls: "pnr-btn pnr-open" });
		setIcon(open.createSpan(), "file-text");
		open.createSpan({ text: "Open note" });
		open.setAttr("aria-label", "Open in the editor (o)");
		open.addEventListener("click", () => this.openInEditor(true));

		const ks = this.settings.kinds[e.kind];
		const mark = bar.createEl("button", { cls: "pnr-btn pnr-mark" });
		if (!e.needsReview) {
			setIcon(mark.createSpan(), "rotate-ccw");
			mark.createSpan({ text: "Mark unreviewed" });
		} else if (armed) {
			mark.addClass("is-armed", "pnr-has-timer");
			this.addTimer(mark, CONFIRM_MS, armed.until - now);
			setIcon(mark.createSpan(), "check-check");
			mark.createSpan({ text: e.open > 0 ? `Confirm · ${e.open} still open` : "Confirm reviewed" });
			mark.setAttr("aria-label", "Click or press Enter again to mark reviewed. Esc cancels.");
		} else {
			mark.addClass("mod-cta");
			setIcon(mark.createSpan(), "check");
			mark.createSpan({ text: "Mark reviewed" });
			mark.setAttr("aria-label", "Mark reviewed (Enter)");
		}
		if (!ks.canMarkReviewed) {
			mark.disabled = true;
			mark.setAttr("aria-label", `Set "${statusFieldFor(e.kind, this.settings)}" in the note to change its review state`);
		}
		mark.addEventListener("click", () => (e.needsReview ? this.markReviewed() : this.markUnreviewed()));

		const next = bar.createEl("button", { cls: "pnr-btn pnr-next", attr: { "aria-label": "Next note (→)" } });
		setIcon(next, "chevron-right");
		next.addEventListener("click", () => this.step(1));
	}

	/** A tint behind `el` that drains right to left over `total` ms, `left` ms of it remaining. */
	private addTimer(el: HTMLElement, total: number, left: number) {
		const t = el.createDiv({ cls: "pnr-timer" });
		t.style.animationDuration = `${total}ms`;
		t.style.animationDelay = `-${Math.max(0, total - left)}ms`;
	}

	private arm(path: string) {
		this.disarm(false);
		const timer = window.setTimeout(() => this.disarm(), CONFIRM_MS);
		this.armed = { path, until: Date.now() + CONFIRM_MS, timer };
		this.renderActions();
	}

	private disarm(render = true) {
		if (!this.armed) return;
		window.clearTimeout(this.armed.timer);
		this.armed = null;
		if (render) this.renderActions();
	}

	private clearUndo(render = true) {
		if (!this.undo) return;
		window.clearTimeout(this.undo.timer);
		this.undo = null;
		if (render) this.renderActions();
	}

	/** Put the note back the way it was before the last "Mark reviewed", and go back to it. */
	async undoLast() {
		const u = this.undo;
		if (!u) return;
		this.clearUndo(false);
		const f = this.app.vault.getAbstractFileByPath(u.path);
		if (!(f instanceof TFile)) {
			this.renderActions();
			return;
		}
		try {
			await this.app.vault.process(f, (data) =>
				// Unchanged since: restore it exactly. Edited since: just set the field back.
				data === u.after ? u.before : withFrontmatterValue(data, u.field, unreviewedValueFor(u.kind, this.settings)));
		} catch (err) {
			console.error("Periodic Note Review: couldn't undo", err);
			new Notice("Couldn't undo. See the console for details.");
			return;
		}
		this.store.setNeedsReview(u.path, true);
		this.goTo(u.path);
	}

	private renderEmpty() {
		this.analysis = null;
		this.itemEls = [];
		if (this.noteComponent) this.removeChild(this.noteComponent);
		this.noteComponent = null;
		const el = this.sheetEl;
		el.empty();
		this.renderActions();
		const box = el.createDiv({ cls: "pnr-sheet pnr-empty" });
		if (!this.store.ready) {
			box.createDiv({ cls: "pnr-empty-title", text: "Reading your notes…" });
			return;
		}
		const today = this.store.today;
		const pastInFilter = this.visible().filter((e) => e.needsReview && isPast(e, today));
		const pastAll = this.toReview();
		if (pastAll.length === 0) {
			box.createDiv({ cls: "pnr-empty-title", text: "Desk clear" });
			box.createDiv({ text: "Every past note is reviewed." });
		} else if (pastInFilter.length === 0) {
			box.createDiv({ cls: "pnr-empty-title", text: "Nothing to review with these filters" });
			box.createDiv({ text: `${pastAll.length} to review in total.` });
			const clear = box.createDiv().createEl("button", { text: "Clear filters" });
			clear.addEventListener("click", () => {
				this.filter = "all";
				this.typeFilter.clear();
				this.afterFilterChange();
			});
		} else {
			box.createDiv({ cls: "pnr-empty-title", text: "Pick a note from the queue" });
		}
		const inProgress = [...this.store.entries.values()].filter((e) => e.needsReview && !isPast(e, today)).length;
		if (inProgress > 0) {
			box.createDiv({
				cls: "pnr-empty-meta",
				text: `${inProgress} ${inProgress === 1 ? "note is" : "notes are"} still in progress. You can open them from the queue.`,
			});
		}
	}

	// ---------------------------------------------------------------- decorating the rendered note

	private decorate(noteEl: HTMLElement, a: NoteAnalysis, file: TFile) {
		const outsideEmbeds = (el: Element) => !el.parentElement?.closest(".internal-embed, .markdown-embed");
		const lis = Array.from(noteEl.querySelectorAll<HTMLElement>("li.task-list-item")).filter(outsideEmbeds);
		this.itemEls = lis;
		this.itemsMatched = lis.length === a.renderedItems.length;
		if (!this.itemsMatched) {
			console.warn(
				`Periodic Note Review: ${file.path}: ${lis.length} rendered checkboxes, ${a.renderedItems.length} parsed. ` +
				"Highlighting and checking off are turned off for this note.",
			);
			noteEl.parentElement?.querySelector(".pnr-summary")?.createDiv({
				cls: "pnr-summary-warn",
				text: "Couldn't match this page's checkboxes to the note. Open the note to change them.",
			});
		} else {
			a.renderedItems.forEach((item, i) => this.decorateItem(lis[i], item));
		}

		// Label section headings with their item type
		const level = this.settings.sectionLevel;
		for (const h of Array.from(noteEl.querySelectorAll<HTMLElement>(`h${level}`)).filter(outsideEmbeds)) {
			const id = typeForHeading(h.textContent ?? "", this.settings);
			if (id === OTHER_ID) continue;
			h.addClass("pnr-section");
			h.style.setProperty("--pnr-color", this.colorFor(id));
			h.createSpan({ cls: "pnr-section-label", text: this.labelFor(id) });
		}

		// Clicks: checkboxes (captured before any other handler) and internal links
		noteEl.addEventListener("click", (evt) => this.onNoteClick(evt, file), { capture: true });
		noteEl.addEventListener("mouseover", (evt) => {
			const link = (evt.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
			if (!link) return;
			this.app.workspace.trigger("hover-link", {
				event: evt, source: VIEW_TYPE, hoverParent: this, targetEl: link,
				linktext: link.getAttr("data-href") ?? link.getAttr("href") ?? "", sourcePath: file.path,
			});
		});
	}

	private decorateItem(li: HTMLElement, item: Item) {
		const counted = !(item.typeId === OTHER_ID && this.settings.other.hidden);
		li.addClass("pnr-item", `pnr-${item.state}`);
		li.dataset.pnrType = item.typeId;
		li.style.setProperty("--pnr-color", this.colorFor(item.typeId));
		if (item.isTask) li.addClass("pnr-task");
		if (!this.settings.allowCheckingItems) li.addClass("pnr-readonly");
		if (item.state !== "open" || !counted) return;
		li.addClass("pnr-highlight");

		// Wrap the item's own line (everything before a nested list) so the highlight
		// covers just that line, not its children.
		const line = createDiv({ cls: "pnr-line" });
		const first = Array.from(li.childNodes).find(
			(n) => n instanceof HTMLElement && (n.tagName === "UL" || n.tagName === "OL"),
		);
		while (li.firstChild && li.firstChild !== first) line.appendChild(li.firstChild);
		li.insertBefore(line, first ?? null);

		const t = this.settings.itemTypes.find((x) => x.id === item.typeId);
		if (t && Object.keys(t.domainLabels).length > 0) {
			const domain = firstLinkDomain(item.text);
			if (domain) {
				const label = domainLabel(domain, t.domainLabels) ?? domain;
				line.createSpan({ cls: "pnr-domain", text: label });
			}
		}
	}

	private onNoteClick(evt: MouseEvent, file: TFile) {
		const target = evt.target as HTMLElement;
		const checkbox = target.closest<HTMLInputElement>("input.task-list-item-checkbox, input[type=checkbox]");
		if (checkbox) {
			evt.preventDefault();
			evt.stopPropagation();
			evt.stopImmediatePropagation();
			const li = checkbox.closest<HTMLElement>("li.task-list-item");
			const idx = li ? this.itemEls.indexOf(li) : -1;
			if (!this.settings.allowCheckingItems) return;
			if (!this.itemsMatched || idx === -1 || !this.analysis) {
				new Notice("Open the note to change this item.");
				return;
			}
			void this.toggleItem(file, this.analysis.renderedItems[idx], li!);
			return;
		}
		const link = target.closest<HTMLAnchorElement>("a.internal-link");
		if (link) {
			evt.preventDefault();
			evt.stopPropagation();
			const href = link.getAttr("data-href") ?? link.getAttr("href") ?? "";
			void this.app.workspace.openLinkText(href, file.path, Keymap.isModEvent(evt));
			return;
		}
		const tag = target.closest<HTMLAnchorElement>("a.tag");
		if (tag) evt.preventDefault();
	}

	private tasksApi(): TasksApi | null {
		if (!this.settings.useTasksPlugin) return null;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const plugins = (this.app as any).plugins;
		const tasks = plugins?.enabledPlugins?.has("obsidian-tasks-plugin") ? plugins.plugins["obsidian-tasks-plugin"] : null;
		const api = tasks?.apiV1;
		return api && typeof api.executeToggleTaskDoneCommand === "function" ? api : null;
	}

	/** Check or uncheck one item in the file, after making sure its line hasn't changed. */
	private async toggleItem(file: TFile, item: Item, li: HTMLElement) {
		const api = item.isTask ? this.tasksApi() : null;
		const newMark = item.state === "open" ? "x" : " ";
		let stale = false;
		try {
			await this.app.vault.process(file, (data) => {
				const parts = data.split(/(\r?\n)/);
				const idx = item.line * 2;
				if (parts[idx] !== item.raw) {
					stale = true;
					return data;
				}
				const eol = parts[1] ?? "\n";
				const replaced = api ? api.executeToggleTaskDoneCommand(item.raw, file.path) : withMark(item.raw, newMark);
				parts[idx] = replaced.replace(/\r?\n$/, "").replace(/\r?\n/g, eol);
				return parts.join("");
			});
		} catch (err) {
			console.error("Periodic Note Review: couldn't update the item", err);
			new Notice("Couldn't update that item. See the console for details.");
			return;
		}
		if (stale) {
			new Notice("The note changed since this page was drawn. It's been refreshed.");
			void this.renderNote(true);
			return;
		}
		// Show the change straight away; the metadata update redraws the page after.
		const cb = li.querySelector<HTMLInputElement>("input[type=checkbox]");
		if (cb) cb.checked = newMark !== " ";
		li.toggleClass("is-checked", newMark !== " ");
		li.setAttr("data-task", newMark);
	}

	private scrollToFirst(typeId: string) {
		if (!this.analysis || !this.itemsMatched) return;
		const i = this.analysis.renderedItems.findIndex((it) => it.typeId === typeId && it.state === "open");
		const li = this.itemEls[i];
		if (!li) return;
		// Scroll only the page's own scroller, vertically.
		const main = this.mainEl;
		const y = li.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
		main.scrollTo({ top: Math.max(0, y - main.clientHeight / 3), behavior: this.reducedMotion() ? "auto" : "smooth" });
		li.removeClass("pnr-flash");
		void li.offsetWidth;
		li.addClass("pnr-flash");
	}

	private reducedMotion(): boolean {
		return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
	}

	// ---------------------------------------------------------------- review actions

	/** First call arms the button; a second call within CONFIRM_MS marks the note reviewed. */
	async markReviewed() {
		const e = this.current();
		const file = this.currentFile();
		if (!e || !file || this.busy) return;
		if (!e.needsReview) return;
		if (!this.settings.kinds[e.kind].canMarkReviewed) {
			new Notice(`${e.kind[0].toUpperCase()}${e.kind.slice(1)} notes can't be marked reviewed from here (see settings).`);
			return;
		}
		if (this.armed?.path !== e.path) {
			this.arm(e.path);
			return;
		}
		this.disarm(false);
		this.busy = true;
		try {
			const vis = this.visible();
			const index = vis.findIndex((x) => x.path === e.path);
			const field = statusFieldFor(e.kind, this.settings);
			const value = reviewedValueFor(e.kind, this.settings);
			let before = "";
			let after = "";
			await this.app.vault.process(file, (raw) => {
				before = raw;
				after = withFrontmatterValue(raw, field, value);
				return after;
			});
			this.clearUndo(false);
			const timer = window.setTimeout(() => this.clearUndo(), UNDO_MS);
			this.undo = {
				path: e.path, label: mastheadFor(e, this.settings).headline, kind: e.kind, field, before, after,
				until: Date.now() + UNDO_MS, timer,
			};
			this.store.setNeedsReview(e.path, false);
			if (this.settings.showReviewed) this.goToNextAfter(e, index + 1);
			else this.goToNextAfter(e, Math.max(0, index));
		} catch (err) {
			console.error("Periodic Note Review: couldn't mark the note reviewed", err);
			new Notice("Couldn't mark the note reviewed. See the console for details.");
		} finally {
			this.busy = false;
			this.renderActions();
		}
	}

	async markUnreviewed() {
		const e = this.current();
		const file = this.currentFile();
		if (!e || !file || e.needsReview || !this.settings.kinds[e.kind].canMarkReviewed) return;
		const field = statusFieldFor(e.kind, this.settings);
		await this.app.vault.process(file, (raw) => withFrontmatterValue(raw, field, unreviewedValueFor(e.kind, this.settings)));
		this.store.setNeedsReview(e.path, true);
	}

	// ---------------------------------------------------------------- input

	private registerKeys(scope: Scope) {
		// Keys belong to the view unless a field has focus. Enter and Space also go to a
		// focused button or queue row, which handle them themselves.
		const free = (key: string) => {
			const a = document.activeElement;
			if (!a || !this.contentEl.contains(a)) return true;
			if (a.matches("input, select, textarea, [contenteditable]")) return false;
			if ((key === "Enter" || key === " ") && a.matches("button, a, [role=button]")) return false;
			return true;
		};
		const bind = (key: string, fn: (evt: KeyboardEvent) => void, mods: ("Shift")[] = []) => {
			scope.register(mods, key, (evt) => {
				if (!free(key)) return true;
				fn(evt);
				return false;
			});
		};
		bind("ArrowLeft", () => this.step(-1));
		bind("k", () => this.step(-1));
		bind("ArrowRight", () => this.step(1));
		bind("j", () => this.step(1));
		bind("ArrowUp", () => this.mainEl.scrollBy({ top: -60 }));
		bind("ArrowDown", () => this.mainEl.scrollBy({ top: 60 }));
		bind(" ", () => this.mainEl.scrollBy({ top: this.mainEl.clientHeight * 0.85 }));
		bind(" ", () => this.mainEl.scrollBy({ top: -this.mainEl.clientHeight * 0.85 }), ["Shift"]);
		bind("Enter", (evt) => {
			if (!evt.repeat) void this.markReviewed();
		});
		bind("o", () => this.openInEditor(true));
		bind("Escape", () => {
			this.disarm();
			this.setQueueOpen(false);
		});
		bind("u", () => void this.undoLast());
	}

	/** Mostly-horizontal swipes on the page go to the previous / next note. */
	private registerSwipe(el: HTMLElement) {
		let x0 = 0;
		let y0 = 0;
		let t0 = 0;
		let tracking = false;
		let horizontal: boolean | null = null;
		this.registerDomEvent(el, "touchstart", (evt: TouchEvent) => {
			if (evt.touches.length !== 1) {
				tracking = false;
				return;
			}
			const target = evt.target as HTMLElement;
			// Leave sideways scrolling of wide code blocks and tables alone.
			if (target.closest("pre, table, .pnr-chips, input, select")) {
				tracking = false;
				return;
			}
			const t = evt.touches[0];
			x0 = t.clientX;
			y0 = t.clientY;
			t0 = Date.now();
			tracking = true;
			horizontal = null;
		}, { passive: true });
		this.registerDomEvent(el, "touchmove", (evt: TouchEvent) => {
			if (!tracking) return;
			const t = evt.touches[0];
			const dx = t.clientX - x0;
			const dy = t.clientY - y0;
			if (horizontal === null && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) {
				horizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
				if (!horizontal) tracking = false;
			}
			// Keep Obsidian from treating our swipe as a sidebar swipe.
			if (horizontal) evt.stopPropagation();
		}, { passive: true });
		this.registerDomEvent(el, "touchend", (evt: TouchEvent) => {
			if (!tracking || !horizontal) return;
			tracking = false;
			const t = evt.changedTouches[0];
			const dx = t.clientX - x0;
			const dy = t.clientY - y0;
			if (Date.now() - t0 > 800 || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
			evt.stopPropagation();
			this.step(dx < 0 ? 1 : -1);
		});
	}
}
