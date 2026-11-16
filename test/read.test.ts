// read_page / find / get_page_text: what the agent sees of a page (06-page-interaction.md).
import { afterAll, beforeAll, expect, test } from "vitest";
import { cleanupTemps, fixture, startSession, tempDir, type Fixture, type TestSession } from "./helpers.js";

let site: Fixture;
let s: TestSession;

const FORM = `<title>Sign in</title>
<h1>Sign in</h1>
<form>
  <label for="em">Email</label><input id="em" type="email" value="me@example.com">
  <label>Password <input type="password" name="pw" value="hunter2secret"></label>
  <label><input type="checkbox" name="remember" checked> Remember me</label>
  <select name="lang" aria-label="Language"><option>English</option><option selected>Deutsch</option></select>
  <button type="submit">Next</button>
  <button disabled>Disabled one</button>
</form>
<h2><a href="/help">Help centre</a></h2>
<a href="/forgot">Forgot password?</a>
<div style="display:none"><button>Invisible</button></div>
<p>Some paragraph text that is not interactive.</p>
<div id="host"></div>
<iframe src="/inner" title="Inner frame" width="300" height="100"></iframe>
<script>
  const root = document.getElementById("host").attachShadow({ mode: "open" });
  root.innerHTML = "<button>Shadow button</button>";
</script>`;

beforeAll(async () => {
  site = await fixture({
    "/": FORM,
    "/inner": "<title>Inner</title><button>Inside frame</button><input placeholder='Frame field'>",
    "/other": "<title>Other</title><button>Only button</button>",
    "/long": "<title>Long</title>" + Array.from({ length: 400 }, (_, i) => `<a href="/l${i}">Link number ${i}</a>`).join(" "),
    "/article": "<title>Article</title><nav>menu stuff</nav><main><h1>Story</h1><p>" + "Body text. ".repeat(50) + "</p></main>",
  });
  s = await startSession({ profilesDir: tempDir() });
});
afterAll(async () => {
  await s.close();
  await site.close();
  cleanupTemps();
});

test("lists interactive elements and headings with refs, labels and state", async () => {
  await s.call("navigate", { url: site.base + "/" });
  const r = await s.call("read_page");
  const t = r.text;
  expect(t).toContain('heading "Sign in" [h1]');
  expect(t).toMatch(/textbox "Email" e\d+ \(type=email, value="me@example.com"\)/);
  expect(t).toMatch(/checkbox "Remember me" e\d+ \(checked\)/);
  expect(t).toMatch(/combobox "Language" e\d+ \(value="Deutsch", options: English \| Deutsch\)/);
  expect(t).toMatch(/button "Next" e\d+/);
  expect(t).toMatch(/button "Disabled one" e\d+ \(disabled\)/);
  // A link inside a heading is still listed and clickable.
  expect(t).toMatch(/link "Help centre" e\d+ -> http:\/\/127\.0\.0\.1:\d+\/help/);
  expect(t).toMatch(/link "Forgot password\?" e\d+/);
  // Hidden elements are not listed; text is not listed in the default filter.
  expect(t).not.toContain("Invisible");
  expect(t).not.toContain("Some paragraph");
  // Open shadow roots and visible iframes are included, frames with prefixed refs.
  expect(t).toMatch(/button "Shadow button" e\d+/);
  expect(t).toMatch(/iframe "Inner frame" f1/);
  expect(t).toMatch(/button "Inside frame" f1e\d+/);
  // Page content is marked as untrusted.
  expect(t).toContain("untrusted page content");
});

test("a secret field is marked and its value masked unless revealed", async () => {
  const masked = await s.call("read_page");
  expect(masked.text).toMatch(/textbox "Password" e\d+ \(secret, value="••• \(13 chars\)"\)/);
  expect(masked.text).not.toContain("hunter2secret");
  const shown = await s.call("read_page", { reveal_values: true });
  expect(shown.text).toContain("hunter2secret");
});

test('filter "all" adds text; ref_id reads a subtree', async () => {
  const all = await s.call("read_page", { filter: "all" });
  expect(all.text).toContain('text "Some paragraph text that is not interactive."');
  const formRef = all.text.match(/button "Next" (e\d+)/)![1];
  const sub = await s.call("read_page", { ref_id: formRef });
  expect(sub.text).toContain('button "Next"');
  expect(sub.text).not.toContain("Forgot password");
});

test("refs are stable for an element and stale after the page changes, never reused", async () => {
  const first = await s.call("read_page");
  const second = await s.call("read_page");
  const ref = first.text.match(/button "Next" (e\d+)/)![1];
  expect(second.text).toContain(`button "Next" ${ref}`);
  await s.call("navigate", { url: site.base + "/other" });
  const other = await s.call("read_page");
  const newRef = other.text.match(/button "Only button" (e\d+)/)![1];
  // No ref of the new page reuses a ref of the old one.
  const oldRefs = new Set(first.text.match(/\be\d+\b/g));
  expect(oldRefs.has(newRef)).toBe(false);
  const stale = await s.call("read_page", { ref_id: ref });
  expect(stale.isError).toBe(true);
  expect(stale.text).toContain("call read_page again");
});

test("long output is capped with an explicit truncated line and paging", async () => {
  await s.call("navigate", { url: site.base + "/long" });
  const r = await s.call("read_page", { max_chars: 3000 });
  expect(r.text).toMatch(/truncated: showing lines 1-\d+ of 400; read_page with offset=\d+ continues/);
  const offset = Number(r.text.match(/offset=(\d+)/)![1]);
  const next = await s.call("read_page", { max_chars: 3000, offset });
  expect(next.text).toContain(`Link number ${offset}`);
});

test("find is literal and returns every match with a ref", async () => {
  await s.call("navigate", { url: site.base + "/" });
  const r = await s.call("find", { query: "password" });
  expect(r.text).toMatch(/2 matches/);
  expect(r.text).toMatch(/textbox "Password" e\d+/);
  expect(r.text).toMatch(/link "Forgot password\?" e\d+/);
  const text = await s.call("find", { query: "paragraph text" });
  expect(text.text).toMatch(/text "Some paragraph text that is not interactive\." e\d+/);
  const inFrame = await s.call("find", { query: "frame field" });
  expect(inFrame.text).toMatch(/textbox "Frame field" f\d+e\d+/);
  const byRole = await s.call("find", { role: "button" });
  expect(byRole.text).toMatch(/4 matches/);
  const none = await s.call("find", { query: "no such thing here" });
  expect(none.text).toContain("No visible element matches");
});

test("get_page_text prefers the main content and pages", async () => {
  await s.call("navigate", { url: site.base + "/article" });
  const r = await s.call("get_page_text", { max_chars: 100 });
  expect(r.text).toContain("Story");
  expect(r.text).not.toContain("menu stuff");
  expect(r.text).toMatch(/truncated: characters 0-100 of \d+; get_page_text with offset=100 continues/);
});
