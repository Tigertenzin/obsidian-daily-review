export type Kind = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

/** Display order, and the tie-break order when two notes share an anchor date. */
export const KINDS: Kind[] = ["daily", "weekly", "monthly", "quarterly", "yearly"];

/** Kind tags are checked longest period first; a note with none of them is daily. */
export const KIND_TAG_ORDER: Kind[] = ["yearly", "quarterly", "monthly", "weekly"];

export type MissingStatus = "reviewed" | "unreviewed";
export type MatchMode = "contains" | "exact" | "regex";
export type UnknownMarks = "ignore" | "open" | "settled";
export type HighlightStyle = "tint" | "bar" | "checkbox" | "none";
export type SortMode = "oldest" | "newest" | "most-open" | "most-tasks";

export interface KindSettings {
	/** Whether notes of this kind are part of the review at all. */
	enabled: boolean;
	/** Tag that marks a note as this kind (without '#'). Unused for daily. */
	tag: string;
	/** moment.js format of the note's title. */
	titleFormat: string;
	/** What a note with no status field counts as. */
	missingStatus: MissingStatus;
	/** Overrides the shared status field for this kind (empty = use the shared one). */
	statusField: string;
	/**
	 * Value that means "reviewed" in this kind's own status field. Empty = the shared
	 * rule: anything other than the unreviewed value counts as reviewed.
	 */
	reviewedValue: string;
	/** Whether "Mark reviewed" can write to notes of this kind. */
	canMarkReviewed: boolean;
}

export interface ItemType {
	id: string;
	label: string;
	/** CSS colour. Empty = the theme's accent colour. */
	color: string;
	/** Patterns that pick out this type's section headings. */
	headings: string[];
	match: MatchMode;
	enabled: boolean;
	/** Optional `domain → label` map, shown as a small label on open items with a link. */
	domainLabels: Record<string, string>;
}

export interface OtherType {
	label: string;
	color: string;
	/** Hidden "Other" items still show on the page but aren't counted or highlighted. */
	hidden: boolean;
}

/** Where a day's extra notes go on the review page. */
export type ExtraLayout = "below" | "pages";

/**
 * A folder of extra notes ("scraps") with a date in their file name. Each one is shown
 * with the daily note for its date, and has its own review state.
 */
export interface ExtraFolder {
	id: string;
	/** Vault path of the folder; empty means the whole vault. */
	folder: string;
	/** Shown on the page and in the queue. Empty = the folder's own name. */
	label: string;
	/** CSS colour of the scrap's card. Empty = a theme yellow. */
	color: string;
	enabled: boolean;
	subfolders: boolean;
	/** moment.js format of the date in the file name. */
	dateFormat: string;
	/**
	 * The whole file name, as a regular expression in which `{date}` stands for the date.
	 * Without `{date}`, it is what may follow the date (the name starts with the date).
	 */
	pattern: string;
	/** Frontmatter field holding the review state. Empty = the daily notes' field. */
	statusField: string;
	missingStatus: MissingStatus;
	/** Type for items under no matching heading. Empty = Other. */
	defaultType: string;
}

export const DEFAULT_EXTRA_FOLDER: Omit<ExtraFolder, "id"> = {
	folder: "", label: "", color: "", enabled: true, subfolders: true, dateFormat: "YYYY-MM-DD",
	pattern: "{date}.*", statusField: "", missingStatus: "unreviewed", defaultType: "",
};

export interface Settings {
	folder: string;
	membershipTag: string;
	kinds: Record<Kind, KindSettings>;
	titlePrefixMatch: boolean;
	statusField: string;
	unreviewedValue: string;
	sectionLevel: number;
	itemTypes: ItemType[];
	other: OtherType;
	openMarks: string[];
	settledMarks: string[];
	unknownMarks: UnknownMarks;
	taskTag: string;
	hiddenBlockLanguages: string[];
	hideNavLine: boolean;
	hideTitleHeading: boolean;
	highlightStyle: HighlightStyle;
	allowCheckingItems: boolean;
	useTasksPlugin: boolean;
	showStatusBar: boolean;
	/** How the status bar count looks: icon and text, icon and number, or text only. */
	statusBarStyle: "icon-text" | "icon-number" | "text";
	/** Remembered view state. */
	showReviewed: boolean;
	/** Whether notes for periods that haven't started are listed when the review opens. */
	showFuture: boolean;
	sort: SortMode;
	extraFolders: ExtraFolder[];
	extraLayout: ExtraLayout;
}

