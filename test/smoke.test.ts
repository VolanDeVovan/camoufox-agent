// The package actually works as installed: the server starts over stdio, lists its
// tools, and a navigate round trip works.
import { afterAll, beforeAll, expect, test } from "vitest";
import { cleanupTemps, fixture, startSession, tempDir, type Fixture, type TestSession } from "./helpers.js";

let site: Fixture;
let s: TestSession;

beforeAll(async () => {
  site = await fixture({ "/": "<title>Home</title><h1>Welcome</h1><a href='/next'>Next page</a>", "/next": "<title>Next</title><p>second</p>" });
  s = await startSession({ profilesDir: tempDir() });
});
afterAll(async () => {
  await s.call("close_browser", {}).catch(() => {});
  await s.close();
  await site.close();
  await cleanupTemps();
});

test("lists its tools", async () => {
  const { tools } = await s.client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of ["tabs_context", "tabs_create", "tabs_close", "navigate", "close_browser"]) expect(names).toContain(expected);
});

test("tool schemas carry no noise into the agent's context", async () => {
  // zod's defaults add "$schema" to every tool and +-2^53 bounds to every integer.
  const listed = JSON.stringify((await s.client.listTools()).tools);
  expect(listed).not.toContain("$schema");
  expect(listed).not.toContain(String(Number.MAX_SAFE_INTEGER));
});

test("no browser until a tool needs one, then navigate works", async () => {
  const before = await s.call("tabs_context");
  expect(before.text).toContain("(none");
  const nav = await s.call("navigate", { url: site.base + "/" });
  expect(nav.isError).toBe(false);
  expect(nav.text).toContain(site.base + "/");
  expect(nav.text).toContain("Home");
  // The default profile was created on first use, and says so.
  expect(nav.text).toContain('Created new profile "default"');
  const ctx = await s.call("tabs_context");
  expect(ctx.text).toMatch(/1\s+default\s+"Home"/);
  expect(ctx.text).toContain("default (running)");
});

test("back and forward", async () => {
  await s.call("navigate", { url: site.base + "/next" });
  const back = await s.call("navigate", { url: "back" });
  expect(back.text).toContain("Home");
  const fwd = await s.call("navigate", { url: "forward" });
  expect(fwd.text).toContain("Next");
});

test("an unreachable address is an error, not a silent success", async () => {
  const r = await s.call("navigate", { url: "http://127.0.0.1:9/" });
  expect(r.isError).toBe(true);
});

test("the server carries its own instructions for the agent", () => {
  const text = s.client.getInstructions() || "";
  for (const rule of ["find_session(site)", "untrusted", "challenge page", "read_page"]) expect(text).toContain(rule);
});
