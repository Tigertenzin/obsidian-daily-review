import { mergeSettings, Settings } from "../src/core/settings";

/** An example setup used by most tests: tagged notes, three item types. */
export function example(): Settings {
	const s = mergeSettings({ folder: "Journal", membershipTag: "journal", titlePrefixMatch: true });
	s.kinds.daily.titleFormat = "YYYY-MM-DD ddd";
	s.kinds.daily.missingStatus = "reviewed";
	s.kinds.monthly.titleFormat = "YYYY-MM MMM";
	s.kinds.quarterly.enabled = false;
	Object.assign(s.kinds.yearly, {
		titleFormat: "[Year ]YYYY", statusField: "status", reviewedValue: "done", canMarkReviewed: false,
	});
	s.itemTypes = [
		{ id: "work", label: "Work", color: "#4f8fe8", headings: ["work log"], match: "contains", enabled: true, domainLabels: {} },
		{ id: "fun", label: "Fun", color: "#38a169", headings: ["fun"], match: "contains", enabled: true, domainLabels: {} },
		{ id: "media", label: "Media", color: "#a36ee8", headings: ["media"], match: "contains", enabled: true,
			domainLabels: { "example.com": "Shows" } },
	];
	return s;
}
