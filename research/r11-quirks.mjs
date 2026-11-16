// Camoufox quirks on the pinned build.
import { firefox } from "playwright-core";
import { launchOptions } from "camoufox";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
const srv = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end(`<title>${q.url}</title><body style="height:5000px">page ${q.url}<div id=sc style="height:200px;overflow:auto"><div style="height:3000px">inner</div></div>`); }).listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withPrefs = !process.argv.includes("noprefs");
const opts = await launchOptions({ headless: true, os: "linux", humanize: 0.5, main_world_eval: true,
  firefox_user_prefs: withPrefs ? { "browser.sessionhistory.max_entries": 50 } : {} });
const ctx = await firefox.launchPersistentContext(mkdtempSync(join(tmpdir(), "cfa-r11-")), { ...opts, viewport: null, ignoreDefaultArgs: ["-foreground"] });
const first = ctx.pages()[0];
await first.goto(base + "/0", { waitUntil: "commit" });
// 1. load events after the 5th page
for (let i = 1; i <= 8; i++) {
  const appeared = new Promise((res) => ctx.once("page", res));
  await first.evaluate(`(function(){ window.open("about:blank","_blank","noopener,noreferrer"); return 1; })()`);
  const p = await appeared;
  const t = Date.now();
  const r = await p.goto(base + "/p" + i, { waitUntil: "load", timeout: 6000 }).then(() => "load ok", (e) => "load ERR " + e.message.split("\n")[0]);
  console.log(`page ${i + 1}: ${r} (${Date.now() - t}ms) readyState=${await p.evaluate("document.readyState")}`);
}
// 2. history
const p = ctx.pages()[1];
await p.goto(base + "/h1", { waitUntil: "commit" }); await sleep(300);
await p.goto(base + "/h2", { waitUntil: "commit" }); await sleep(300);
const back = await p.goBack({ waitUntil: "commit", timeout: 5000 }).then((r) => "resp=" + !!r, (e) => "ERR " + e.message.split("\n")[0]);
await sleep(500);
console.log("goBack:", back, "url now:", p.url(), "history.length:", await p.evaluate("history.length"));
// 3. wheel
await p.goto(base + "/wheel", { waitUntil: "commit" }); await sleep(500);
await p.mouse.move(400, 400);
await p.mouse.wheel(0, 600); await sleep(800);
console.log("after wheel(0,600): scrollY =", await p.evaluate("window.scrollY"));
// 4. y in [0,1)
const t = Date.now();
const mv = await Promise.race([p.mouse.move(200, 0.5).then(() => "answered"), sleep(6000).then(() => "NO ANSWER in 6s")]);
console.log("mouse.move(y=0.5):", mv, `(${Date.now() - t}ms)`);
const alive = await Promise.race([p.evaluate("1+1"), sleep(4000).then(() => "tab wedged")]);
console.log("tab after that:", alive);
await Promise.race([ctx.close(), sleep(8000)]);
srv.close(); process.exit(0);
