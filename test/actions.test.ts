// Action replies: what separates this from raw Playwright (06-page-interaction.md).
// navigated / changed / opened tab / dialog / download / nothing; refusals.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { cleanupTemps, fixture, startSession, tempDir, type Fixture, type TestSession } from "./helpers.js";

let site: Fixture;
let s: TestSession;
let dir: string;
let cwd: string;

const PAGE = `<title>Actions</title>
<style>body { margin: 0; font: 16px sans-serif } button, a, input, select { display: inline-block; margin: 6px }</style>
<a id="nav" href="/landed">Go to landed</a>
<button id="change" onclick="document.getElementById('out').textContent += ' changed!'">Change page</button>
<button id="noop">Does nothing</button>
<a id="blank" href="/popup" target="_blank">Open in new tab</a>
<button id="ask" onclick="document.getElementById('out').textContent = 'answer:' + confirm('Really delete?')">Ask</button>
<button id="askname" onclick="document.getElementById('out').textContent = 'name:' + prompt('Your name?')">Ask name</button>
<a id="dl" href="/file.txt">Download file</a>
<button id="off" disabled>Disabled</button>
<div style="position:relative; display:inline-block">
  <button id="under" onclick="document.title='clicked-under'">Covered</button>
  <div id="overlay" class="modal backdrop" style="position:absolute; inset:0; background:rgba(0,0,0,.5)">Overlay</div>
</div>
<form action="/landed"><input id="q" name="q" placeholder="Search"><input type="password" id="pw" name="password"><button>Find</button></form>
<label><input type="checkbox" id="cb" onchange="document.getElementById('out').textContent = 'cb:' + this.checked"> Subscribe</label>
<select id="sel" aria-label="Colour" onchange="document.getElementById('out').textContent = 'sel:' + this.value"><option value="r">Red</option><option value="g">Green</option></select>
<input id="keys" placeholder="Key counter" onkeydown="this.dataset.n = (+this.dataset.n || 0) + 1">
<input type="file" id="up" onchange="document.getElementById('out').textContent = 'file:' + this.files[0].name + ':' + this.files[0].size">
<p id="out"></p>
<script>window.pageVar = 42;</script>
<div style="height:3000px"></div>
<button id="far">Far below</button>`;

beforeAll(async () => {
  site = await fixture({
    "/": PAGE,
    "/landed": "<title>Landed</title><h1>Landed</h1>",
    "/popup": "<title>Popup</title>popup",
    "/file.txt": (_req, res) => {
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", 'attachment; filename="report.txt"');
      res.end("downloaded content\n");
    },
  });
  dir = tempDir();
  cwd = tempDir("cfa-cwd-");
  s = await startSession({ profilesDir: dir, cwd });
});
afterAll(async () => {
  await s.close();
  await site.close();
  await cleanupTemps();
});

/** Open the fixture and return name -> ref. */
async function open(): Promise<Record<string, string>> {
  await s.call("navigate", { url: site.base + "/" });
  const page = await s.call("read_page");
  const refs: Record<string, string> = {};
  for (const m of page.text.matchAll(/^\s*\w+ "([^"]*)" ((?:f\d+)?e\d+)/gm)) refs[m[1]] = m[2];
  return refs;
}
const click = (ref: string) => s.call("computer", { action: "left_click", ref });
const js = async (code: string) => (await s.call("javascript_tool", { text: code })).text.split("\n").slice(1).join("\n");

test("click that navigates", async () => {
  const refs = await open();
  const r = await click(refs["Go to landed"]);
  expect(r.text).toMatch(/navigated to http:\/\/127\.0\.0\.1:\d+\/landed \(Landed\)/);
});

