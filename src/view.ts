import {
	Component, ItemView, Keymap, MarkdownRenderer, moment, Notice, Scope, setIcon, TFile, WorkspaceLeaf,
} from "obsidian";
import {
	analyzeNote, domainLabel, firstLinkDomain, Item, NoteAnalysis, typeForHeading, withMark,
} from "./core/parse";
import { ExtraEntry, extraLabel, extraStatusField } from "./core/extras";
import { daysAgo } from "./core/periods";
import {
	FILTERS, FilterId, groupLabel, isFuture, isPast, longAge, mastheadFor, matchesFilter, matchesTypeFilter,
	openByType, QueueEntry, rangeLabel, TypeFilterState,
	shortAge, sortEntries, ticksFor, weekNumber,
} from "./core/queue";
import { reviewedValueFor, statusFieldFor, unreviewedValueFor, withFrontmatterValue } from "./core/review";
import { ExtraFolder, Kind, OTHER_ID, SortMode } from "./core/settings";
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

/** One note drawn on the page: the periodic note, or a scrap. */
interface Section {
	file: TFile;
	analysis: NoteAnalysis;
	/** Rendered checkbox list items, matched by order to analysis.renderedItems. */
	itemEls: HTMLElement[];
	matched: boolean;
	/** Its open items count toward the page: it still needs review, or nothing on the page does. */
	counted: boolean;
}

/** A frontmatter write made by "Mark reviewed", with what undoing it writes back. */
interface ReviewWrite {
	path: string;
	field: string;
	/** The value to write back when undoing. */
	back: string;
	before: string;
	after: string;
}

/** A note on a page whose review state "Mark reviewed" (or unreviewed) can change. */
interface ReviewTarget {
	path: string;
	field: string;
	/** Open items in it, for the confirm label. */
	open: number;
	reviewed: string;
	unreviewed: string;
}

interface TasksApi {
	executeToggleTaskDoneCommand(line: string, path: string): string;
}

export class ReviewView extends ItemView {
	private currentPath: string | null = null;
	private filter: FilterId = "all";
	private typeFilter = new Map<string, TypeFilterState>();
	private filtersOpen = false;
	private queueOpen = false;
	private busy = false;
	/** "Mark reviewed" has been pressed once and is waiting for confirmation. */
	private armed: { path: string; until: number; timer: number } | null = null;
	/** The last "Mark reviewed", while it can still be undone. */
	private undo: { page: string; label: string; writes: ReviewWrite[]; until: number; timer: number } | null = null;
	private actionsEl!: HTMLElement;

	private topEl!: HTMLElement;
	private mainEl!: HTMLElement;
	private sheetEl!: HTMLElement;
	private queueEl!: HTMLElement;

	private noteComponent: Component | null = null;
	private renderToken = 0;
	/** The notes drawn on the current page, in order. */
	private sections: Section[] = [];
	/** A page whose reviewed daily note the reader asked to see anyway. */
	private shownNote: string | null = null;

	/** Whether future notes are unfolded in the queue; starts from the setting. */
	private showFuture: boolean;

