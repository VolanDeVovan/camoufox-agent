// R8: do session cookies survive a restart with session restore on; are restored tabs closable?
import { firefox } from "playwright-core";
import { launchOptions } from "camoufox";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
const srv = http.createServer((q, s) => {
  if (q.url === "/login") s.setHeader("set-cookie", ["sess=abc123; Path=/; HttpOnly", "persist=1; Path=/; Max-Age=86400"]);
  s.setHeader("content-type", "text/html"); s.end(`<title>${q.url}</title>cookie header: ${q.headers.cookie || "(none)"}`);
}).listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const restore = !process.argv.includes("norestore");
const prefs = restore ? {
  "browser.startup.page": 3,
  "browser.sessionstore.resume_from_crash": true,
  "browser.sessionstore.max_resumed_crashes": -1,
  "browser.sessionstore.privacy_level": 0,
  "browser.sessionstore.interval": 2000,
  "browser.startup.couldRestoreSession.count": 0,
  "browser.sessionstore.restore_on_demand": true,
  "browser.sessionstore.restore_tabs_lazily": true,
} : {};
const dir = mkdtempSync(join(tmpdir(), "cfa-r8-"));
const launch = async () => {
  const opts = await launchOptions({ headless: true, os: "linux", humanize: 0.5, firefox_user_prefs: prefs });
  return firefox.launchPersistentContext(dir, { ...opts, viewport: null, ignoreDefaultArgs: ["-foreground"] });
};
let ctx = await launch();
let page = ctx.pages()[0];
await page.goto(base + "/login");
await page.goto(base + "/after");
console.log("run 1:", await page.innerText("body"));
if (process.argv.includes("kill")) { await sleep(5000); /* let sessionstore flush */ }
else await sleep(500);
await ctx.close();
console.log("sessionstore files:", existsSync(join(dir, "sessionstore.jsonlz4")), existsSync(join(dir, "sessionstore-backups")) ? readdirSync(join(dir, "sessionstore-backups")) : []);
ctx = await launch();
await sleep(1500);
console.log("run 2 pages at launch:", ctx.pages().map((p) => p.url()));
const cookies = await ctx.cookies(base);
console.log("run 2 cookies:", cookies.map((c) => `${c.name} expires=${c.expires}`));
// close restored tabs, keep one
const pages = ctx.pages();
page = pages[0];
for (const p of pages.slice(1)) await p.close();
await page.goto(base + "/check");
console.log("run 2:", await page.innerText("body"), "| pages now:", ctx.pages().length);
await ctx.close(); srv.close(); process.exit(0);