export const OTHER_ID = "other";

/** Title formats tried, in this order, for a note that has no kind tag. */
export const KIND_TITLE_ORDER: Kind[] = ["daily", "weekly", "quarterly", "monthly", "yearly"];

/**
 * Generic defaults: Obsidian's own daily-note title format, ISO weeks, a "reviewed"
 * field that's missing until the note is reviewed, and no item types yet.
 */
export const DEFAULT_SETTINGS: Settings = {
	folder: "",
	membershipTag: "",
	kinds: {
		daily: {
			enabled: true, tag: "", titleFormat: "YYYY-MM-DD", missingStatus: "unreviewed",
			statusField: "", reviewedValue: "", canMarkReviewed: true,
		},
		weekly: {
			enabled: true, tag: "weekly", titleFormat: "GGGG-[W]WW", missingStatus: "unreviewed",
			statusField: "", reviewedValue: "", canMarkReviewed: true,
		},
		monthly: {
			enabled: true, tag: "monthly", titleFormat: "YYYY-MM", missingStatus: "unreviewed",
			statusField: "", reviewedValue: "", canMarkReviewed: true,
		},
		quarterly: {
			enabled: true, tag: "quarterly", titleFormat: "YYYY-[Q]Q", missingStatus: "unreviewed",
			statusField: "", reviewedValue: "", canMarkReviewed: true,
		},
		yearly: {
			enabled: true, tag: "yearly", titleFormat: "YYYY", missingStatus: "unreviewed",
			statusField: "", reviewedValue: "", canMarkReviewed: true,
		},
	},
	titlePrefixMatch: false,
	statusField: "reviewed",
	unreviewedValue: "false",
	sectionLevel: 2,
	itemTypes: [],
	other: { label: "Other", color: "#8a8f98", hidden: false },
	openMarks: [" "],
	settledMarks: ["x", "X", "-"],
	unknownMarks: "ignore",
	taskTag: "#task",
	hiddenBlockLanguages: ["tasks", "dataview", "dataviewjs"],
	hideNavLine: true,
	hideTitleHeading: true,
	highlightStyle: "tint",
	allowCheckingItems: true,
	useTasksPlugin: true,
	showStatusBar: true,
	statusBarStyle: "icon-text",
	showReviewed: false,
	showFuture: false,
	sort: "oldest",
	extraFolders: [],
	extraLayout: "below",
};

/** Deep-ish merge of saved data over the defaults, so new settings get their default. */
export function mergeSettings(saved: Partial<Settings> | null | undefined): Settings {
	const d = structuredClone(DEFAULT_SETTINGS);
	if (!saved) return d;
	const out: Settings = { ...d, ...saved } as Settings;
	out.kinds = { ...d.kinds };
	for (const k of KINDS) out.kinds[k] = { ...d.kinds[k], ...(saved.kinds?.[k] ?? {}) };
	out.other = { ...d.other, ...(saved.other ?? {}) };
	if (Array.isArray(saved.itemTypes)) {
		out.itemTypes = saved.itemTypes.map((t) => ({
			id: t.id, label: t.label ?? t.id, color: t.color ?? "", headings: t.headings ?? [],
			match: t.match ?? "contains", enabled: t.enabled ?? true, domainLabels: t.domainLabels ?? {},
		}));
	}
	if (Array.isArray(saved.extraFolders)) {
		out.extraFolders = saved.extraFolders.map((f, i) => ({ ...DEFAULT_EXTRA_FOLDER, ...f, id: f.id || `extra-${i}` }));
	}
	return out;
}