	constructor(leaf: WorkspaceLeaf, private plugin: PeriodicNoteReviewPlugin) {
		super(leaf);
		this.showFuture = plugin.settings.showFuture;
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
		this.registerDomEvent(document, "pointerdown", (evt: PointerEvent) => {
			if (!this.filtersOpen) return;
			const t = evt.target as HTMLElement;
			if (t.closest(".pnr-filter-panel, .pnr-filter-toggle")) return;
			this.filtersOpen = false;
			this.renderTop();
		});
		this.registerDomEvent(window, "resize", () => this.updateBottomInset());
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

	/** Notes listed in the queue: still to review (plus reviewed ones if shown), and
	 *  future ones only while they're unfolded. Counts at the top follow the same list. */
	private listed(withFuture = this.showFuture): QueueEntry[] {
		const today = this.store.today;
		return [...this.store.pages.values()].filter((e) =>
			(e.needsReview || this.settings.showReviewed) && (withFuture || !isFuture(e, today)));
	}

	/** The queue in its current filter and sort, future notes included or not. */
	private visible(withFuture = this.showFuture): QueueEntry[] {
		const today = this.store.today;
		return sortEntries(
			this.listed(withFuture).filter((e) =>
				matchesFilter(e, this.filter, today) && matchesTypeFilter(e, this.typeFilter)),
			this.settings.sort,
		);
	}

	private toReview(): QueueEntry[] {
		return [...this.store.pages.values()].filter((e) => e.needsReview && isPast(e, this.store.today));
	}

	private current(): QueueEntry | null {
		return this.currentPath ? this.store.pages.get(this.currentPath) ?? null : null;
	}

	private extraFolder(id: string): ExtraFolder | undefined {
		return this.settings.extraFolders.find((f) => f.id === id);
	}

	/** A page that is one scrap on its own (scraps shown as their own pages). */
	private isScrapPage(e: QueueEntry): boolean {
		return e.note === null && this.settings.extraLayout === "pages";
	}

	private pickStartNote() {
		const first = this.visible().find((e) => e.needsReview && isPast(e, this.store.today));
		this.currentPath = first?.path ?? null;
	}

	private onStoreChanged(path: string | null) {
		if (!this.topEl) return;
		if (path === null) {
			// The page may have a new key (the layout changed, or a daily note appeared).
			if (!this.current() && this.currentPath) this.currentPath = this.store.pageKeyFor(this.currentPath);
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
		const changed = narrow !== this.contentEl.hasClass("is-narrow");
		this.contentEl.toggleClass("is-narrow", narrow);
		if (!narrow) this.setQueueOpen(false);
		if (changed && this.topEl) {
			this.filtersOpen = false;
			this.renderTop();
		}
		this.updateBottomInset();
	}

	/**
	 * On phones Obsidian's navigation bar floats over the bottom of the view. Keep the
	 * buttons (and the end of the queue) clear of it by measuring where it starts.
	 */
	private updateBottomInset() {
		const nav = document.querySelector<HTMLElement>(".mobile-navbar");
		let inset = 0;
		if (nav && getComputedStyle(nav).display !== "none") {
			// While Obsidian hides the bar on scroll, keep the space we measured before.
			if (document.body.hasClass("is-hidden-nav")) return;
			const r = nav.getBoundingClientRect();
			const c = this.contentEl.getBoundingClientRect();
			if (r.height > 0) inset = Math.max(0, Math.round(c.bottom - r.top));
		}
		this.contentEl.style.setProperty("--pnr-bottom-inset", `${inset}px`);
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
		if (this.contentEl.hasClass("is-narrow")) {
			this.renderCompactTop(el);
			return;
		}
		const n = this.toReview().length;
		const today = this.store.today;

		const tally = el.createDiv({ cls: "pnr-tally" });
		tally.createSpan({ cls: "pnr-tally-count", text: `${n} to review` });
		this.renderTypePills(tally);

		const controls = el.createDiv({ cls: "pnr-controls" });
		const chips = controls.createDiv({ cls: "pnr-chips" });
		const listed = this.listed().filter((e) => matchesTypeFilter(e, this.typeFilter));
		for (const f of FILTERS) {
			if (!this.filterOffered(f.id) && this.filter !== f.id) continue;
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

	/** Whether a kind chip applies at all: its kind is in the review, or there are extra folders. */
	private filterOffered(id: FilterId): boolean {
		if (id === "all") return true;
		if (id === "scraps") return this.settings.extraFolders.some((f) => f.enabled);
		return !!this.settings.kinds[id as Kind]?.enabled;
	}

	/** Filters that differ from the default, for the compact Filter button's badge. */
	private activeFilterCount(): number {
		return (this.filter === "all" ? 0 : 1) + this.typeFilter.size;
	}

	/**
	 * Small panes and phones: one row ("N to review", Filter, Queue). Kind, item type and
	 * sort options live in a panel that drops down under it.
	 */
	private renderCompactTop(el: HTMLElement) {
		const row = el.createDiv({ cls: "pnr-compact-row" });
		row.createSpan({ cls: "pnr-tally-count", text: `${this.toReview().length} to review` });

		const right = row.createDiv({ cls: "pnr-controls-right" });
		const fBtn = right.createEl("button", { cls: "pnr-filter-toggle", attr: { "aria-label": "Filter and sort", "aria-expanded": String(this.filtersOpen) } });
		fBtn.toggleClass("is-open", this.filtersOpen);
		setIcon(fBtn.createSpan(), "sliders-horizontal");
		fBtn.createSpan({ text: "Filter" });
		const active = this.activeFilterCount();
		if (active > 0) fBtn.createSpan({ cls: "pnr-filter-badge", text: String(active) });
		fBtn.addEventListener("click", () => {
			this.filtersOpen = !this.filtersOpen;
			this.renderTop();
		});

		const qBtn = right.createEl("button", { cls: "pnr-queue-toggle", attr: { "aria-label": "Show queue" } });
		setIcon(qBtn.createSpan(), "list");
		qBtn.createSpan({ text: `Queue ${this.visible().length}` });
		qBtn.addEventListener("click", () => {
			this.filtersOpen = false;
			this.renderTop();
			this.setQueueOpen(!this.queueOpen);
		});

		if (this.filtersOpen) this.renderFilterPanel(el);
	}

	private renderFilterPanel(parent: HTMLElement) {
		let panel = parent.createDiv({ cls: "pnr-filter-panel" });
		// Fit between the top bar and the bottom of the view (above any floating nav bar).
		window.requestAnimationFrame(() => {
			const inset = parseFloat(this.contentEl.style.getPropertyValue("--pnr-bottom-inset")) || 0;
			const room = this.contentEl.getBoundingClientRect().bottom - panel.getBoundingClientRect().top - inset - 8;
			if (room > 120) panel.style.maxHeight = `${Math.round(room)}px`;
		});
		panel = panel.createDiv({ cls: "pnr-filter-inner" });
		const today = this.store.today;

		// Kinds
		panel.createDiv({ cls: "pnr-filter-heading", text: "Show" });
		const kinds = panel.createDiv({ cls: "pnr-segmented" });
		const listed = this.listed().filter((e) => matchesTypeFilter(e, this.typeFilter));
		for (const f of FILTERS) {
			if (!this.filterOffered(f.id)) continue;
			const count = listed.filter((e) => matchesFilter(e, f.id, today)).length;
			if (count === 0 && this.filter !== f.id && f.id !== "all") continue;
			const b = kinds.createEl("button", { cls: "pnr-seg" });
			b.toggleClass("is-active", this.filter === f.id);
			b.createSpan({ text: f.label });
			b.createSpan({ cls: "pnr-chip-count", text: String(count) });
			b.addEventListener("click", () => {
				this.filter = f.id;
				this.afterFilterChange();
			});
		}

		// Item types: Any / Only / Hide
		const pool = this.listed().filter((e) => e.needsReview && matchesFilter(e, this.filter, today));
		const totals = openByType(pool);
		const ids = this.typeOrder().filter((id) => !(id === OTHER_ID && this.settings.other.hidden)
			&& ((totals[id] ?? 0) > 0 || this.typeFilter.has(id)));
		if (ids.length > 0) {
			panel.createDiv({ cls: "pnr-filter-heading", text: "Open items" });
			for (const id of ids) {
				const row = panel.createDiv({ cls: "pnr-type-row" });
				row.style.setProperty("--pnr-color", this.colorFor(id));
				const name = row.createDiv({ cls: "pnr-type-row-name" });
				name.createSpan({ cls: "pnr-type-dot" });
				name.createSpan({ text: this.labelFor(id) });
				name.createSpan({ cls: "pnr-type-pill-count", text: String(totals[id] ?? 0) });
				const seg = row.createDiv({ cls: "pnr-segmented is-small" });
				const state = this.typeFilter.get(id);
				const options: [TypeFilterState | undefined, string, string][] = [
					[undefined, "Any", "Show notes whatever they have open"],
					["include", "Only", `Only notes with ${this.labelFor(id)} open`],
					["exclude", "Hide", `Hide notes with only ${this.labelFor(id)} left`],
				];
				for (const [value, label, tip] of options) {
					const b = seg.createEl("button", { cls: "pnr-seg", text: label, attr: { "aria-label": tip } });
					b.toggleClass("is-active", state === value);
					b.addEventListener("click", () => {
						if (value) this.typeFilter.set(id, value);
						else this.typeFilter.delete(id);
						this.afterFilterChange();
					});
				}
			}
		}

		// Sort
		const sortRow = panel.createDiv({ cls: "pnr-filter-sort" });
		sortRow.createDiv({ cls: "pnr-filter-heading", text: "Sort" });
		const sort = sortRow.createEl("select", { cls: "dropdown pnr-sort" });
		for (const s of SORTS) {
			const o = sort.createEl("option", { text: s.label, value: s.id });
			if (s.id === this.settings.sort) o.selected = true;
		}
		sort.addEventListener("change", async () => {
			this.settings.sort = sort.value as SortMode;
			await this.plugin.saveSettings(false);
		});

		const foot = panel.createDiv({ cls: "pnr-filter-foot" });
		if (this.activeFilterCount() > 0) {
			const clear = foot.createEl("button", { cls: "pnr-filter-clear", text: "Clear filters" });
			clear.addEventListener("click", () => {
				this.filter = "all";
				this.typeFilter.clear();
				this.afterFilterChange();
			});
		}
		const done = foot.createEl("button", { cls: "mod-cta pnr-filter-done", text: "Done" });
		done.addEventListener("click", () => {
			this.filtersOpen = false;
			this.renderTop();
		});
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
		const today = this.store.today;
		const all = this.visible(true);
		const current = all.filter((e) => !isFuture(e, today));
		const future = all.filter((e) => isFuture(e, today));
		const dateSort = this.settings.sort === "oldest" || this.settings.sort === "newest";
		let lastGroup = "";
		let lastPast: boolean | null = null;
		/** The day of the last daily row, so a scrap whose day has no note gets the day shown. */
		let lastDay = "";

		if (current.length === 0 && future.length === 0) list.createDiv({ cls: "pnr-queue-empty", text: "Nothing here." });

		// Future notes fold away behind an "Upcoming" chevron: at the end, or at the top
		// when the newest come first.
		const shownFuture = this.showFuture ? future : [];
		const toggle = future.length > 0 ? [null] : [];
		const order: (QueueEntry | null)[] = this.settings.sort === "newest"
			? [...toggle, ...shownFuture, ...current]
			: [...current, ...toggle, ...shownFuture];

		for (const e of order) {
			if (e === null) {
				this.renderFutureToggle(list, future.length);
				lastGroup = "";
				lastDay = "";
				continue;
			}
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
			if (this.isScrapPage(e) && e.start !== lastDay) {
				const s = moment(e.start, "YYYY-MM-DD");
				const head = list.createDiv({ cls: "pnr-row-dayhead" });
				head.createSpan({ cls: "pnr-row-day", text: s.format("D") });
				head.createSpan({ cls: "pnr-row-sub", text: s.format("ddd") });
			}
			if (e.kind === "daily") lastDay = e.start;
			this.renderRow(list, e, today);
		}

		list.scrollTop = prevScroll;
		window.requestAnimationFrame(() => this.revealCurrentRow());
	}

	private renderFutureToggle(list: HTMLElement, count: number) {
		const btn = list.createDiv({ cls: "pnr-future-toggle", attr: { role: "button", tabindex: "0" } });
		btn.toggleClass("is-open", this.showFuture);
		btn.setAttr("aria-expanded", this.showFuture ? "true" : "false");
		setIcon(btn.createSpan({ cls: "pnr-future-chevron" }), "chevron-right");
		btn.createSpan({ text: "Upcoming" });
		btn.createSpan({ cls: "pnr-future-count", text: `${count}` });
		const flip = () => {
			this.showFuture = !this.showFuture;
			this.afterFilterChange();
		};
		btn.addEventListener("click", flip);
		btn.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				evt.stopPropagation();
				flip();
			}
		});
	}

	private renderRow(list: HTMLElement, e: QueueEntry, today: string): HTMLElement {
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
		const scrapPage = this.isScrapPage(e);
		switch (scrapPage ? "scrap" : e.kind) {
			case "scrap": {
				// A scrap's own page sits under its day: a small note icon and its name.
				const x = e.scraps[0];
				row.addClass("is-scrap");
				row.style.setProperty("--pnr-scrap-color", this.scrapColor(x));
				setIcon(date.createSpan({ cls: "pnr-row-scrap-icon" }), "sticky-note");
				date.createSpan({ cls: "pnr-row-scrap-title", text: this.scrapName(x) });
				date.setAttr("aria-label", `${extraLabel(this.extraFolder(x.folderId) ?? this.missingFolder())}: ${x.title}`);
				break;
			}
			case "daily":
				date.createSpan({ cls: "pnr-row-day", text: s.format("D") });
				date.createSpan({ cls: "pnr-row-sub", text: s.format("ddd") });
				if (e.note === null) row.addClass("is-scraps-only");
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

		row.createSpan({ cls: "pnr-row-leader" });
		const ticks = row.createDiv({ cls: "pnr-ticks" });
		if (!scrapPage && e.scraps.length > 0) {
			// The day's scraps: one small note per scrap, before the ticks.
			const pile = ticks.createSpan({ cls: "pnr-row-scraps" });
			setIcon(pile.createSpan(), "sticky-note");
			if (e.scraps.length > 1) pile.createSpan({ text: String(e.scraps.length) });
			pile.setAttr("aria-label", `${e.scraps.length} ${e.scraps.length === 1 ? "scrap" : "scraps"}`);
		}
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

		row.createDiv({ cls: "pnr-row-age", text: scrapPage ? "" : shortAge(e, today) });
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

	private countSummary(e: QueueEntry): string {
		return this.typeOrder()
			.filter((id) => e.counts[id])
			.map((id) => `${e.counts[id].open + e.counts[id].tasks} ${this.labelFor(id)}`)
			.join(", ");
	}

	// ---------------------------------------------------------------- navigation

	goTo(path: string | null) {
		if (path !== this.currentPath) this.shownNote = null;
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
	private goToNextAfter(prev: QueueEntry | null, prevIndex?: number) {
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

	/** Open the page's note (or, on a page with no periodic note, its first scrap). */
	openInEditor(newTab = true) {
		const e = this.current();
		const path = e?.note?.path ?? e?.scraps[0]?.path;
		if (path) this.openPath(path, newTab);
	}

	private openPath(path: string, newTab = true) {
		const file = this.fileAt(path);
		if (file) void this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
	}

	private fileAt(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}

	/** A stand-in for a scrap whose folder was removed from the settings since it was read. */
	private missingFolder(): ExtraFolder {
		return {
			id: "", folder: "", label: "Scrap", color: "", enabled: true, subfolders: true, dateFormat: "",
			pattern: "", statusField: "", missingStatus: "unreviewed", defaultType: "",
		};
	}

	/** A scrap's name without the date, for places that already show the day. */
	private scrapName(x: ExtraEntry): string {
		return x.name;
	}

	private scrapColor(x: ExtraEntry): string {
		return this.extraFolder(x.folderId)?.color || "var(--color-yellow)";
	}

	// ---------------------------------------------------------------- the note

	private async renderNote(keepScroll: boolean) {
		const token = ++this.renderToken;
		const e = this.current();
		const members: { file: TFile; scrap: ExtraEntry | null; needsReview: boolean }[] = [];
		// A reviewed daily note stays off the page while its day still has scraps to review.
		const hideNote = !!e?.note && !e.note.needsReview && e.needsReview && e.scraps.length > 0
			&& this.settings.extraLayout === "below" && this.settings.hideReviewedNote && this.shownNote !== e.path;
		if (e?.note && !hideNote) {
			const f = this.fileAt(e.note.path);
			if (f) members.push({ file: f, scrap: null, needsReview: e.note.needsReview });
		}
		for (const x of e?.scraps ?? []) {
			const f = this.fileAt(x.path);
			if (f) members.push({ file: f, scrap: x, needsReview: x.needsReview });
		}
		if (!e || members.length === 0) {
			this.renderEmpty();
			return;
		}
		const raws = await Promise.all(members.map((m) => this.app.vault.cachedRead(m.file)));
		if (token !== this.renderToken) return;
		const sections: Section[] = members.map((m, i) => ({
			file: m.file,
			analysis: analyzeNote(raws[i], m.file.basename, this.settings,
				m.scrap ? this.extraFolder(m.scrap.folderId)?.defaultType || undefined : undefined),
			itemEls: [],
			matched: false,
			counted: !e.needsReview || m.needsReview,
		}));

		const withNote = members[0]?.scrap === null;
		const sheet = createDiv({ cls: "pnr-sheet" });
		if (withNote) {
			const cssclasses = this.app.metadataCache.getFileCache(sections[0].file)?.frontmatter?.cssclasses;
			const extra = Array.isArray(cssclasses) ? cssclasses : typeof cssclasses === "string" ? cssclasses.split(/[\s,]+/) : [];
			for (const c of extra) if (typeof c === "string" && c) sheet.addClass(c);
		}
		const scrapPage = this.isScrapPage(e);
		if (scrapPage) {
			sheet.addClass("is-scrap");
			sheet.style.setProperty("--pnr-scrap-color", this.scrapColor(e.scraps[0]));
		}

		this.renderMasthead(sheet, e);
		this.renderSummary(sheet, sections.filter((x) => x.counted).map((x) => x.analysis));

		const component = new Component();
		component.load();
		const bodies: HTMLElement[] = [];
		const render = async (sec: Section, el: HTMLElement) => {
			bodies.push(el);
			await MarkdownRenderer.render(this.app, sec.analysis.renderText, el, sec.file.path, component);
		};
		/** Sheets drawn after the main one (a day's scraps). */
		const extraSheets: HTMLElement[] = [];
		let next = 0;
		if (hideNote) {
			const hidden = sheet.createDiv({ cls: "pnr-note-hidden" });
			hidden.createSpan({ text: "The daily note is reviewed. Only this day's scraps are left." });
			const show = hidden.createEl("button", { cls: "pnr-link-btn", text: "Show it" });
			show.addEventListener("click", () => {
				this.shownNote = e.path;
				void this.renderNote(true);
			});
		}
		if (withNote) {
			await render(sections[next++], sheet.createDiv({ cls: "pnr-note markdown-rendered markdown-preview-view" }));
		}
		if (scrapPage) {
			await render(sections[next++], sheet.createDiv({ cls: "pnr-note markdown-rendered markdown-preview-view" }));
		} else if (next < sections.length) {
			// Each scrap is a sheet of its own under the day's sheet, like a scrap's own page.
			if (!e.note) sheet.createDiv({ cls: "pnr-scraps-heading", text: "No daily note for this day" });
			const pile = createDiv({ cls: "pnr-scraps" });
			extraSheets.push(pile);
			for (const x of e.scraps) {
				if (next >= sections.length) break;
				const sec = sections[next];
				if (sec.file.path !== x.path) continue;
				next++;
				const card = pile.createDiv({ cls: "pnr-sheet is-scrap pnr-scrap-sheet" });
				card.style.setProperty("--pnr-scrap-color", this.scrapColor(x));
				card.toggleClass("is-reviewed", !x.needsReview);
				const headRow = card.createDiv({ cls: "pnr-scrap-head" });
				const head = headRow.createDiv({ cls: "pnr-scrap-id" });
				const folder = this.extraFolder(x.folderId) ?? this.missingFolder();
				head.createSpan({ cls: "pnr-scrap-folder", text: extraLabel(folder) });
				const title = head.createEl("a", {
					cls: "pnr-scrap-title", text: this.scrapName(x), attr: { href: "#", "aria-label": `Open ${x.title} in the editor` },
				});
				title.addEventListener("click", (evt) => {
					evt.preventDefault();
					this.openPath(x.path, true);
				});
				if (x.time) head.createSpan({ cls: "pnr-scrap-time", text: x.time });
				if (this.settings.scrapReview === "separate") {
					const btn = headRow.createEl("button", { cls: "pnr-scrap-mark" });
					btn.toggleClass("is-reviewed", !x.needsReview);
					setIcon(btn.createSpan(), x.needsReview ? "check" : "check-check");
					btn.createSpan({ text: x.needsReview ? "Mark reviewed" : "Reviewed" });
					btn.setAttr("aria-label", x.needsReview ? `Mark "${x.name}" reviewed` : `Reviewed. Click to mark "${x.name}" unreviewed`);
					btn.addEventListener("click", () => void this.markScrap(x));
				} else if (!x.needsReview && e.needsReview) {
					head.createSpan({ cls: "pnr-reviewed-pill", text: "Reviewed" });
				}
				await render(sec, card.createDiv({ cls: "pnr-note pnr-scrap-body markdown-rendered markdown-preview-view" }));
				if (token !== this.renderToken) break;
			}
		}
		if (token !== this.renderToken) {
			component.unload();
			return;
		}

		const scroll = this.mainEl.scrollTop;
		if (this.noteComponent) this.removeChild(this.noteComponent);
		this.noteComponent = component;
		this.addChild(component);
		this.sections = sections;
		this.sheetEl.empty();
		this.sheetEl.appendChild(sheet);
		for (const x of extraSheets) this.sheetEl.appendChild(x);
		this.renderActions();
		sections.forEach((sec, i) => this.decorate(bodies[i], sec, sheet));
		if (keepScroll) this.mainEl.scrollTop = scroll;
		for (const s of ["tint", "bar", "checkbox", "none"]) {
			this.contentEl.toggleClass("pnr-highlight-" + s, s === this.settings.highlightStyle);
		}
	}

	private renderMasthead(sheet: HTMLElement, e: QueueEntry) {
		const m = mastheadFor(e, this.settings);
		const head = sheet.createDiv({ cls: "pnr-masthead" });
		if (this.isScrapPage(e)) {
			const x = e.scraps[0];
			const folder = this.extraFolder(x.folderId) ?? this.missingFolder();
			head.createDiv({ cls: "pnr-kicker", text: `${extraLabel(folder)} · ${moment(e.start, "YYYY-MM-DD").format("ddd D MMMM YYYY")}` });
			head.createDiv({ cls: "pnr-headline pnr-scrap-headline", text: this.scrapName(x) });
		} else {
			head.createDiv({ cls: "pnr-kicker", text: m.kicker });
			head.createDiv({ cls: "pnr-headline", text: m.headline });
		}
		const meta = head.createDiv({ cls: "pnr-meta" });
		meta.createSpan({ text: longAge(e, this.store.today) });
		const vis = this.visible();
		const i = vis.findIndex((x) => x.path === e.path);
		if (i !== -1) meta.createSpan({ text: `${i + 1} / ${vis.length}` });
		if (!this.isScrapPage(e) && e.scraps.length > 0) {
			const n = e.scraps.length;
			const pile = meta.createSpan({ cls: "pnr-meta-scraps" });
			setIcon(pile.createSpan(), "sticky-note");
			pile.createSpan({ text: `${n} ${n === 1 ? "scrap" : "scraps"}` });
		}
		if (!e.needsReview) meta.createSpan({ cls: "pnr-reviewed-pill", text: "Reviewed" });
		else if (!isPast(e, this.store.today)) meta.createSpan({ cls: "pnr-progress-pill", text: "In progress" });
	}

	/** Type chips and totals for the notes on the page that count. */
	private renderSummary(sheet: HTMLElement, analyses: NoteAnalysis[]) {
		const counts: Record<string, { open: number; tasks: number }> = {};
		let open = 0;
		let tasks = 0;
		let settled = 0;
		for (const a of analyses) {
			for (const [id, c] of Object.entries(a.counts)) {
				const t = counts[id] ?? (counts[id] = { open: 0, tasks: 0 });
				t.open += c.open;
				t.tasks += c.tasks;
			}
			open += a.open;
			tasks += a.tasks;
			settled += a.settled;
		}
		const sum = sheet.createDiv({ cls: "pnr-summary" });
		if (open === 0) {
			sum.createSpan({ cls: "pnr-summary-clear", text: "Nothing left open. Safe to mark reviewed." });
			if (settled > 0) sum.createSpan({ cls: "pnr-summary-meta", text: `${settled} settled` });
			return;
		}
		for (const id of this.typeOrder()) {
			const c = counts[id];
			if (!c) continue;
			const chip = sum.createEl("button", { cls: "pnr-type-chip" });
			chip.style.setProperty("--pnr-color", this.colorFor(id));
			chip.createSpan({ cls: "pnr-type-dot" });
			chip.createSpan({ text: `${c.open + c.tasks} ${this.labelFor(id)}` });
			if (c.tasks > 0) chip.setAttr("aria-label", `${c.tasks} tagged ${this.settings.taskTag}`);
			chip.addEventListener("click", () => this.scrollToFirst(id));
		}
		const parts = [`${open} open`];
		if (tasks) parts.push(`${tasks} ${tasks === 1 ? "task" : "tasks"}`);
		if (settled) parts.push(`${settled} settled`);
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
				cls: "pnr-btn pnr-undo-btn",
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
		open.createSpan({ cls: "pnr-btn-label", text: "Open note" });
		open.setAttr("aria-label", "Open in the editor (o)");
		open.addEventListener("click", () => this.openInEditor(true));

		const mark = bar.createEl("button", { cls: "pnr-btn pnr-mark" });
		// Both labels are laid over each other and only one is shown, so the button keeps
		// the width of the longer one and doesn't jump when it switches to "Confirm".
		const faces = mark.createSpan({ cls: "pnr-mark-faces" });
		const face = (icon: string, text: string, shown: boolean) => {
			const f = faces.createSpan({ cls: "pnr-mark-face" + (shown ? "" : " is-hidden") });
			if (!shown) f.setAttr("aria-hidden", "true");
			setIcon(f.createSpan(), icon);
			f.createSpan({ cls: "pnr-mark-text", text });
		};
		if (!e.needsReview) {
			face("rotate-ccw", "Mark unreviewed", true);
		} else {
			const narrow = this.contentEl.hasClass("is-narrow");
			const targets = this.reviewTargets(e, true);
			const open = targets.reduce((n, t) => n + t.open, 0);
			const scrapsOnly = !!e.note && targets.length > 0 && targets.every((t) => t.path !== e.note!.path);
			const confirm = open > 0 ? (narrow ? `Confirm (${open} open)` : `Confirm · ${open} still open`) : (narrow ? "Confirm" : "Confirm reviewed");
			face("check", scrapsOnly ? (narrow ? "Mark scraps" : "Mark scraps reviewed") : "Mark reviewed", !armed);
			face("check-check", confirm, !!armed);
			if (armed) {
				mark.addClass("is-armed");
				this.addTimer(mark, CONFIRM_MS, armed.until - now);
				mark.setAttr("aria-label", "Click or press Enter again to mark reviewed. Esc cancels.");
			} else {
				mark.addClass("mod-cta");
				mark.setAttr("aria-label", "Mark reviewed (Enter)");
			}
		}
		if (this.reviewTargets(e, e.needsReview).length === 0) {
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
		// Drawn as part of the button's own background (no overlay element): WebKit
		// stopped painting the whole button when an animated layer sat behind its label.
		el.addClass("pnr-has-timer");
		el.style.setProperty("--pnr-timer-duration", `${total}ms`);
		el.style.setProperty("--pnr-timer-delay", `-${Math.max(0, total - left)}ms`);
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

	/** Put the notes back the way they were before the last "Mark reviewed", and go back to the page. */
	async undoLast() {
		const u = this.undo;
		if (!u) return;
		this.clearUndo(false);
		let failed = false;
		for (const w of u.writes) {
			const f = this.fileAt(w.path);
			if (!f) continue;
			try {
				await this.app.vault.process(f, (data) =>
					// Unchanged since: restore it exactly. Edited since: just set the field back.
					data === w.after ? w.before : withFrontmatterValue(data, w.field, w.back));
				this.store.setNeedsReview(w.path, true);
			} catch (err) {
				console.error("Periodic Note Review: couldn't undo", err);
				failed = true;
			}
		}
		if (failed) new Notice("Couldn't undo every note. See the console for details.");
		this.goTo(this.store.pageKeyFor(u.page) ?? u.page);
	}

	private renderEmpty() {
		this.sections = [];
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
		const inProgress = [...this.store.pages.values()].filter((e) => e.needsReview && !isPast(e, today)).length;
		if (inProgress > 0) {
			box.createDiv({
				cls: "pnr-empty-meta",
				text: `${inProgress} ${inProgress === 1 ? "note is" : "notes are"} still in progress. You can open them from the queue.`,
			});
		}
	}

	// ---------------------------------------------------------------- decorating the rendered note

	private decorate(noteEl: HTMLElement, sec: Section, sheet: HTMLElement) {
		const { analysis: a, file } = sec;
		const outsideEmbeds = (el: Element) => !el.parentElement?.closest(".internal-embed, .markdown-embed");
		const lis = Array.from(noteEl.querySelectorAll<HTMLElement>("li.task-list-item")).filter(outsideEmbeds);
		sec.itemEls = lis;
		sec.matched = lis.length === a.renderedItems.length;
		if (!sec.matched) {
			console.warn(
				`Periodic Note Review: ${file.path}: ${lis.length} rendered checkboxes, ${a.renderedItems.length} parsed. ` +
				"Highlighting and checking off are turned off for this note.",
			);
			sheet.querySelector(".pnr-summary")?.createDiv({
				cls: "pnr-summary-warn",
				text: `Couldn't match the checkboxes in "${file.basename}" to the note. Open the note to change them.`,
			});
		} else {
			a.renderedItems.forEach((item, i) => this.decorateItem(lis[i], item, sec.counted));
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
		noteEl.addEventListener("click", (evt) => this.onNoteClick(evt, sec), { capture: true });
		noteEl.addEventListener("mouseover", (evt) => {
			const link = (evt.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
			if (!link) return;
			this.app.workspace.trigger("hover-link", {
				event: evt, source: VIEW_TYPE, hoverParent: this, targetEl: link,
				linktext: link.getAttr("data-href") ?? link.getAttr("href") ?? "", sourcePath: file.path,
			});
		});
	}

	private decorateItem(li: HTMLElement, item: Item, sectionCounted: boolean) {
		const counted = sectionCounted && !(item.typeId === OTHER_ID && this.settings.other.hidden);
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

	private onNoteClick(evt: MouseEvent, sec: Section) {
		const file = sec.file;
		const target = evt.target as HTMLElement;
		const checkbox = target.closest<HTMLInputElement>("input.task-list-item-checkbox, input[type=checkbox]");
		if (checkbox) {
			evt.preventDefault();
			evt.stopPropagation();
			evt.stopImmediatePropagation();
			const li = checkbox.closest<HTMLElement>("li.task-list-item");
			const idx = li ? sec.itemEls.indexOf(li) : -1;
			if (!this.settings.allowCheckingItems) return;
			if (!sec.matched || idx === -1) {
				new Notice("Open the note to change this item.");
				return;
			}
			void this.toggleItem(file, sec.analysis.renderedItems[idx], li!);
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
		let li: HTMLElement | undefined;
		for (const sec of this.sections) {
			if (!sec.counted || !sec.matched) continue;
			const i = sec.analysis.renderedItems.findIndex((it) => it.typeId === typeId && it.state === "open");
			li = sec.itemEls[i];
			if (li) break;
		}
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

	/**
	 * The notes on a page whose review state the bottom button changes. Marking reviewed:
	 * every note on it still to review that may be marked from here; but when scraps have
	 * their own buttons, only the daily note while it's still to review. Marking
	 * unreviewed: the periodic note, or the scraps when the page has no periodic note.
	 */
	private reviewTargets(e: QueueEntry, reviewing: boolean): ReviewTarget[] {
		const n = e.note;
		const noteTarget: ReviewTarget[] = n && this.settings.kinds[n.kind].canMarkReviewed
			&& (reviewing ? n.needsReview : !n.needsReview)
			? [{
				path: n.path, field: statusFieldFor(n.kind, this.settings), open: n.open,
				reviewed: reviewedValueFor(n.kind, this.settings), unreviewed: unreviewedValueFor(n.kind, this.settings),
			}]
			: [];
		if (!reviewing && n) return noteTarget;
		const scrapTargets: ReviewTarget[] = [];
		for (const x of e.scraps) {
			if (reviewing ? !x.needsReview : x.needsReview) continue;
			const f = this.extraFolder(x.folderId);
			if (!f) continue;
			scrapTargets.push({
				path: x.path, field: extraStatusField(f, this.settings), open: x.open,
				reviewed: "true", unreviewed: this.settings.unreviewedValue,
			});
		}
		if (this.separateScraps(e) && noteTarget.length > 0) return noteTarget;
		return [...noteTarget, ...scrapTargets];
	}

	/** Whether this page's scraps have their own Mark reviewed buttons. */
	private separateScraps(e: QueueEntry): boolean {
		return this.settings.scrapReview === "separate" && this.settings.extraLayout === "below" && !!e.note && e.scraps.length > 0;
	}

	/** A scrap's own button (scraps reviewed separately): mark it reviewed, or back. */
	private async markScrap(x: ExtraEntry) {
		const e = this.current();
		const f = this.extraFolder(x.folderId);
		const file = this.fileAt(x.path);
		if (!e || !f || !file || this.busy) return;
		const field = extraStatusField(f, this.settings);
		const reviewing = x.needsReview;
		this.disarm(false);
		this.busy = true;
		try {
			const index = this.visible().findIndex((v) => v.path === e.path);
			let before = "";
			let after = "";
			await this.app.vault.process(file, (raw) => {
				before = raw;
				after = withFrontmatterValue(raw, field, reviewing ? "true" : this.settings.unreviewedValue);
				return after;
			});
			if (reviewing) {
				this.clearUndo(false);
				const timer = window.setTimeout(() => this.clearUndo(), UNDO_MS);
				this.undo = {
					page: e.path, label: x.name, until: Date.now() + UNDO_MS, timer,
					writes: [{ path: x.path, field, back: this.settings.unreviewedValue, before, after }],
				};
			}
			this.store.setNeedsReview(x.path, !reviewing);
			// The last thing on the page to review: move on, as the bottom button would.
			if (!this.store.pages.get(e.path)?.needsReview && !this.settings.showReviewed) this.goToNextAfter(e, Math.max(0, index));
		} catch (err) {
			console.error("Periodic Note Review: couldn't change the scrap's review state", err);
			new Notice("Couldn't change that note. See the console for details.");
		} finally {
			this.busy = false;
			this.renderActions();
		}
	}

	/** First call arms the button; a second call within CONFIRM_MS marks the page reviewed. */
	async markReviewed() {
		const e = this.current();
		if (!e || this.busy) return;
		if (!e.needsReview) return;
		const targets = this.reviewTargets(e, true);
		if (targets.length === 0) {
			new Notice(`${e.kind[0].toUpperCase()}${e.kind.slice(1)} notes can't be marked reviewed from here (see settings).`);
			return;
		}
		if (this.armed?.path !== e.path) {
			this.arm(e.path);
			return;
		}
		this.disarm(false);
		this.busy = true;
		const writes: ReviewWrite[] = [];
		try {
			const vis = this.visible();
			const index = vis.findIndex((x) => x.path === e.path);
			for (const t of targets) {
				const file = this.fileAt(t.path);
				if (!file) continue;
				let before = "";
				let after = "";
				await this.app.vault.process(file, (raw) => {
					before = raw;
					after = withFrontmatterValue(raw, t.field, t.reviewed);
					return after;
				});
				writes.push({ path: t.path, field: t.field, back: t.unreviewed, before, after });
			}
			this.clearUndo(false);
			const timer = window.setTimeout(() => this.clearUndo(), UNDO_MS);
			const label = this.isScrapPage(e) ? this.scrapName(e.scraps[0]) : mastheadFor(e, this.settings).headline;
			this.undo = { page: e.path, label, writes, until: Date.now() + UNDO_MS, timer };
			for (const w of writes) this.store.setNeedsReview(w.path, false);
			// Scraps still to review on this page: stay, with the reviewed note out of the way.
			if (this.store.pages.get(e.path)?.needsReview) this.goTo(e.path);
			else if (this.settings.showReviewed) this.goToNextAfter(e, index + 1);
			else this.goToNextAfter(e, Math.max(0, index));
		} catch (err) {
			console.error("Periodic Note Review: couldn't mark the note reviewed", err);
			new Notice("Couldn't mark the note reviewed. See the console for details.");
			// Keep what was written undoable.
			if (writes.length > 0) {
				for (const w of writes) this.store.setNeedsReview(w.path, false);
				this.clearUndo(false);
				const timer = window.setTimeout(() => this.clearUndo(), UNDO_MS);
				this.undo = { page: e.path, label: e.title, writes, until: Date.now() + UNDO_MS, timer };
			}
		} finally {
			this.busy = false;
			this.renderActions();
		}
	}

	async markUnreviewed() {
		const e = this.current();
		if (!e || e.needsReview) return;
		for (const t of this.reviewTargets(e, false)) {
			const file = this.fileAt(t.path);
			if (!file) continue;
			await this.app.vault.process(file, (raw) => withFrontmatterValue(raw, t.field, t.unreviewed));
			this.store.setNeedsReview(t.path, true);
		}
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
			if (this.filtersOpen) {
				this.filtersOpen = false;
				this.renderTop();
			}
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
