// Group http: the profile's cookies go only to their own origin, also across redirects (07).
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { browsersOn, cleanupTemps, fixture, startSession, tempDir, waitFor, type Fixture, type TestSession } from "./helpers.js";

let a: Fixture; // the site the profile is logged in to
let b: Fixture; // another origin
let s: TestSession;
let dir: string;

beforeAll(async () => {
  b = await fixture(
    {
      "/echo": (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ host: "b", cookie: req.headers.cookie || null, authorization: req.headers.authorization || null }));
      },
    },
    "localhost",
  );
  a = await fixture({
    "/login": (_req, res) => {
      res.setHeader("set-cookie", ["sessionid=SECRET-A; Path=/; Max-Age=86400", "tmp=1; Path=/"]);
      res.setHeader("content-type", "text/html");
      res.end("<title>in</title>ok");
    },
    "/echo": (req, res) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("set-cookie", "fresh=NEWSECRET; Path=/");
      res.end(JSON.stringify({ host: "a", cookie: req.headers.cookie || null, authorization: req.headers.authorization || null, access_token: "tok-123456", ua: req.headers["user-agent"] }));
    },
    "/to-b": (_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", b.base + "/echo");
      res.end();
    },
    "/to-a": (_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "/echo");
      res.end();
    },
    "/article": `<html><head><title>Guide</title></head><body><nav><a href="/x">nav</a></nav><main><h1>Guide</h1><p>Read the <a href="/docs">docs</a> first. ${"Lorem ipsum dolor. ".repeat(30)}</p><ul><li>One</li><li>Two</li></ul></main></body></html>`,
    "/table": `<title>T</title><table><caption>Prices</caption><thead><tr><th>Item</th><th>Price</th></tr></thead><tbody><tr><td>Tea</td><td>3</td></tr><tr><td>Coffee</td><td>4</td></tr></tbody></table>`,
  });
  dir = tempDir();
  s = await startSession({ profilesDir: dir });
  await s.call("navigate", { url: a.base + "/login" });
});
afterAll(async () => {
  await s.close();
  await a.close();
  await b.close();
  await cleanupTemps();
});

const lastHit = (f: Fixture) => f.hits.filter((h) => h.url === "/echo").at(-1)!;

test("sends the profile's cookies to their own origin, with a Firefox user agent; reply is masked", async () => {
  const r = await s.call("http_request", { url: a.base + "/echo" });
  expect(r.isError).toBe(false);
  expect(lastHit(a).headers.cookie).toContain("sessionid=SECRET-A");
  expect(lastHit(a).headers["user-agent"]).toMatch(/Firefox\//);
  expect(r.text).toContain('cookies: sent from profile "default"');
  expect(r.text).not.toContain("SECRET-A");
  expect(r.text).not.toContain("tok-123456");
  expect(r.text).not.toContain("NEWSECRET");
  const shown = await s.call("http_request", { url: a.base + "/echo", reveal_values: true });
  expect(shown.text).toContain("SECRET-A");
  expect(shown.text).toContain("tok-123456");
});

test("a redirect to another origin carries neither the cookies nor the caller's credentials", async () => {
  const r = await s.call("http_request", { url: a.base + "/to-b", headers: { Authorization: "Bearer caller-token-123" }, reveal_values: true });
  expect(r.isError).toBe(false);
  expect(r.text).toContain("another origin: credentials not carried over");
  const hit = lastHit(b);
  expect(hit.headers.cookie).toBeUndefined();
  expect(hit.headers.authorization).toBeUndefined();
  expect(r.text).toContain('"cookie":null');
});

test("a redirect within the origin keeps them", async () => {
  await s.call("http_request", { url: a.base + "/to-a", headers: { Authorization: "Bearer caller-token-123" } });
  expect(lastHit(a).headers.cookie).toContain("sessionid=SECRET-A");
  expect(lastHit(a).headers.authorization).toBe("Bearer caller-token-123");
});

test("use_cookies=false sends none; an unknown profile has none and is not created", async () => {
  await s.call("http_request", { url: a.base + "/echo", use_cookies: false });
  expect(lastHit(a).headers.cookie).toBeUndefined();
  const r = await s.call("http_request", { url: a.base + "/echo", profile: "nobody" });
  expect(lastHit(a).headers.cookie).toBeUndefined();
  expect(r.text).toContain('profile "nobody" has none');
  expect((await s.call("tabs_context")).text).not.toContain("nobody");
});

test("fetch_markdown and extract_table", async () => {
  const md = await s.call("fetch_markdown", { url: a.base + "/article" });
  expect(md.text).toContain("# Guide");
  expect(md.text).toContain(`[docs](${a.base}/docs)`);
  expect(md.text).toContain("- One");
  expect(md.text).not.toContain("nav");
  expect(md.text).toContain("untrusted page content");
  const rendered = await s.call("fetch_markdown", { url: a.base + "/article", use_browser: true });
  expect(rendered.text).toContain("# Guide");
  // The temporary tab is gone and the active tab is what it was.
  expect((await s.call("tabs_context")).text).toMatch(/\/login\s+<- active/);

  await s.call("navigate", { url: a.base + "/table" });
  const t = await s.call("extract_table", {});
  expect(t.text).toContain('Table 1 of 1 "Prices": 2 of 2 row(s), columns: Item | Price');
  expect(JSON.parse(t.text.split("\n").slice(1, -1).join("\n"))).toEqual([{ Item: "Tea", Price: "3" }, { Item: "Coffee", Price: "4" }]);
});

test("a stopped profile's cookies are read from disk, session cookies included", async () => {
  await s.call("close_browser", { profile: "default" });
  expect(await waitFor(() => browsersOn(join(dir, "default")).length === 0)).toBe(true);
  await s.call("http_request", { url: a.base + "/echo" });
  expect(lastHit(a).headers.cookie).toContain("sessionid=SECRET-A");
  expect(lastHit(a).headers.cookie).toContain("tmp=1");
  // And still nothing for the other origin.
  await s.call("http_request", { url: b.base + "/echo" });
  expect(lastHit(b).headers.cookie).toBeUndefined();
  expect(browsersOn(join(dir, "default"))).toHaveLength(0);
});
