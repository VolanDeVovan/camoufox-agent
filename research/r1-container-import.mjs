// can container storage be moved to the default context? Builds a source profile with
// a real container (a Juggler context: origin attributes ^userContextId=N), runs
// examples/firefox-import on a copy taken while the browser runs, and reads the data
// back through camoufox-agent in the default context.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { firefox } from "playwright-core";
import { launchOptions } from "camoufox";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = http.createServer((q, s) => {
  if (q.url === "/set") s.setHeader("set-cookie", ["keep=persistent-1; Path=/; Max-Age=864000", "sess=session-1; Path=/; HttpOnly", "cf_clearance=bound; Path=/; Max-Age=864000"]);
  s.setHeader("content-type", "text/html");
  s.end(`<title>${q.url}</title><script>
    if (location.pathname === "/set") {
      localStorage.setItem("token", "ls-value-1");
      const open = indexedDB.open("appdb", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onsuccess = () => { const tx = open.result.transaction("kv", "readwrite"); tx.objectStore("kv").put("idb-value-1", "login"); tx.oncomplete = () => document.title = "stored"; };
    }
  </script>cookie header: ${q.headers.cookie || "(none)"}`);
}).listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;

// 1. A source profile with a container.
const srcDir = mkdtempSync(join(tmpdir(), "cfa-r1-src-"));
const opts = await launchOptions({ headless: true, os: "linux", i_know_what_im_doing: true, firefox_user_prefs: { "browser.sessionstore.interval": 2000, "browser.sessionstore.privacy_level": 0 } });
const ctx = await firefox.launchPersistentContext(srcDir, { ...opts, viewport: null });
const browser = ctx.browser();
const container = await browser.newContext({ viewport: null });
const page = await container.newPage();
await page.goto(base + "/set");
await page.waitForFunction("document.title === 'stored'");
console.log("source container page:", await page.innerText("body"));
await sleep(9000); // let Firefox flush cookies and storage, as a long-running Firefox has
const snap = mkdtempSync(join(tmpdir(), "cfa-r1-snap-"));
cpSync(srcDir, snap, { recursive: true, filter: (f) => !/\/(lock|\.parentlock)$/.test(f) });
const dirs = readdirSync(join(snap, "storage", "default")).filter((d) => d.includes("127.0.0.1"));
console.log("origin dirs in the source:", dirs);
const id = Number(/userContextId=(\d+)/.exec(dirs.join(" "))?.[1]);
await ctx.close();

// 2. A target profile that the agent's browser has opened once.
const profiles = mkdtempSync(join(tmpdir(), "cfa-r1-profiles-"));
const t = new StdioClientTransport({ command: process.execPath, args: ["dist/mcp/server.js", "--profiles-dir", profiles, "--headless"], env: { ...process.env, CAMOUFOX_AGENT_IDLE_MS: "1000" }, stderr: "inherit" });
const c = new Client({ name: "r1", version: "0" });
await c.connect(t);
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
await call("tabs_create", { profile: "imported" });
await call("close_browser", { profile: "imported" });
await sleep(1500);

// 3. Import.
console.log(execFileSync(process.execPath, ["examples/firefox-import/import.mjs", "--firefox-profile", snap, "--container", String(id), "--target", join(profiles, "imported"), "--idb"], { encoding: "utf8" }));

// 4. Read it back in the default context.
console.log("find_session:", (await call("find_session", { site: "127.0.0.1" })).split("\n").slice(1, 4).join(" | "));
console.log((await call("tabs_create", { url: base + "/check", profile: "imported" })).split("\n").pop());
const js = async (code) => (await call("javascript_tool", { text: code })).split("\n").slice(1).join(" ");
console.log("cookies seen by the server:", await js("document.body.innerText"));
console.log("localStorage.token:", await js("localStorage.getItem('token')"));
console.log("indexedDB:", await js(`new Promise((res) => { const o = indexedDB.open("appdb"); o.onsuccess = () => { try { const g = o.result.transaction("kv").objectStore("kv").get("login"); g.onsuccess = () => res("login=" + g.result); g.onerror = () => res("get error"); } catch (e) { res("no store: " + e.message); } }; o.onerror = () => res("open error: " + (o.error && o.error.name + " " + o.error.message)); })`));
console.log("dirs:", snap, profiles); await c.close();
srv.close();
await sleep(2500);
if (!process.argv.includes("keep")) for (const d of [srcDir, snap, profiles]) rmSync(d, { recursive: true, force: true });
