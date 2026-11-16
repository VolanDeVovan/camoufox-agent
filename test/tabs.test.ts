// Tabs across sessions and profiles: the core of the daemon model (02, 03, 04).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browsersOn, cleanupTemps, fixture, sleep, startSession, tempDir, waitFor, type Fixture, type TestSession } from "./helpers.js";

let site: Fixture;
let dir: string;
let a: TestSession;
let b: TestSession;

beforeAll(async () => {
  site = await fixture({
    "/": "<title>Home</title>home",
    "/login": (_req, res) => {
      res.setHeader("set-cookie", ["sess=s3cr3t; Path=/; HttpOnly", "keep=1; Path=/; Max-Age=86400"]);
      res.setHeader("content-type", "text/html");
      res.end("<title>Logged in</title>ok");
    },
    "/whoami": (req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`<title>Who</title>${req.headers.cookie || "(no cookies)"}`);
    },
    "/closes-itself": "<title>Bye</title><script>setTimeout(() => window.close(), 300)</script>",
  });
  dir = tempDir();
  a = await startSession({ profilesDir: dir });
  b = await startSession({ profilesDir: dir });
});
afterAll(async () => {
  await a.close();
  await b.close();
  await site.close();
  cleanupTemps();
});

const lastCookie = () => site.hits.filter((h) => h.url === "/whoami").at(-1)?.headers.cookie || "";

test("each session sees only its own tabs, in one shared profile", async () => {
  await a.call("navigate", { url: site.base + "/login" });
  await b.call("navigate", { url: site.base + "/whoami" });
  // Two sessions in one profile share its cookies...
  expect(lastCookie()).toContain("sess=s3cr3t");
  expect(browsersOn(dir)).toHaveLength(1);
  // ...each with its own tabs.
  const ca = await a.call("tabs_context");
  const cb = await b.call("tabs_context");
  expect(ca.text).toContain("/login");
  expect(ca.text).not.toContain("/whoami");
  expect(cb.text).toContain("/whoami");
  expect(cb.text).not.toContain("/login");
  // Ids are daemon-wide, so B cannot act on A's tab by guessing its id.
  const idA = Number(ca.text.match(/^\s+(\d+)\s+default/m)![1]);
  const stolen = await b.call("navigate", { url: site.base + "/", tabId: idA });
  expect(stolen.isError).toBe(true);
  expect(stolen.text).toContain("another session");
});

test("a second profile is another browser with its own cookies, and creation is announced", async () => {
  const r = await a.call("tabs_create", { url: site.base + "/whoami", profile: "other-id" });
  expect(r.text).toContain('Created new profile "other-id". Existing: default.');
  expect(lastCookie()).toBe("");
  expect(browsersOn(dir)).toHaveLength(2);
  const ctx = await a.call("tabs_context");
  expect(ctx.text).toMatch(/default \(running\), other-id \(running\)/);
  // One flat list across profiles.
  expect(ctx.text).toMatch(/\d+\s+default\s+/);
  expect(ctx.text).toMatch(/\d+\s+other-id\s+.*<- active/);
});

test("profile names are restricted", async () => {
  for (const bad of ["../evil", "Default", "a/b", "-x", ""]) {
    const r = await a.call("tabs_create", { profile: bad });
    expect(r.isError, bad).toBe(true);
  }
  expect(existsSync(join(dir, "..", "evil"))).toBe(false);
});

test("a tab that closes behind the session is reported, not silently switched", async () => {
  const opened = await a.call("tabs_create", { url: site.base + "/closes-itself" });
  const id = Number(opened.text.match(/Opened tab (\d+)/)![1]);
  await sleep(1200);
  const next = await a.call("navigate", { url: site.base + "/" });
  expect(next.isError).toBe(true);
  expect(next.text).toContain(`Tab ${id}`);
  expect(next.text).toContain("was closed");
  // Having said so once, the session carries on with the tab named in the reply.
  const again = await a.call("navigate", { url: site.base + "/" });
  expect(again.isError).toBe(false);
});

test("close_browser(profile) closes it for everyone and tells the other session", async () => {
  const r = await a.call("close_browser", { profile: "default" });
  expect(r.text).toContain('Closed the browser of profile "default"');
  expect(await waitFor(() => browsersOn(join(dir, "default")).length === 0)).toBe(true);
  const told = await b.call("navigate", { url: site.base + "/" });
  expect(told.isError).toBe(true);
  expect(told.text).toContain("closed by another session");
});

test("logins survive a browser restart, session cookies included", async () => {
  await b.call("navigate", { url: site.base + "/whoami" });
  expect(lastCookie()).toContain("keep=1");
  expect(lastCookie()).toContain("sess=s3cr3t");
});

test("close_browser() keeps a browser another session still uses", async () => {
  await a.call("tabs_create", { url: site.base + "/" }); // default, shared with b
  const r = await a.call("close_browser", {});
  expect(r.text).toMatch(/other-id/);
  expect(r.text).toMatch(/stays open because another session uses it/);
  expect(browsersOn(join(dir, "default"))).toHaveLength(1);
  expect(browsersOn(join(dir, "other-id"))).toHaveLength(0);
  expect((await b.call("tabs_context")).text).toContain("/whoami");
});

test("temp is a throwaway profile", async () => {
  const r = await a.call("tabs_create", { url: site.base + "/whoami", profile: "temp" });
  expect(r.isError).toBe(false);
  expect(lastCookie()).toBe("");
  expect(existsSync(join(dir, "temp"))).toBe(false);
  const [pid] = browsersOn("/tmp/camoufox-agent-temp-");
  expect(pid).toBeGreaterThan(0);
  await a.call("close_browser", { profile: "temp" });
});
