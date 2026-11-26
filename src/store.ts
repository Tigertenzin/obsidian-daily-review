import { App, Events, getAllTags, TAbstractFile, TFile } from "obsidian";
import { analyzeNote } from "./core/parse";
import { classifyNote, hasTag, kindFromTags, todayString } from "./core/periods";
import {
	buildPages, compilePattern, DAY_PREFIX, ExtraEntry, extraNeedsReview, inExtraFolder, matchExtraFile, matchExtraSpan,
	nameWithoutDate, normFolder,
} from "./core/extras";
import { NoteEntry, QueueEntry } from "./core/queue";
import { needsReview } from "./core/review";
import { ExtraFolder, Kind, Settings } from "./core/settings";

export interface ExtraFolderStats {
	/** Markdown files in the folder. */
	files: number;
	/** Files whose name fits the date format and pattern. */
	matched: number;
	toReview: number;
	/** A few matched names with the day each was read as, newest first. */
	examples: { name: string; date: string; time: string | null; shown: string }[];
	/** A few names in the folder that didn't fit. */
	misses: string[];
	/** Set when the pattern isn't a valid regular expression. */
	error?: string;
}

/**
 * Keeps one NoteEntry per periodic note in the notes folder, updated from vault and
 * metadata events. Fires "changed" (path | null for everything) when entries change.
 */
export class NoteStore extends Events {
	/** Periodic notes, by path. */
	entries = new Map<string, NoteEntry>();
	/** Notes from extra folders, by path. */
	extras = new Map<string, ExtraEntry>();
	private pageCache: Map<string, QueueEntry> | null = null;
	today = todayString();
	ready = false;
	/** Section-level headings per note, for the settings preview. */
	private headings = new Map<string, string[]>();
	private queue = Promise.resolve();

	constructor(private app: App, private getSettings: () => Settings) {
		super();
	}

	private inFolder(path: string): boolean {
		const folder = normFolder(this.getSettings().folder);
		return !folder || path.startsWith(folder + "/");
	}

	/** Whether a file could be a periodic note or a scrap. */
	private relevant(path: string): boolean {
		return this.inFolder(path) || this.getSettings().extraFolders.some((f) => f.enabled && inExtraFolder(path, f));
	}

	/** The review pages, built from the notes and scraps on first use after a change. */
	get pages(): Map<string, QueueEntry> {
		if (!this.pageCache) {
			const s = this.getSettings();
			this.pageCache = buildPages(this.entries.values(), this.extras.values(), s.extraLayout, s.extraFolders.map((f) => f.id));
		}
		return this.pageCache;
	}

	/** Rebuild the pages next time they're read (after a layout or settings change). */
	invalidatePages(): void {
		this.pageCache = null;
	}

	/**
	 * The key of the page holding a note or scrap, or showing the same day as a page key
	 * from the other layout. Null when there's no such page.
	 */
	pageKeyFor(pathOrKey: string): string | null {
		const pages = this.pages;
		if (pages.has(pathOrKey)) return pathOrKey;
		for (const p of pages.values()) {
			if (p.note?.path === pathOrKey || p.scraps.some((x) => x.path === pathOrKey)) return p.path;
		}
		const date = pathOrKey.startsWith(DAY_PREFIX) ? pathOrKey.slice(DAY_PREFIX.length) : null;
		if (date) {
			for (const p of pages.values()) if (p.kind === "daily" && p.start === date) return p.path;
		}
		return null;
	}

	/** Fire "changed" for the page holding `path`, before and after an update. */
	private changed(path: string, before: string | null): void {
		this.invalidatePages();
		const after = this.pageKeyFor(path);
		if (before && after && before !== after) this.trigger("changed", null);
		else this.trigger("changed", after ?? before ?? path);
	}

	/** Serialise async work so updates for the same file can't interleave. */
	private enqueue(fn: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(fn, fn);
		return this.queue;
	}

	rebuild(): Promise<void> {
		return this.enqueue(async () => {
			this.entries.clear();
			this.extras.clear();
			this.headings.clear();
			this.today = todayString();
			const files = this.app.vault.getMarkdownFiles().filter((f) => this.relevant(f.path));
			await Promise.all(files.map((f) => this.compute(f)));
			this.invalidatePages();
			this.ready = true;
			this.trigger("changed", null);
		});
	}

	update(file: TAbstractFile, data?: string): Promise<void> {
		return this.enqueue(async () => {
			if (!(file instanceof TFile)) return;
			const before = this.ready ? this.pageKeyFor(file.path) : null;
			await this.compute(file, data);
			this.changed(file.path, before);
		});
	}

	remove(path: string): void {
		const before = this.pageKeyFor(path);
		const had = this.entries.delete(path) || this.extras.delete(path);
		this.headings.delete(path);
		if (had) this.changed(path, before);
	}

	rename(file: TAbstractFile, oldPath: string): void {
		this.remove(oldPath);
		void this.update(file);
	}

	/** Re-check "days ago" when the date rolls over. Returns true if it did. */
	checkDate(): boolean {
		const t = todayString();
		if (t === this.today) return false;
		this.today = t;
		this.invalidatePages();
		this.trigger("changed", null);
		return true;
	}

