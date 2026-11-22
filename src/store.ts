import { App, Events, getAllTags, TAbstractFile, TFile } from "obsidian";
import { analyzeNote } from "./core/parse";
import { classifyNote, hasTag, todayString } from "./core/periods";
import { NoteEntry } from "./core/queue";
import { needsReview } from "./core/review";
import { Settings } from "./core/settings";

/**
 * Keeps one NoteEntry per periodic note in the notes folder, updated from vault and
 * metadata events. Fires "changed" (path | null for everything) when entries change.
 */
export class NoteStore extends Events {
	entries = new Map<string, NoteEntry>();
	today = todayString();
	ready = false;
	/** Section-level headings per note, for the settings preview. */
	private headings = new Map<string, string[]>();
	private queue = Promise.resolve();

	constructor(private app: App, private getSettings: () => Settings) {
		super();
	}

	private inFolder(path: string): boolean {
		const folder = this.getSettings().folder.trim().replace(/^\/+|\/+$/g, "");
		return !folder || path.startsWith(folder + "/");
	}

	/** Serialise async work so updates for the same file can't interleave. */
	private enqueue(fn: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(fn, fn);
		return this.queue;
	}

	rebuild(): Promise<void> {
		return this.enqueue(async () => {
			this.entries.clear();
			this.headings.clear();
			this.today = todayString();
			const files = this.app.vault.getMarkdownFiles().filter((f) => this.inFolder(f.path));
			await Promise.all(files.map((f) => this.compute(f)));
			this.ready = true;
			this.trigger("changed", null);
		});
	}

	update(file: TAbstractFile, data?: string): Promise<void> {
		return this.enqueue(async () => {
			if (!(file instanceof TFile)) return;
			await this.compute(file, data);
			this.trigger("changed", file.path);
		});
	}

	remove(path: string): void {
		const had = this.entries.delete(path);
		this.headings.delete(path);
		if (had) this.trigger("changed", path);
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
		this.trigger("changed", null);
		return true;
	}

	/** Record a review-state write straight away, before the metadata cache catches up. */
	setNeedsReview(path: string, value: boolean): void {
		const e = this.entries.get(path);
		if (!e || e.needsReview === value) return;
		e.needsReview = value;
		this.trigger("changed", path);
	}

	private async compute(file: TFile, data?: string): Promise<void> {
		const settings = this.getSettings();
		const drop = () => {
			this.entries.delete(file.path);
			this.headings.delete(file.path);
		};
		if (file.extension !== "md" || !this.inFolder(file.path)) return drop();
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return drop();
		const tags = getAllTags(cache) ?? [];
		if (settings.membershipTag.trim() && !hasTag(tags, settings.membershipTag)) return drop();
		const period = classifyNote(file.basename, tags, settings);
		if (!period) return drop();
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

	/** Every section heading in the notes, with how many notes use it, most used first. */
	headingIndex(): [string, number][] {
		const counts = new Map<string, number>();
		for (const list of this.headings.values()) {
			for (const h of new Set(list)) counts.set(h, (counts.get(h) ?? 0) + 1);
		}
		return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	}
}
