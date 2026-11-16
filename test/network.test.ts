// Console and network capture, and masking of what they show.
import { readFileSync, statSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { cleanupTemps, fixture, startSession, tempDir, type Fixture, type TestSession } from "./helpers.js";

let site: Fixture;
let s: TestSession;
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";

beforeAll(async () => {
  site = await fixture({
    "/": `<title>Net</title><img src="/pic.png" width="10" height="10">
      <button id="go" onclick="fetch('/api/items?token=tok_live_123&page=2', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer abcdef123456' }, body: JSON.stringify({ query: 'shoes', password: 'hunter2' }) }).then(r => r.json()).then(d => document.title = 'got ' + d.items.length)">Load</button>
      <script>console.log("hello from page"); console.warn("careful"); console.error("token is ${JWT}"); setTimeout(() => { throw new Error("boom") }, 0);</script>`,
    "/api/items": (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("set-cookie", "apisess=verysecretvalue; Path=/; HttpOnly");
      res.end(JSON.stringify({ items: [1, 2, 3], access_token: "at_secret_999", note: "fine" }));
    },
    "/pic.png": (_req, res) => {
      res.setHeader("content-type", "image/png");
      res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    },
  });
  s = await startSession({ profilesDir: tempDir() });
  await s.call("navigate", { url: site.base + "/" });
});
afterAll(async () => {
  await s.close();
  await site.close();
  await cleanupTemps();
});

test("console is captured from the start, filtered by level and pattern, tokens masked", async () => {
  const all = await s.call("read_console_messages");
  expect(all.text).toContain("log: hello from page");
  expect(all.text).toContain("warning: careful");
  expect(all.text).toContain("Uncaught Error: boom");
  expect(all.text).not.toContain(JWT);
  expect(all.text).toContain("***(jwt)");
  expect(all.text).toContain("untrusted page content");
  const errors = await s.call("read_console_messages", { level: "error" });
  expect(errors.text).not.toContain("hello from page");
  expect(errors.text).toContain("boom");
  const pat = await s.call("read_console_messages", { pattern: "care" });
  expect(pat.text).toContain("1 of 1 matching");
  expect((await s.call("read_console_messages", { reveal_values: true })).text).toContain(JWT);
});

test("network requests are listed; bodies come with get_network_request, secrets masked by default", async () => {
  const before = await s.call("read_network_requests");
  expect(before.text).toMatch(/#\d+ GET 200 http:\/\/127\.0\.0\.1:\d+\/ \(document/);
  expect(before.text).toMatch(/#\d+ GET 200 .*\/pic\.png \(image/);
  const lastId = Math.max(...[...before.text.matchAll(/#(\d+) /g)].map((m) => Number(m[1])));

  const btn = (await s.call("find", { query: "Load" })).text.match(/button "Load" (e\d+)/)![1];
  await s.call("computer", { action: "left_click", ref: btn });
  // The XHR already happened; `since` makes wait_for_network accept it.
  const waited = await s.call("wait_for_network", { pattern: "/api/items", since: lastId });
  expect(waited.isError).toBe(false);
  const id = Number(waited.text.match(/#(\d+) POST 200/)![1]);

  const list = await s.call("read_network_requests", { pattern: "api", since: lastId });
  expect(list.text).toContain("token=***(12 chars)&page=2");
  expect(list.text).not.toContain("tok_live_123");

  const one = await s.call("get_network_request", { id });
  for (const secret of ["tok_live_123", "abcdef123456", "hunter2", "verysecretvalue", "at_secret_999"]) expect(one.text, secret).not.toContain(secret);
  expect(one.text).toContain('"query":"shoes"');
  expect(one.text).toContain('"items":[1,2,3]');
  expect(one.text).toContain('"note":"fine"');
  expect(one.text).toMatch(/set-cookie: apisess=\*\*\*\(15 chars\); Path=\//i);

  const revealed = await s.call("get_network_request", { id, reveal_values: true });
  for (const secret of ["tok_live_123", "Bearer abcdef123456", "hunter2", "verysecretvalue", "at_secret_999"]) expect(revealed.text, secret).toContain(secret);

  const curl = await s.call("export_curl", { id });
  expect(curl.text).toMatch(/^curl 'http:\/\/127\.0\.0\.1:\d+\/api\/items\?token=\*\*\*/);
  expect(curl.text).not.toContain("abcdef123456");
  expect(curl.text).toContain("--data-raw");
  expect((await s.call("export_curl", { id, reveal_values: true })).text).toContain("authorization: Bearer abcdef123456");
});

test("wait_for_network times out as an error", async () => {
  const r = await s.call("wait_for_network", { pattern: "never-requested", timeout_s: 0.5 });
  expect(r.isError).toBe(true);
});

test("export_har writes a 0600 file and does not print its content", async () => {
  const r = await s.call("export_har", {});
  const path = r.text.match(/to (\S+\.har)/)![1];
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const har = JSON.parse(readFileSync(path, "utf8"));
  expect(har.log.version).toBe("1.2");
  const api = har.log.entries.find((e: any) => e.request.url.includes("/api/items"));
  expect(api.request.method).toBe("POST");
  expect(api.response.content.text).toContain("at_secret_999");
  expect(r.text).not.toContain("at_secret_999");
});

test("block_requests blocks by type and can be turned off", async () => {
  await s.call("block_requests", { resource_types: ["image"] });
  const mark = Math.max(...[...(await s.call("read_network_requests")).text.matchAll(/#(\d+) /g)].map((m) => Number(m[1])));
  await s.call("navigate", { url: site.base + "/" });
  const blocked = await s.call("read_network_requests", { pattern: "pic", since: mark });
  expect(blocked.text).toMatch(/GET FAILED/);
  await s.call("block_requests", { off: true });
  const mark2 = Math.max(...[...(await s.call("read_network_requests")).text.matchAll(/#(\d+) /g)].map((m) => Number(m[1])));
  await s.call("navigate", { url: site.base + "/" });
  await s.call("wait_for", { network_idle: true });
  expect((await s.call("read_network_requests", { pattern: "pic", since: mark2 })).text).toMatch(/GET 200/);
});
