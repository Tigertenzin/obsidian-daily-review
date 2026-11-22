# Daily Review

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
- **Loose ends.** Lists the note's unchecked items, grouped by *item type*. An item's type
  comes from the section heading it sits under. For example everything under
  "Stuff I Did Today" counts as Work, and everything under "The Fun Stuff" counts as Fun.
- **Mark reviewed.** One click (or Enter twice) sets the note's status field in its
  frontmatter, changing only that one line, and moves on to the next note.
- **Keyboard first.** `←`/`→` (or `k`/`j`) move through the queue, Enter marks the note
  reviewed, `o` opens it in the editor. Every action is also a command, so it can be given a
  hotkey or used on mobile.

Folders, tags, frontmatter fields, title formats and item types are all settings, so the
plugin should fit any vault that keeps periodic notes with a review flag.

## Installing with BRAT

Until the plugin is in the community store, install it with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable **BRAT** from Community plugins.
2. Run the command **BRAT: Add a beta plugin for testing**.
3. Paste `https://github.com/Tigertenzin/obsidian-daily-review` and confirm.
4. Enable **Daily Review** under Community plugins.

BRAT checks for new releases and updates the plugin for you.

## Development

Not set up yet. The plan: TypeScript and esbuild, from the official Obsidian sample plugin,
with the note-parsing logic kept in pure functions and unit-tested with vitest.

## License

MIT
