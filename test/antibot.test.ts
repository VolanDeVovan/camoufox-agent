// Challenge pages are flagged so the agent stops instead of retrying (07), and a normal
// page with a captcha widget is not mistaken for one.
import { afterAll, beforeAll, expect, test } from "vitest";
import { cleanupTemps, fixture, startSession, tempDir, type Fixture, type TestSession } from "./helpers.js";

let site: Fixture;
let s: TestSession;

beforeAll(async () => {
  site = await fixture({
    "/": `<title>Shop</title><h1>Shop</h1><p>${"Plenty of real content here. ".repeat(80)}</p><a href="/cf">Protected area</a>
          <div class="cf-turnstile"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async></script>`,
    "/cf": (_req, res) => {
      res.statusCode = 403;
      res.setHeader("content-type", "text/html");
      res.setHeader("cf-mitigated", "challenge");
      res.setHeader("server", "cloudflare");
      res.end(`<title>Just a moment...</title><div id="challenge-running">Verifying you are human. This may take a few seconds.</div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>`);
    },
    "/dd": (_req, res) => {
      res.statusCode = 403;
      res.setHeader("content-type", "text/html");
      res.setHeader("x-datadome", "protected");
      res.end(`<title>blocked</title><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x" width="300" height="200"></iframe>`);
    },
    "/forbidden": (_req, res) => {
      res.statusCode = 403;
      res.setHeader("content-type", "text/html");
      res.end("<title>403</title>You do not have permission to view this page.");
    },
  });
  s = await startSession({ profilesDir: tempDir() });
});
afterAll(async () => {
  await s.close();
  await site.close();
  await cleanupTemps();
});

test("navigate flags a challenge page and names the vendor", async () => {
  const cf = await s.call("navigate", { url: site.base + "/cf" });
  expect(cf.text).toContain("challenge page (Cloudflare): hand over to the user");
  const dd = await s.call("navigate", { url: site.base + "/dd" });
  expect(dd.text).toContain("challenge page (DataDome)");
  const detail = await s.call("detect_anti_bot");
  expect(detail.text).toContain("challenge page: yes (DataDome)");
});

test("a normal page with a captcha widget, and a plain 403, are not challenges", async () => {
  const home = await s.call("navigate", { url: site.base + "/" });
  expect(home.text).not.toContain("challenge page");
  const detail = await s.call("detect_anti_bot");
  expect(detail.text).toContain("challenge page: no");
  expect(detail.text).toContain("Cloudflare Turnstile widget");
  const plain = await s.call("navigate", { url: site.base + "/forbidden" });
  expect(plain.text).not.toContain("challenge page");
});

test("a click that lands on a challenge page says so", async () => {
  await s.call("navigate", { url: site.base + "/" });
  const ref = (await s.call("find", { query: "Protected area" })).text.match(/link "Protected area" (e\d+)/)![1];
  const r = await s.call("computer", { action: "left_click", ref });
  expect(r.text).toMatch(/navigated to .*\/cf/);
  expect(r.text).toContain("challenge page (Cloudflare)");
});

test("fingerprint_audit shows a coherent device", async () => {
  await s.call("navigate", { url: site.base + "/" });
  const r = await s.call("fingerprint_audit");
  expect(r.isError, r.text).toBe(false);
  const fp = JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1));
  expect(fp.userAgent).toMatch(/Firefox\/\d+/);
  expect(fp.webdriver).toBe(false);
  expect(fp.automationGlobals).toEqual([]);
  expect(r.text, r.text).toContain("contradictions: none found");
});
