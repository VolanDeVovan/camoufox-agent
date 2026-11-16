// Regression tests for bugs found in review: each failed before its fix.
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { cleanupTemps, fixture, sleep, startSession, tempDir, type Fixture, type TestSession } from "./helpers.js";

let site: Fixture;
let s: TestSession;
let cwd: string;
let profilesDir: string;

beforeAll(async () => {
  site = await fixture({
    "/": "<title>Home</title><a href='/next?session_token=LINKSECRET&page=2'>Next</a>",
    "/callback": "<title>Callback</title>done",
    "/store": `<title>Store</title><script>localStorage.setItem("user", JSON.stringify({ name: "ann", accessToken: "opaque-secret-value" }));</script>`,
    "/frames": `<title>Frames</title><iframe src="/inner?n=first" title="First" width="300" height="80"></iframe>
      <div id="wrap"><iframe src="/inner?n=second" title="Second" width="300" height="80"></iframe></div>
      <div style="position:relative"><iframe src="/inner?n=covered" title="Covered" width="300" height="80"></iframe>
        <div id="banner" style="position:absolute; inset:0; background:#fffc">Cookie banner</div></div>`,
    "/inner": (req, res) => {
      const n = new URL(req.url!, "http://x").searchParams.get("n");
      res.setHeader("content-type", "text/html");
      res.end(`<button onclick="document.title='clicked'">Button ${n}</button>`);
    },
  });
  cwd = tempDir("cfa-cwd-");
  profilesDir = tempDir();
  s = await startSession({ profilesDir, cwd });
});
afterAll(async () => {
  await s.close();
  await site.close();
  await cleanupTemps();
});

test("tokens in URLs are masked in navigate, tabs_context and link targets", async () => {
  const nav = await s.call("navigate", { url: site.base + "/callback?code=OAUTHCODE123&state=xyz#access_token=FRAGSECRET" });
  expect(nav.text).not.toContain("OAUTHCODE123");
  expect(nav.text).not.toContain("FRAGSECRET");
  expect(nav.text).toContain("/callback?code=***");
  const ctx = await s.call("tabs_context");
  expect(ctx.text).not.toContain("OAUTHCODE123");
  expect((await s.call("cookies", {})).text).not.toContain("OAUTHCODE123");
  await s.call("navigate", { url: site.base + "/" });
  const page = await s.call("read_page");
  expect(page.text).toContain("session_token=***(10 chars)&page=2");
  expect((await s.call("read_page", { reveal_values: true })).text).toContain("LINKSECRET");
});

test("a credential inside a JSON value of web_storage is masked", async () => {
  await s.call("navigate", { url: site.base + "/store" });
  const r = await s.call("web_storage", {});
  expect(r.text).not.toContain("opaque-secret-value");
  expect(r.text).toContain("ann");
});

test("frames are matched to their iframe elements, and a frame under a top-level overlay is refused", async () => {
  await s.call("navigate", { url: site.base + "/frames" });
  const page = await s.call("read_page");
  expect(page.text).toMatch(/iframe "First" f\d+\n\s+button "Button first"/);
  expect(page.text).toMatch(/iframe "Second" f\d+\n\s+button "Button second"/);
  const wrap = (await s.call("find", { query: "Button second" })).text.match(/button "Button second" (f\d+e\d+)/)![1];
  const covered = (await s.call("find", { query: "Button covered" })).text.match(/button "Button covered" (f\d+e\d+)/)![1];
  const refused = await s.call("computer", { action: "left_click", ref: covered });
  expect(refused.isError).toBe(true);
  expect(refused.text).toMatch(/inside a frame that is covered by <div#banner> "Cookie banner"/);
  const ok = await s.call("computer", { action: "left_click", ref: wrap });
  expect(ok.isError, ok.text).toBe(false);
});

test("a page with a busy main thread does not block opening tabs or wedge the session", async () => {
  await s.call("navigate", { url: site.base + "/" });
  const busy = await s.call("javascript_tool", { text: "const t = Date.now(); while (Date.now() - t < 8000); 1", timeout_s: 1 });
  expect(busy.isError).toBe(true);
  const started = Date.now();
  const opened = await s.call("tabs_create", { url: site.base + "/callback" });
  expect(opened.isError, opened.text).toBe(false);
  expect(Date.now() - started).toBeLessThan(7500);
  expect((await s.call("read_page")).text).toContain("Callback");
  // Once the busy page wakes up, the tab it was asked for (and given up on) appears;
  // it is closed, and the tab that was opened instead stays this session's.
  await sleep(Math.max(0, started + 9000 - Date.now()));
  const ctx = (await s.call("tabs_context")).text;
  expect(ctx).not.toContain("about:blank");
  expect(ctx).not.toContain("free tabs");
  expect(ctx).toMatch(/\/callback\s+<- active/);
});

test("a blank tab a tool opened for a session without tabs is the one tabs_create takes", async () => {
  const t = await startSession({ profilesDir });
  try {
    await t.call("cookies");
    const opened = await t.call("tabs_create", { url: site.base + "/callback" });
    expect(opened.isError, opened.text).toBe(false);
    const ctx = (await t.call("tabs_context")).text;
    expect(ctx).not.toContain("about:blank");
    expect(ctx.match(/^\s+\d+\s+default/gm)).toHaveLength(1);
  } finally {
    await t.close();
  }
});

test("export_har makes an existing file private; cookies domain filter is a domain match", async () => {
  const target = join(cwd, "out.har");
  writeFileSync(target, "old");
  chmodSync(target, 0o644);
  const r = await s.call("export_har", { path: "out.har" });
  expect(r.isError, r.text).toBe(false);
  expect(statSync(target).mode & 0o777).toBe(0o600);
  await s.call("cookies", { action: "set", name: "a", value: "1", domain: "example.com" });
  await s.call("cookies", { action: "set", name: "b", value: "1", domain: "notexample.com" });
  const list = await s.call("cookies", { domain: "example.com" });
  expect(list.text).toContain("a=");
  expect(list.text).not.toContain("notexample.com");
});
