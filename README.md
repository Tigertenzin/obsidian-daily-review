# Periodic Note Review

An Obsidian plugin for working through a backlog of periodic notes (daily, weekly, monthly,
yearly). It shows one note at a time, lists that note's **open items** grouped by type, and
marks the note reviewed once you've dealt with them.

> **Status:** early development. There is no release yet, so the plugin can't be installed
> until the first version is published.

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
  one line, and moves on to the next note. If items are still open, it asks first.
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

## Development

Not set up yet. The plan: TypeScript and esbuild, from the official Obsidian sample plugin,
with the note-parsing logic kept in pure functions and unit-tested with vitest.

## License

MIT
