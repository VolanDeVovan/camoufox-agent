// does the pinned launcher + playwright-core launch Camoufox here?
import { firefox } from "playwright-core";
import { launchOptions } from "camoufox";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const headless = process.argv[2] !== "headed";
const dir = mkdtempSync(join(tmpdir(), "cfa-r3-"));
const t0 = Date.now();
const opts = await launchOptions({ headless, humanize: 0.5, main_world_eval: true });
console.log("options keys:", Object.keys(opts), "args:", opts.args, "in", Date.now() - t0, "ms");
console.log("prefs sample:", Object.keys(opts.firefoxUserPrefs || opts.firefox_user_prefs || {}).length);
const ctx = await firefox.launchPersistentContext(dir, { ...opts, viewport: null });
console.log("launched in", Date.now() - t0, "ms; pages:", ctx.pages().length);
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("data:text/html,<title>hi</title><h1>hello</h1>");
console.log("title:", await page.title(), "ua:", await page.evaluate("navigator.userAgent"));
console.log("mw:", await page.evaluate("mw:document.title").catch((e) => "ERR " + e.message));
await ctx.close();
console.log("closed OK");
