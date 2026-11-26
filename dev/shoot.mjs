/**
 * Visual check in WebKit (the engine Obsidian uses on iPhone and iPad).
 *
 *   node dev/shoot.mjs [filter]
 *
 * Builds dev/harness into dev/.local, serves it, and saves screenshots of each scenario to
 * dev/.local/shots/. Needs dev/.local/app.css: Obsidian's stylesheet, copied from the app
 * (it is not committed). Pass a filter to only run scenarios whose name contains it.
 * THEME=<name> also loads dev/.local/themes/<name>.css, a community theme's theme.css.
 */
import esbuild from "esbuild";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { webkit } from "playwright";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "dev/.local");
const shots = join(out, "shots");
mkdirSync(shots, { recursive: true });
if (!existsSync(join(out, "app.css"))) {
	console.error("dev/.local/app.css is missing: copy app.css out of Obsidian's obsidian.asar first.");
	process.exit(1);
}

await esbuild.build({
	entryPoints: [join(root, "dev/harness/main.ts")],
	bundle: true,
	format: "esm",
	target: "es2022",
	outfile: join(out, "harness.js"),
	alias: { obsidian: join(root, "dev/harness/obsidian-mock.ts") },
	logLevel: "warning",
});
copyFileSync(join(root, "dev/harness/index.html"), join(out, "index.html"));
copyFileSync(join(root, "styles.css"), join(out, "styles.css"));

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
	const path = join(out, decodeURIComponent(new URL(req.url, "http://x").pathname));
	if (!path.startsWith(out) || !existsSync(path)) {
		res.writeHead(404).end();
		return;
	}
	res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
	res.end(readFileSync(path));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/index.html`;

const sizes = [
	{ name: "phone-folded", device: "phone", width: 390, height: 720, scale: 2 },
	{ name: "phone-unfolded", device: "phone", width: 820, height: 580, scale: 2 },
	{ name: "tablet", device: "tablet", width: 1024, height: 768, scale: 2 },
	{ name: "desktop", device: "desktop", width: 1280, height: 800, scale: 1 },
];

const mark = ".pnr-actions .pnr-mark";
const states = [
	{ name: "initial", run: async () => {} },
	{ name: "armed", run: async (p) => { await p.click(mark); await p.waitForTimeout(1500); } },
	{ name: "undo", run: async (p) => { await p.click(mark); await p.waitForTimeout(300); await p.click(mark); await p.waitForTimeout(1800); } },
	{ name: "filters-open", only: (s) => s.width < 900, run: async (p) => { await p.click(".pnr-filter-toggle"); await p.waitForTimeout(300); } },
	{ name: "filtered", only: (s) => s.width < 900, run: async (p) => {
		await p.click(".pnr-filter-toggle");
		await p.evaluate(() => document.querySelectorAll(".pnr-type-row")[1].querySelectorAll(".pnr-seg")[1].click());
		await p.waitForTimeout(300);
	} },
	// The note with the most open items: long enough to scroll under the navigation bar.
	{ name: "long-note", run: async (p) => {
		await p.evaluate(() => {
			const all = [...window.pnr.store.entries.values()].sort((a, b) => b.open - a.open);
			window.pnr.view.goTo(all[0].path);
		});
		await p.waitForTimeout(400);
	} },
	// The queue, with the future notes under "Upcoming" unfolded.
	{ name: "upcoming", run: async (p) => {
		if (await p.$(".pnr-view.is-narrow")) await p.click(".pnr-queue-toggle");
		await p.waitForTimeout(250);
		await p.click(".pnr-future-toggle");
		await p.waitForTimeout(300);
	} },
	// The same note scrolled part way, so the page passes under the top bar.
	{ name: "scrolled", run: async (p) => {
		await p.evaluate(() => {
			const all = [...window.pnr.store.entries.values()].sort((a, b) => b.open - a.open);
			window.pnr.view.goTo(all[0].path);
		});
		await p.waitForTimeout(400);
		await p.evaluate(() => { document.querySelector(".pnr-main").scrollTop = 150; });
		await p.waitForTimeout(200);
	} },
	// Scraps below yesterday's daily note.
	{ name: "scraps-below", run: async (p) => {
		await p.evaluate(() => {
			const { view, store, dayName } = window.pnr;
			view.goTo(store.pageKeyFor("pnr-day:" + dayName(1)));
		});
		await p.waitForTimeout(400);
		await p.evaluate(() => {
			const main = document.querySelector(".pnr-main");
			const pile = document.querySelector(".pnr-scraps");
			main.scrollTop = pile.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 80;
		});
		await p.waitForTimeout(200);
	} },
	// A day with scraps and no daily note.
	{ name: "scraps-alone", run: async (p) => {
		await p.evaluate(() => window.pnr.view.goTo("pnr-day:" + window.pnr.dayName(6)));
		await p.waitForTimeout(400);
	} },
	// The queue with scraps below their notes.
	{ name: "scraps-queue", only: (s) => s.width < 900, run: async (p) => {
		await p.click(".pnr-queue-toggle");
		await p.waitForTimeout(300);
	} },
	// One icon per scrap in the queue, in each folder's colour.
	{ name: "scraps-queue-each", query: "&pile=each", run: async (p) => {
		if (await p.$(".pnr-view.is-narrow")) await p.click(".pnr-queue-toggle");
		await p.waitForTimeout(300);
	} },
	// One extra folder hidden (desktop: chips; narrow: the filter panel).
	{ name: "scraps-folder-hidden", run: async (p) => {
		if (await p.$(".pnr-view.is-narrow")) {
			await p.click(".pnr-filter-toggle");
			await p.waitForTimeout(200);
			await p.evaluate(() => [...document.querySelectorAll(".pnr-seg")].find((b) => b.textContent === "Hide" && b.closest(".pnr-type-row")?.textContent.includes("Call notes")).click());
		} else {
			await p.evaluate(() => [...document.querySelectorAll(".pnr-folder-chip")].find((b) => b.textContent.includes("Call notes")).click());
		}
		await p.waitForTimeout(500);
	} },
	// Scraps as their own pages: one scrap, and the queue.
	{ name: "scraps-pages", layout: "pages", run: async (p) => {
		await p.evaluate(() => {
			const { view, store, dayName } = window.pnr;
			const first = [...store.pages.values()].find((e) => e.note === null && e.start === dayName(1));
			view.goTo(first.path);
		});
		await p.waitForTimeout(400);
	} },
	// A reviewed daily note left off the page while its scrap isn't.
	{ name: "scraps-hidden-note", run: async (p) => {
		await p.evaluate(() => window.pnr.view.goTo(window.pnr.store.pageKeyFor("pnr-day:" + window.pnr.dayName(4))));
		await p.waitForTimeout(400);
	} },
	// Settings tabs (the review page isn't shown).
	{ name: "settings-extra", query: "&settings=extra", only: (s) => s.device !== "tablet", run: async (p) => { await p.waitForTimeout(500); } },
	{ name: "settings-notes", query: "&settings=notes", only: (s) => s.device === "desktop", run: async (p) => { await p.waitForTimeout(500); } },
	{ name: "scraps-pages-queue", layout: "pages", only: (s) => s.width < 900, run: async (p) => {
		await p.click(".pnr-queue-toggle");
		await p.waitForTimeout(300);
	} },
];

const filter = process.argv[2] ?? "";
const themeQuery = process.env.THEME ? `&css=${encodeURIComponent(process.env.THEME)}` : "";
const browser = await webkit.launch();
const errors = [];
for (const size of sizes) {
	for (const state of states) {
		const name = `${size.name}-${state.name}`;
		if (filter && !name.includes(filter)) continue;
		if (state.only && !state.only(size)) continue;
		const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale });
		page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
		page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(`${name}: ${m.text()}`));
		const layout = state.layout ? `&layout=${state.layout}` : "";
		await page.goto(`${base}?device=${size.device}${themeQuery}${layout}${state.query ?? ""}`);
		await page.waitForFunction(() => window.pnrReady === true, null, { timeout: 10000 });
		await page.waitForTimeout(300);
		await state.run(page);
		if (state.query?.includes("settings")) {
			// Settings: grow the window to the page's height (WebKit doesn't repaint a scrolled page here).
			const h = await page.evaluate(() => Math.ceil(document.querySelector(".pnr-harness-settings").getBoundingClientRect().height) + 40);
			await page.setViewportSize({ width: size.width, height: h });
			await page.waitForTimeout(300);
		}
		await page.screenshot({ path: join(shots, `${name}.png`) });
		console.log("saved", `dev/.local/shots/${name}.png`);
		await page.close();
	}
}
await browser.close();
server.close();
if (errors.length) {
	console.error("Page errors:\n" + errors.join("\n"));
	process.exit(1);
}
