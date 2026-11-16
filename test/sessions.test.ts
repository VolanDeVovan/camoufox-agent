// find_session against real browsers: live read, on-disk read, after a crash; the
// cross-profile hint; cookies and web_storage with masking.
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browsersOn, cleanupTemps, closeTabsIn, fixture, sleep, startSession, tempDir, waitFor, type Fixture, type TestSession } from "./helpers.js";

let site: Fixture;
let s: TestSession;
let dir: string;

beforeAll(async () => {
  site = await fixture({
    "/": "<title>Shop</title>home",
    "/login": (_req, res) => {
      res.setHeader("set-cookie", ["sessionid=TOPSECRETVALUE; Path=/; Max-Age=864000; HttpOnly", "csrftoken=abc; Path=/", "theme=dark; Path=/; Max-Age=864000"]);
      res.setHeader("content-type", "text/html");
      res.end("<title>In</title><script>localStorage.setItem('api_token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig'); localStorage.setItem('lang', 'uk')</script>logged in");
    },
  });
  dir = tempDir();
  s = await startSession({ profilesDir: dir });
});
afterAll(async () => {
  await s.close();
  await site.close();
  await cleanupTemps();
});

test("a running profile is read through the live browser", async () => {
  await s.call("tabs_create", { url: site.base + "/login", profile: "shop-admin" });
  const r = await s.call("find_session", { site: "127.0.0.1" });
  expect(r.text).toMatch(/shop-admin \(running\)\n\s+127\.0\.0\.1\s+3 cookies, auth-looking: sessionid, csrftoken; latest expiry in 10 d/);
  expect(r.text).not.toContain("TOPSECRETVALUE");
});

test("navigating to that site in another profile gets the hint, once", async () => {
  const r = await s.call("tabs_create", { url: site.base + "/" });
  expect(r.text).toContain(`Note: shop-admin has cookies for 127.0.0.1 (sessionid, csrftoken) - tabs_create(url, profile="shop-admin") to use that session.`);
  const again = await s.call("navigate", { url: site.base + "/" });
  expect(again.text).not.toContain("Note:");
  // In the profile that holds the session there is nothing to hint.
  const own = await s.call("tabs_create", { url: site.base + "/", profile: "shop-admin" });
  expect(own.text).not.toContain("Note:");
});

test("cookies and web_storage mask values unless revealed", async () => {
  const list = await s.call("cookies", {});
  expect(list.text).toContain("sessionid=***(14 chars)");
  expect(list.text).toContain("HttpOnly");
  expect(list.text).not.toContain("TOPSECRETVALUE");
  expect((await s.call("cookies", { reveal_values: true })).text).toContain("sessionid=TOPSECRETVALUE");
  await s.call("cookies", { action: "set", name: "flag", value: "on" });
  expect((await s.call("cookies", { name: "flag", reveal_values: true })).text).toContain("flag=on");
  expect((await s.call("cookies", { action: "delete", name: "flag" })).text).toContain("Deleted 1 cookie");
  expect((await s.call("cookies", { action: "delete" })).isError).toBe(true);

  const ls = await s.call("web_storage", {});
  expect(ls.text).toContain("lang = uk");
  expect(ls.text).toMatch(/api_token = \*\*\*\(\d+ chars\)/);
  expect(ls.text).not.toContain("eyJhbGci");
  expect((await s.call("web_storage", { key: "api_token", reveal_values: true })).text).toContain("eyJhbGci");
  await s.call("web_storage", { action: "set", key: "k", value: "v" });
  expect((await s.call("web_storage", { key: "k" })).text).toContain("v");
  expect((await s.call("web_storage", { action: "clear", kind: "session" })).text).toContain("Cleared sessionStorage");
});

test("a stopped profile is read from disk, session cookies included", async () => {
  await closeTabsIn(s, "shop-admin");
  expect(await waitFor(() => browsersOn(join(dir, "shop-admin")).length === 0)).toBe(true);
  const r = await s.call("find_session", { site: "127.0.0.1" });
  expect(r.text).toMatch(/shop-admin\n\s+127\.0\.0\.1\s+3 cookies, auth-looking: sessionid, csrftoken/);
  expect(r.text).toContain("localStorage yes");
});

test("a profile whose browser was killed is still read", async () => {
  await s.call("tabs_create", { url: site.base + "/login", profile: "crashy" });
  await sleep(7000); // let Firefox write its cookie database
  const [pid] = browsersOn(join(dir, "crashy"));
  process.kill(pid, "SIGKILL");
  await waitFor(() => browsersOn(join(dir, "crashy")).length === 0);
  await sleep(500);
  const r = await s.call("find_session", { site: "127.0.0.1" });
  expect(r.text).toMatch(/crashy\n\s+127\.0\.0\.1\s+\d cookies, auth-looking: sessionid/);
});