	/** Record a review-state write straight away, before the metadata cache catches up. */
	setNeedsReview(path: string, value: boolean): void {
		const e = this.entries.get(path) ?? this.extras.get(path);
		if (!e || e.needsReview === value) return;
		const before = this.pageKeyFor(path);
		e.needsReview = value;
		this.changed(path, before);
	}

	private async compute(file: TFile, data?: string): Promise<void> {
		const settings = this.getSettings();
		const drop = () => {
			this.entries.delete(file.path);
			this.extras.delete(file.path);
			this.headings.delete(file.path);
		};
		if (file.extension !== "md" || !this.relevant(file.path)) return drop();
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return drop();
		const tags = getAllTags(cache) ?? [];
		const period = this.inFolder(file.path) && (!settings.membershipTag.trim() || hasTag(tags, settings.membershipTag))
			? classifyNote(file.basename, tags, settings) : null;
		const extra = matchExtraFile(file.path, file.basename, settings);
		// A file that is both goes with the more specific folder (the periodic one on a tie).
		if (extra && (!period || normFolder(extra.folder.folder).length > normFolder(settings.folder).length)) {
			const raw = data ?? (await this.app.vault.cachedRead(file));
			const a = analyzeNote(raw, file.basename, settings, extra.folder.defaultType || undefined);
			this.entries.delete(file.path);
			this.headings.set(file.path, a.headings.filter((h) => h.level === settings.sectionLevel).map((h) => h.text.trim()));
			this.extras.set(file.path, {
				path: file.path,
				title: file.basename,
				folderId: extra.folder.id,
				date: extra.match.date,
				time: extra.match.time,
				name: nameWithoutDate(file.basename, extra.match.at, extra.match.length),
				needsReview: extraNeedsReview(extra.folder, cache.frontmatter, settings),
				counts: a.counts,
				open: a.open,
				tasks: a.tasks,
				settled: a.settled,
			});
			return;
		}
		if (!period) return drop();
		this.extras.delete(file.path);
		const raw = data ?? (await this.app.vault.cachedRead(file));
		const a = analyzeNote(raw, file.basename, settings);
		this.entries.set(file.path, {
			...period,
			path: file.path,
			title: file.basename,
			needsReview: needsReview(period.kind, cache.frontmatter, settings),
			counts: a.counts,
			open: a.open,
			tasks: a.tasks,
			settled: a.settled,
		});
		this.headings.set(
			file.path,
			a.headings.filter((h) => h.level === settings.sectionLevel).map((h) => h.text.trim()),
		);
	}

	/**
	 * How many notes in the folder each kind picks up with `settings`, and how many
	 * notes carry a kind's tag but don't fit its title format (with one example title).
	 */
	countByKind(settings: Settings): { counts: Record<Kind, number>; misses: Record<Kind, { count: number; example: string }> } {
		const counts = { daily: 0, weekly: 0, monthly: 0, quarterly: 0, yearly: 0 };
		const misses = {
			daily: { count: 0, example: "" }, weekly: { count: 0, example: "" }, monthly: { count: 0, example: "" },
			quarterly: { count: 0, example: "" }, yearly: { count: 0, example: "" },
		};
		const folder = settings.folder.trim().replace(/^\/+|\/+$/g, "");
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (folder && !file.path.startsWith(folder + "/")) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const tags = getAllTags(cache) ?? [];
			if (settings.membershipTag.trim() && !hasTag(tags, settings.membershipTag)) continue;
			const p = classifyNote(file.basename, tags, settings);
			if (p) {
				counts[p.kind]++;
				continue;
			}
			const tagged = kindFromTags(tags, settings);
			if (tagged && settings.kinds[tagged].enabled) {
				const m = misses[tagged];
				m.count++;
				if (!m.example || file.basename > m.example) m.example = file.basename;
			}
		}
		return { counts, misses };
	}

	/** How an extra folder's settings read the files in it, for the settings preview. */
	extraFolderStats(f: ExtraFolder, settings: Settings): ExtraFolderStats {
		const stats: ExtraFolderStats = { files: 0, matched: 0, toReview: 0, examples: [], misses: [] };
		const c = compilePattern(f.pattern);
		if (c.error !== undefined) stats.error = c.error;
		const found: ExtraFolderStats["examples"] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!inExtraFolder(file.path, f)) continue;
			stats.files++;
			const m = c.error === undefined ? matchExtraSpan(file.basename, f.dateFormat, c) : null;
			if (!m) {
				if (stats.misses.length < 3) stats.misses.push(file.basename);
				continue;
			}
			stats.matched++;
			found.push({ name: file.basename, date: m.date, time: m.time, shown: nameWithoutDate(file.basename, m.at, m.length) });
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (extraNeedsReview(f, fm, settings)) stats.toReview++;
		}
		const key = (x: { date: string; time: string | null }) => `${x.date} ${x.time ?? ""}`;
		stats.examples = found.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0)).slice(0, 3);
		return stats;
	}

	/** Every section heading in the notes, with how many notes use it, most used first. */
	headingIndex(): [string, number][] {
		const counts = new Map<string, number>();
		for (const list of this.headings.values()) {
			for (const h of new Set(list)) counts.set(h, (counts.get(h) ?? 0) + 1);
		}
		return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	}
}
