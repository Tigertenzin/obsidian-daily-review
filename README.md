# Periodic Note Review

An Obsidian plugin for working through a backlog of periodic notes (daily, weekly, monthly,
yearly). It shows one note at a time, lists that note's **open items** grouped by type, and
marks the note reviewed once you've dealt with them.

> **Status:** early development (0.x). Expect rough edges, and please report what breaks.

## What it does

- **A review queue.** Finds every periodic note in your notes folder that still needs
  review, sorted oldest first, with filters for weekdays, weekends, weekly, monthly and
  yearly notes, and notes 7+ days old.
- **One note per page.** Renders the note the way Obsidian does, with query blocks
  (`tasks`, `dataview`) and navigation lines stripped out so you see only that day's
  content.
- **Open items, colour-coded.** Unchecked items are highlighted by *item type*, each with
  its own colour. An item's type comes from the section heading it sits under, so for
  example everything under a "Work" heading counts as Work.
- **A queue at a glance.** The notes still to review are listed beside the page, each
  showing how many open items it has left, and of which types.
- **Mark reviewed.** Sets the note's status field in its frontmatter, changing only that
  one line, and moves on to the next note. It always asks first, and says how many items
  are still open.
- **Check items off in place.** Click a checkbox on the page to check or uncheck it in
  the note.
- **Keyboard and touch.** `←`/`→` move through the queue on desktop; swipe left and right
  on mobile. An "Open note" button opens the note in the normal editor. Every action is
  also a command, so it can be given a hotkey.

Start it from the command palette with **Periodic Note Review: Open daily review**.

Folders, tags, frontmatter fields, title formats and item types are all settings, so the
plugin should fit any vault that keeps periodic notes with a review flag.

## Installing with BRAT

Until the plugin is in the community store, install it with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable **BRAT** from Community plugins.
2. Run the command **BRAT: Add a beta plugin for testing**.
3. Paste `https://github.com/Tigertenzin/obsidian-daily-review` and confirm.
4. Enable **Periodic Note Review** under Community plugins.

BRAT checks for new releases and updates the plugin for you.

## Settings

Out of the box it looks for notes titled `2026-11-22`, `2026-W47`, `2026-11`, `2026-Q4`
and `2026` anywhere in the vault, and treats a note as unreviewed until its frontmatter
has `reviewed: true`. Every part of that can be changed:

- **Notes:** the folder and tag that mark a note as periodic, and each kind's tag and
  title format (moment.js syntax). Every kind (daily, weekly, monthly, quarterly, yearly)
  can be included in or left out of the review.
- **Review state:** the frontmatter field to read and write, and what a missing field means.
- **Item types:** an ordered list. Each type has a label, a colour and heading patterns.
  A live preview shows which headings in your notes each type matches, and which
  headings count as Other.
- **The page:** how open items are highlighted (tint, bar, checkbox or nothing), which
  code block languages to hide (queries like `tasks` and `dataview`), and whether
  checkboxes can be ticked from the page. Items carrying the task tag are toggled through
  the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) plugin when it's
  installed, so its done dates and recurrence apply.

## Development

```sh
npm install
npm test            # unit tests for the parsing core (vitest)
npm run build       # type-check and build main.js
OUT_DIR=/path/to/vault/.obsidian/plugins/periodic-note-review npm run dev   # watch build
```

The parsing logic lives in `src/core/` as pure functions with no Obsidian dependencies
beyond `moment`; the view, store and settings tab are in `src/`.

To release: `npm version patch` (updates `manifest.json` and `versions.json`), push the
tag, and attach `main.js`, `manifest.json` and `styles.css` to a GitHub release named
after the version.

## License

MIT
