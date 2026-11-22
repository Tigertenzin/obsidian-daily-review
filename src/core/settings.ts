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
	/** Remembered view state. */
	showReviewed: boolean;
	sort: SortMode;
}

export const OTHER_ID = "other";

export const DEFAULT_SETTINGS: Settings = {
	folder: "01 - Daily",
	membershipTag: "daily",
	kinds: {
		daily: {
			enabled: true, tag: "", titleFormat: "YYYY-MM-DD ddd", missingStatus: "reviewed",
			statusField: "", reviewedValue: "", canMarkReviewed: true,
		},
		weekly: {
			enabled: true, tag: "weekly", titleFormat: "GGGG-[W]WW", missingStatus: "unreviewed",
			statusField: "", reviewedValue: "", canMarkReviewed: true,
		},
		monthly: {
			enabled: true, tag: "monthly", titleFormat: "YYYY-MM MMM", missingStatus: "unreviewed",
			statusField: "", reviewedValue: "", canMarkReviewed: true,
		},
		quarterly: {
			enabled: false, tag: "quarterly", titleFormat: "YYYY-[Q]Q", missingStatus: "unreviewed",
			statusField: "", reviewedValue: "", canMarkReviewed: true,
		},
		yearly: {
			enabled: true, tag: "yearly", titleFormat: "[✱ ]YYYY", missingStatus: "unreviewed",
			statusField: "projectStatus", reviewedValue: "completed", canMarkReviewed: false,
		},
	},
	titlePrefixMatch: true,
	statusField: "dailyNotetStatus",
	unreviewedValue: "false",
	sectionLevel: 2,
	itemTypes: [
		{
			id: "work", label: "Work", color: "#4f8fe8", headings: ["stuff i did today"],
			match: "contains", enabled: true, domainLabels: {},
		},
		{
			id: "fun", label: "Fun", color: "#38a169", headings: ["fun stuff"],
			match: "contains", enabled: true, domainLabels: {},
		},
		{
			id: "media", label: "Media to return to", color: "#a36ee8", headings: ["media"],
			match: "contains", enabled: true,
			domainLabels: {
				"anilist.co": "Manga",
				"mangadex.org": "Manga",
				"store.steampowered.com": "Video Games",
				"steampowered.com": "Video Games",
			},
		},
	],
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
	showReviewed: false,
	sort: "oldest",
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
	return out;
}