test("click that changes the page, and one that does nothing", async () => {
  const refs = await open();
  const changed = await click(refs["Change page"]);
  expect(changed.text).toMatch(/page changed \(.*text/);
  const nothing = await click(refs["Does nothing"]);
  expect(nothing.text).toContain("nothing happened within 1 s");
});

test("click that opens a tab reports its id, and the tab belongs to this session", async () => {
  const refs = await open();
  const r = await click(refs["Open in new tab"]);
  const id = Number(r.text.match(/opened tab (\d+)/)?.[1]);
  expect(id).toBeGreaterThan(0);
  const ctx = await s.call("tabs_context");
  expect(ctx.text).toMatch(new RegExp(`^\\s+${id}\\s+default\\s+"Popup"`, "m"));
  await s.call("tabs_close", { tabId: id });
});

test("a dialog is dismissed by default and the reply says so; handle_dialog arms an answer", async () => {
  const refs = await open();
  const r = await click(refs["Ask"]);
  expect(r.text).toContain('opened confirm dialog "Really delete?": dismissed (no handle_dialog answer was armed)');
  expect(await js("document.getElementById('out').textContent")).toBe("answer:false");
  await s.call("handle_dialog", { accept: true });
  const accepted = await click(refs["Ask"]);
  expect(accepted.text).toContain("accepted by the armed handle_dialog answer");
  expect(await js("document.getElementById('out').textContent")).toBe("answer:true");
  // One-shot: the next dialog is dismissed again.
  expect((await click(refs["Ask"])).text).toContain("dismissed (no handle_dialog");
  await s.call("handle_dialog", { accept: true, prompt_text: "Ada" });
  await click(refs["Ask name"]);
  expect(await js("document.getElementById('out').textContent")).toBe("name:Ada");
});

test("a download lands in the fixed directory and the reply names it", async () => {
  const refs = await open();
  const r = await click(refs["Download file"]);
  const m = r.text.match(/downloaded report\.txt \(19 B\) to (\S+)/);
  expect(m, r.text).toBeTruthy();
  expect(m![1].startsWith(join(dir, "..downloads", "camoufox-agent"))).toBe(true);
  expect(readFileSync(m![1], "utf8")).toBe("downloaded content\n");
});

test("disabled, hidden and covered elements are refused, nothing fired", async () => {
  const refs = await open();
  const disabled = await click(refs["Disabled"]);
  expect(disabled.isError).toBe(true);
  expect(disabled.text).toMatch(/is disabled\. Nothing was fired/);
  const covered = await click(refs["Covered"]);
  expect(covered.isError).toBe(true);
  expect(covered.text).toMatch(/is covered by <div#overlay\.modal\.backdrop> "Overlay"/);
  expect(await js("document.title")).toBe("Actions");
  // Hidden after it was listed.
  await js("document.getElementById('noop').style.display = 'none'; 1");
  const hidden = await click(refs["Does nothing"]);
  expect(hidden.isError).toBe(true);
  expect(hidden.text).toMatch(/is hidden/);
  // Removed after it was listed: a stale ref, not a guess.
  await js("document.getElementById('change').remove(); 1");
  const stale = await click(refs["Change page"]);
  expect(stale.isError).toBe(true);
  expect(stale.text).toContain("Call read_page again");
});

test("form_input sets text, checkboxes and selects; secrets are not echoed", async () => {
  const refs = await open();
  const t = await s.call("form_input", { ref: refs["Search"], value: "hello world" });
  expect(t.text).toContain('"hello world"');
  expect(await js("document.getElementById('q').value")).toBe("hello world");
  const pw = await s.call("form_input", { ref: refs["password"], value: "s3cret-pass" });
  expect(pw.text).not.toContain("s3cret-pass");
  expect(pw.text).toContain("***(11 chars)");
  expect(await js("document.getElementById('pw').value")).toBe("s3cret-pass");
  const cb = await s.call("form_input", { ref: refs["Subscribe"], value: true });
  expect(cb.text).toMatch(/Checked/);
  expect(await js("document.getElementById('out').textContent")).toBe("cb:true");
  expect((await s.call("form_input", { ref: refs["Subscribe"], value: true })).text).toContain("already checked");
  const sel = await s.call("form_input", { ref: refs["Colour"], value: "Green" });
  expect(sel.text).toContain('Selected "Green"');
  expect(await js("document.getElementById('out').textContent")).toBe("sel:g");
  const bad = await s.call("form_input", { ref: refs["Colour"], value: "Purple" });
  expect(bad.isError).toBe(true);
  expect(bad.text).toContain("Options: Red | Green");
});

test("type pastes by default and types key by key on request; key presses report navigation", async () => {
  const refs = await open();
  await s.call("computer", { action: "type", ref: refs["Key counter"], text: "abc" });
  expect(await js("document.getElementById('keys').value + '/' + (document.getElementById('keys').dataset.n || 0)")).toBe("abc/0");
  await s.call("computer", { action: "type", text: "def", per_key: true });
  expect(await js("document.getElementById('keys').value + '/' + document.getElementById('keys').dataset.n")).toBe("abcdef/3");
  await s.call("computer", { action: "key", text: "ctrl+a Backspace" });
  expect(await js("document.getElementById('keys').value")).toBe("");
  await s.call("computer", { action: "left_click", ref: refs["Search"] });
  await s.call("computer", { action: "type", text: "query" });
  const enter = await s.call("computer", { action: "key", text: "Enter" });
  expect(enter.text).toMatch(/navigated to .*\/landed\?q=query/);
});

test("screenshot coordinates map back to the page, also when scaled", async () => {
  await open();
  const shot = await s.call("computer", { action: "screenshot", scale: 0.5 });
  const image = shot.content.find((c) => c.type === "image");
  expect(image.mimeType).toBe("image/png");
  expect(Buffer.from(image.data, "base64").subarray(1, 4).toString()).toBe("PNG");
  const [w] = shot.text.match(/(\d+)x(\d+)/)!.slice(1).map(Number);
  const vw = Number(await js("window.innerWidth"));
  expect(Math.abs(w - vw / 2)).toBeLessThanOrEqual(1);
  // Click the "Change page" button by its position in the half-size image.
  const box = JSON.parse(await js("JSON.stringify(document.getElementById('change').getBoundingClientRect())"));
  const r = await s.call("computer", { action: "left_click", coordinate: [(box.x + box.width / 2) / 2, (box.y + box.height / 2) / 2] });
  expect(r.text).toMatch(/page changed/);
  const zoom = await s.call("computer", { action: "zoom", region: [0, 0, 200, 100] });
  expect(zoom.content.some((c) => c.type === "image")).toBe(true);
});

test("wheel scrolls, scroll_to brings a ref into view, and a pointer at y < 1 does not wedge the tab", async () => {
  const refs = await open();
  const r = await s.call("computer", { action: "scroll", scroll_direction: "down", scroll_amount: 5 });
  expect(r.text).toMatch(/scrolled to x=0, y=\d+/);
  expect(Number(await js("window.scrollY"))).toBeGreaterThan(200);
  expect(await js("document.getElementById('far').getBoundingClientRect().top > innerHeight")).toBe("true");
  await s.call("computer", { action: "scroll_to", ref: refs["Far below"] });
  // The viewport's size comes with the profile's device, so "in view" is the check, not a pixel count.
  expect(await js("(function () { var r = document.getElementById('far').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()")).toBe("true");
  const top = await s.call("computer", { action: "hover", coordinate: [50, 0.5] });
  expect(top.isError).toBe(false);
  expect(await js("1 + 1")).toBe("2");
});

test("javascript_tool: main world sees the page, isolated does not", async () => {
  await open();
  expect((await s.call("javascript_tool", { text: "window.pageVar" })).text).toMatch(/\n42$/);
  expect((await s.call("javascript_tool", { text: "typeof window.pageVar", world: "isolated" })).text).toMatch(/\nundefined$/);
  expect((await s.call("javascript_tool", { text: "const a = [1, 2]; a.map(x => x * 2)" })).text).toContain("[\n  2,\n  4\n]");
  expect((await s.call("javascript_tool", { text: "fetch('/landed').then(r => r.status)" })).text).toMatch(/\n200$/);
  const err = await s.call("javascript_tool", { text: "nope.nope" });
  expect(err.isError).toBe(true);
  expect(err.text).toContain("nope is not defined");
});

test("file_upload: paths under the working directory, or absolute and echoed", async () => {
  await open();
  writeFileSync(join(cwd, "inside.txt"), "12345");
  const fileRef = (await s.call("find", { role: "file" })).text.match(/file "[^"]*" (e\d+)/)![1];
  const up = await s.call("file_upload", { ref: fileRef, paths: ["inside.txt"] });
  expect(up.isError, up.text).toBe(false);
  expect(up.text).toContain(join(cwd, "inside.txt"));
  expect(await js("document.getElementById('out').textContent")).toBe("file:inside.txt:5");
  // A relative path may not leave the working directory.
  const outside = tempDir("cfa-outside-");
  writeFileSync(join(outside, "secret.txt"), "x");
  const escape = await s.call("file_upload", { ref: fileRef, paths: [relative(cwd, "/etc/passwd")] });
  expect(escape.isError).toBe(true);
  expect(escape.text).toContain("leaves the session's working directory");
  const tilde = await s.call("file_upload", { ref: fileRef, paths: ["~/.ssh/id_rsa"] });
  expect(tilde.isError).toBe(true);
  // An absolute path is the agent naming the file explicitly; it is echoed.
  const abs = await s.call("file_upload", { ref: fileRef, paths: [join(outside, "secret.txt")] });
  expect(abs.isError).toBe(false);
  expect(abs.text).toContain(join(outside, "secret.txt"));
  expect(existsSync(join(outside, "secret.txt"))).toBe(true);
});

test("browser_batch runs in order and stops at the first error", async () => {
  const r = await s.call("browser_batch", {
    actions: [
      { tool: "navigate", args: { url: site.base + "/landed" } },
      { tool: "navigate", args: { url: "http://127.0.0.1:9/" } },
      { tool: "navigate", args: { url: site.base + "/" } },
    ],
  });
  expect(r.isError).toBe(true);
  expect(r.text).toContain("[1/3] navigate:");
  expect(r.text).toContain("[2/3] navigate FAILED:");
  expect(r.text).toContain("1 step(s) were not run");
  expect((await s.call("tabs_context")).text).not.toMatch(/"Actions"/);
  const invalid = await s.call("browser_batch", { actions: [{ tool: "navigate", args: {} }] });
  expect(invalid.isError).toBe(true);
  expect(invalid.text).toContain("Nothing was run");
});

test("navigation still works after many pages in one browser", async () => {
  // Camoufox builds have stopped firing load events after the fifth page in a context.
  const ids: number[] = [];
  for (let i = 0; i < 7; i++) {
    const r = await s.call("tabs_create", { url: site.base + "/landed" });
    expect(r.isError, r.text).toBe(false);
    ids.push(Number(r.text.match(/Opened tab (\d+)/)![1]));
  }
  const last = await s.call("navigate", { url: site.base + "/" });
  expect(last.text).toContain("Actions");
  for (const id of ids) await s.call("tabs_close", { tabId: id });
});

test("resize_window changes the page area", async () => {
  await s.call("navigate", { url: site.base + "/landed" });
  const r = await s.call("resize_window", { width: 900, height: 600 });
  expect(r.isError, r.text).toBe(false);
  expect(await js("innerWidth + 'x' + innerHeight")).toBe("900x600");
});
