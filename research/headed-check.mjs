// Headed checklist: run by hand when focus, window or
// rendering code changes. Needs a Wayland session with niri for the focus lines.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const srv = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end(`<title>page ${q.url}</title><h1>${q.url}</h1><button onclick="document.title='clicked'">Click me</button><script>let f=0;(function r(){f++;requestAnimationFrame(r)})();setInterval(()=>{window.fps=f;f=0},1000)</script>`); }).listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;
const profiles = mkdtempSync(join(tmpdir(), "cfa-headed-"));
const niri = () => { try { return JSON.parse(execFileSync("niri", ["msg", "-j", "windows"], { encoding: "utf8" })); } catch { return []; } };
const cam = () => niri().filter((w) => w.app_id === "camoufox").map((w) => `${w.title}${w.is_focused ? " *FOCUSED*" : ""}`);
const t = new StdioClientTransport({ command: process.execPath, args: ["dist/mcp/server.js", "--profiles-dir", profiles], env: { ...process.env, CAMOUFOX_AGENT_IDLE_MS: "1000" }, stderr: "inherit" });
const c = new Client({ name: "headed-check", version: "0" });
await c.connect(t);
const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); return { text: r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n"), content: r.content, isError: r.isError }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("1.", (await call("tabs_create", { url: base + "/one" })).text.split("\n").pop());
await sleep(800);
console.log("   windows:", cam(), "| focused elsewhere:", !niri().some((w) => w.app_id === "camoufox" && w.is_focused));
console.log("2.", (await call("tabs_create", { url: base + "/two" })).text.split("\n").pop());
await sleep(500);
console.log("   windows (expect one, showing /two):", cam());
console.log("3. follow the agent:", (await call("navigate", { url: base + "/one-again", tabId: 1 })).text);
await sleep(600);
console.log("   windows (expect /one-again visible):", cam());
const shot = await call("computer", { action: "screenshot" });
writeFileSync(join(profiles, "shot.png"), Buffer.from(shot.content.find((x) => x.type === "image").data, "base64"));
console.log("4.", shot.text, "->", join(profiles, "shot.png"));
console.log("5. background tab 2 keeps rendering, fps:", (await call("javascript_tool", { text: "new Promise(r => setTimeout(() => r(window.fps), 1200))", tabId: 2 })).text.split("\n").pop());
const ref = (await call("find", { query: "Click me", tabId: 2 })).text.match(/button "Click me" (e\d+)/)[1];
console.log("6. click in the other tab:", (await call("computer", { action: "left_click", ref, tabId: 2 })).text.replace(/\n\s*/g, " | "));
console.log("7.", (await call("resize_window", { width: 1100, height: 700 })).text);
const audit = await call("fingerprint_audit");
const fp = JSON.parse(audit.text.slice(audit.text.indexOf("{"), audit.text.lastIndexOf("}") + 1));
console.log("8. window:", JSON.stringify(fp.window), "screen:", JSON.stringify(fp.screen), "|", audit.text.split("\n").filter((l) => /contradictions|^\s+- /.test(l)).join(" "));
console.log("9.", (await call("tabs_context")).text.replace(/\n/g, "\n   "));
if (process.argv.includes("keep")) { console.log("keeping the window for 60 s (press F12 in it to check DevTools)"); await sleep(60000); }
console.log("10.", (await call("close_browser")).text);
await c.close();
srv.close();
await sleep(1500);
console.log("    camoufox windows left:", cam().length);
if (!process.argv.includes("keep-files")) rmSync(profiles, { recursive: true, force: true });
