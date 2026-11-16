// app-id, focus on new window, window.open from the isolated world, tab selection.
// Also: screenshot / rAF / timers in an unfocused window and a background tab.
import { firefox } from "playwright-core";
import { launchOptions } from "camoufox";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const srv = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end(`<title>${q.url}</title>page ${q.url}`); }).listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;
const niri = () => JSON.parse(execFileSync("niri", ["msg", "-j", "windows"], { encoding: "utf8" }));
const show = (label) => {
  const ws = niri();
  console.log(label, ws.map((w) => `${w.id}:${w.app_id}${w.is_focused ? "*FOCUSED*" : ""}[ws${w.workspace_id}]`).join("  "));
  return ws;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keepForeground = process.argv.includes("foreground");
const prefs = process.argv.includes("prefs") ? {
  "widget.windows.window_occlusion_tracking.enabled": false,
  "dom.min_background_timeout_value": 4,
  "dom.timeout.enable_budget_timer_throttling": false,
  "layout.throttled_frame_rate": 60, "widget.wayland.vsync.enabled": false,
} : {};

show("before:");
const dir = mkdtempSync(join(tmpdir(), "cfa-r4-"));
const opts = await launchOptions({ headless: false, os: "linux", humanize: 0.5, main_world_eval: true, firefox_user_prefs: prefs });
const ctx = await firefox.launchPersistentContext(dir, {
  ...opts, viewport: null, ...(keepForeground ? {} : { ignoreDefaultArgs: ["-foreground"] }),
});
for (let i = 0; i < 4; i++) { await sleep(500); show(`t+${(i + 1) * 500}ms:`); }
const page = ctx.pages()[0];
await page.goto(base + "/first");
const before = niri().length;
const appeared = new Promise((res) => ctx.once("page", res));
await page.evaluate(`(function(){ window.open("about:blank","_blank","noopener,noreferrer"); return 1; })()`);
const p2 = await Promise.race([appeared, sleep(5000).then(() => null)]);
await sleep(800);
console.log("window.open gave page:", !!p2, "niri windows before/after:", before, niri().length);
show("after window.open:");
await p2.goto(base + "/second");
const vis = async () => console.log("visibility first/second:", await page.evaluate("document.visibilityState"), await p2.evaluate("document.visibilityState"),
  "| niri title:", niri().filter((w) => w.app_id === "camoufox").map((w) => w.title));
await vis();
await page.bringToFront();
await sleep(800);
show("after bringToFront(first):");
await vis();

const probe = async (p, label) => {
  const t = Date.now();
  const r = await Promise.race([p.evaluate(`new Promise((res) => { const t0 = performance.now(); let frames = 0, ticks = 0;
      const raf = () => { frames++; requestAnimationFrame(raf); }; requestAnimationFrame(raf);
      const iv = setInterval(() => ticks++, 50);
      setTimeout(() => { clearInterval(iv); res({ frames, ticks, ms: Math.round(performance.now() - t0) }); }, 1000); })`), sleep(8000).then(() => "STALLED >8s")]);
  const t1 = Date.now();
  const shot = await Promise.race([p.screenshot().then((b) => b.length + " bytes", (e) => "ERR " + e.message.split("\n")[0]), sleep(8000).then(() => "STALLED >8s")]);
  const t2 = Date.now();
  const mv = await Promise.race([p.mouse.move(300, 300).then(() => p.mouse.move(600, 400)).then(() => "ok"), sleep(8000).then(() => "STALLED >8s")]);
  console.log(label, "raf/timers:", JSON.stringify(r), `(${t1 - t}ms)`, "| screenshot:", shot, `(${t2 - t1}ms)`, "| mouse:", mv, `(${Date.now() - t2}ms)`);
};
await probe(page, "visible tab, window on current workspace:");
await probe(p2, "background tab:");
if (process.argv.includes("move")) {
  const id = niri().find((w) => w.app_id === "camoufox").id;
  const wss = JSON.parse(execFileSync("niri", ["msg", "-j", "workspaces"], { encoding: "utf8" }));
  const cur = niri().find((w) => w.id === id).workspace_id;
  const curWs = wss.find((w) => w.id === cur);
  const other = wss.find((w) => w.output === curWs.output && w.id !== cur);
  execFileSync("niri", ["msg", "action", "move-window-to-workspace", "--window-id", String(id), "--focus", "false", String(other.idx)]);
  await sleep(1000);
  show("moved to hidden workspace:");
  await probe(page, "visible tab, HIDDEN workspace:");
  await probe(p2, "background tab, HIDDEN workspace:");
}
await ctx.close();
srv.close();
show("closed:");
