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
		await page.goto(`${base}?device=${size.device}${themeQuery}`);
		await page.waitForFunction(() => window.pnrReady === true, null, { timeout: 10000 });
		await page.waitForTimeout(300);
		await state.run(page);
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
