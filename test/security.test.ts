// Secrets are masked in every tool that can show them: one page that leaks
// secrets through every channel, every tool called without reveal_values, and none of
// the secrets may appear in any reply. javascript_tool is the one documented exception.
import { afterAll, beforeAll, expect, test } from "vitest";
import { cleanupTemps, fixture, startSession, tempDir, type Fixture, type TestSession } from "./helpers.js";

let site: Fixture;
let s: TestSession;

const SECRETS = {
  urlToken: "URLTOKEN-7f3a9c",
  linkToken: "LINKTOKEN-55ab01",
  password: "PASSWORD-hunter2x",
  typed: "TYPED-pass-9911",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQtdXNlciJ9.c2lnbmF0dXJlLXZhbHVl",
  bearer: "BEARER-abcdef0123456789",
  bodyToken: "BODYTOKEN-31337aa",
  cookie: "COOKIE-s3ss10n-value",
  setCookie: "SETCOOKIE-fresh-value",
  storage: "STORAGE-refresh-xyz",
};

beforeAll(async () => {
  site = await fixture({
    "/app": (_req, res) => {
      res.setHeader("content-type", "text/html");
      res.setHeader("set-cookie", `sessionid=${SECRETS.cookie}; Path=/; Max-Age=86400; HttpOnly`);
      res.end(`<title>App</title><h1>Account</h1>
        <a href="/next?access_token=${SECRETS.linkToken}">Continue</a>
        <form><input type="password" name="pw" value="${SECRETS.password}"><input type="password" id="new" name="new_password" placeholder="New password"></form>
        <button id="load" onclick="fetch('/api?api_key=${SECRETS.urlToken}', { method: 'POST', headers: { authorization: 'Bearer ${SECRETS.bearer}', 'content-type': 'application/json' }, body: JSON.stringify({ password: '${SECRETS.password}' }) }).then(() => document.title = 'loaded')">Load</button>
        <script>
          console.log("session jwt ${SECRETS.jwt}");
          localStorage.setItem("auth", JSON.stringify({ refreshToken: "${SECRETS.storage}" }));
        </script>`);
    },
    "/api": (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("set-cookie", `api_session=${SECRETS.setCookie}; Path=/`);
      res.end(JSON.stringify({ ok: true, access_token: SECRETS.bodyToken }));
    },
    "/next": "<title>Next</title>next",
  });
  s = await startSession({ profilesDir: tempDir() });
});
afterAll(async () => {
  await s.close();
  await site.close();
  await cleanupTemps();
});

test("no tool shows a secret unless asked to reveal it", async () => {
  const replies: [string, string][] = [];
  const run = async (label: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await s.call(name, args);
    replies.push([label, r.text]);
    return r;
  };
  const url = `${site.base}/app?session_token=${SECRETS.urlToken}`;
  await run("tabs_create", "tabs_create", { url });
  await run("navigate", "navigate", { url });
  await run("tabs_context", "tabs_context");
  const page = await run("read_page", "read_page");
  await run("read_page all", "read_page", { filter: "all" });
  await run("find", "find", { query: "password" });
  await run("find link", "find", { query: "continue" });
  await run("get_page_text", "get_page_text");
  const ref = (label: string) => page.text.match(new RegExp(`"${label}" (e\\d+)`))![1];
  await run("form_input", "form_input", { ref: ref("New password"), value: SECRETS.typed });
  await run("type", "computer", { action: "type", ref: ref("New password"), text: SECRETS.typed });
  await run("type focused", "computer", { action: "type", text: SECRETS.typed });
  const before = await run("network before", "read_network_requests");
  const last = Math.max(...[...before.text.matchAll(/#(\d+) /g)].map((m) => Number(m[1])));
  await run("click", "computer", { action: "left_click", ref: ref("Load") });
  const waited = await run("wait_for_network", "wait_for_network", { pattern: "/api", since: last });
  const id = Number(waited.text.match(/#(\d+) POST/)![1]);
  await run("read_network_requests", "read_network_requests");
  await run("get_network_request", "get_network_request", { id });
  await run("export_curl", "export_curl", { id });
  await run("export_har", "export_har");
  await run("read_console_messages", "read_console_messages");
  await run("cookies", "cookies");
  await run("cookies all", "cookies", { domain: "127.0.0.1" });
  await run("web_storage", "web_storage");
  await run("web_storage key", "web_storage", { key: "auth" });
  await run("find_session", "find_session", { site: "127.0.0.1" });
  await run("detect_anti_bot", "detect_anti_bot");
  await run("wait_for", "wait_for", { url: "/app" });
  await run("http_request", "http_request", { url: `${site.base}/api?api_key=${SECRETS.urlToken}`, method: "POST", headers: { authorization: `Bearer ${SECRETS.bearer}` } });
  await run("fetch_markdown", "fetch_markdown", { url });
  await run("link click", "computer", { action: "left_click", ref: ref("Continue") });
  await run("navigate back", "navigate", { url: "back" });
  await run("batch", "browser_batch", { actions: [{ tool: "navigate", args: { url } }, { tool: "read_page", args: {} }, { tool: "cookies", args: {} }] });
  await run("tabs_close", "tabs_close");

  for (const [label, text] of replies) {
    for (const [name, secret] of Object.entries(SECRETS)) expect(text.includes(secret), `${label} leaked ${name}:\n${text.slice(0, 600)}`).toBe(false);
  }
  // The masking is not just silence: the channels were really exercised.
  const all = replies.map((r) => r[1]).join("\n");
  for (const proof of ["session_token=***", "access_token=***", "sessionid=***", "(secret", "***(jwt)", "authorization: ***", '"access_token":"***']) expect(all, proof).toContain(proof);
});

test("reveal_values shows them where it is offered", async () => {
  const url = `${site.base}/app`;
  await s.call("navigate", { url });
  expect((await s.call("read_page", { reveal_values: true })).text).toContain(SECRETS.password);
  expect((await s.call("cookies", { reveal_values: true })).text).toContain(SECRETS.cookie);
  expect((await s.call("web_storage", { reveal_values: true })).text).toContain(SECRETS.storage);
  expect((await s.call("read_console_messages", { reveal_values: true })).text).toContain(SECRETS.jwt);
});
