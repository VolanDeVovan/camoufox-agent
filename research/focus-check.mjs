// Does the agent's window ever take keyboard focus? Samples niri's focused window every
// 50 ms while a browser is launched, tabs are opened and selected, and a click is made.
// Run with another window focused and the screen awake. `x11` runs the browser on Xwayland.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const x11 = process.argv.includes("x11");
const srv = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end(`<title>page ${q.url}</title><button onclick="document.title='clicked'">Click me</button><a href="/pop" target="_blank">Popup</a>`); }).listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;
const profiles = mkdtempSync(join(tmpdir(), "cfa-focus-"));
const focused = () => { try { const w = JSON.parse(execFileSync("niri", ["msg", "-j", "focused-window"], { encoding: "utf8" })); return w ? `${w.id}:${w.app_id}` : "none"; } catch { return "?"; } };
const titles = () => JSON.parse(execFileSync("niri", ["msg", "-j", "windows"], { encoding: "utf8" })).filter((w) => /camoufox/i.test(w.app_id || "")).map((w) => w.title);
const start = focused();
const seen = new Map();
let step = "start";
const timer = setInterval(() => { const f = focused(); if (f !== start) seen.set(step, f); }, 50);
const env = { ...process.env, CAMOUFOX_AGENT_IDLE_MS: "1000" };
if (x11) { delete env.WAYLAND_DISPLAY; env.MOZ_ENABLE_WAYLAND = "0"; }
const t = new StdioClientTransport({ command: process.execPath, args: ["dist/mcp/server.js", "--profiles-dir", profiles], env, stderr: "inherit" });
const c = new Client({ name: "focus-check", version: "0" });
await c.connect(t);
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = async (label, fn) => { step = label; const out = await fn(); await sleep(700); return out; };

console.log(`focused before: ${start}; display: ${x11 ? "X11 (Xwayland)" : "Wayland"}`);
await run("launch + first tab", () => call("tabs_create", { url: base + "/one" }));
await run("second tab", () => call("tabs_create", { url: base + "/two" }));
console.log("window shows:", titles());
await run("act on the other tab", () => call("navigate", { url: base + "/one-b", tabId: 1 }));
console.log("after acting on tab 1, window shows:", titles(), x11 ? "(X11: the agent works in a background tab)" : "(Wayland: follows the agent)");
const ref = (await call("find", { query: "Click me" })).match(/button "Click me" (e\d+)/)[1];
console.log("click:", (await run("click", () => call("computer", { action: "left_click", ref }))).replace(/\n\s*/g, " | "));
const pop = (await call("find", { query: "Popup" })).match(/link "Popup" (e\d+)/)[1];
console.log("popup:", (await run("site popup", () => call("computer", { action: "left_click", ref: pop }))).replace(/\n\s*/g, " | "));
console.log("screenshot:", (await run("screenshot", () => call("computer", { action: "screenshot" }))).split("\n")[0].slice(0, 60));
await run("close", () => call("close_browser"));
clearInterval(timer);
console.log(seen.size ? `FOCUS MOVED: ${JSON.stringify([...seen])}` : `focus stayed on ${start} through every step`);
console.log("focused after:", focused());
await c.close(); srv.close(); await sleep(1500); rmSync(profiles, { recursive: true, force: true });
