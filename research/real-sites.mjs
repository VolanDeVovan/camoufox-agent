// Manual smoke check against real sites (not part of `pnpm test`: results depend on the network).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const profiles = mkdtempSync(join(tmpdir(), "cfa-real-"));
const t = new StdioClientTransport({ command: process.execPath, args: ["dist/mcp/server.js", "--profiles-dir", profiles, "--headless"], env: { ...process.env, CAMOUFOX_AGENT_IDLE_MS: "1000" }, stderr: "inherit" });
const c = new Client({ name: "real", version: "0" });
await c.connect(t);
const call = async (name, args = {}) => { const t0 = Date.now(); const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120000 }); return { ms: Date.now() - t0, text: r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n"), isError: r.isError }; };
const show = (label, r, n = 12) => console.log(`\n=== ${label} (${r.ms} ms${r.isError ? ", ERROR" : ""}, ${r.text.length} chars)\n` + r.text.split("\n").slice(0, n).join("\n"));

show("navigate wikipedia", await call("navigate", { url: "https://en.wikipedia.org/wiki/Firefox" }));
let page = await call("read_page");
show("read_page", page, 14);
show("find search", await call("find", { query: "search", role: "searchbox" }));
const box = (await call("find", { query: "Search Wikipedia" })).text.match(/(?:searchbox|textbox|combobox) "[^"]*" (e\d+)/)?.[1];
if (box) {
  show("type", await call("computer", { action: "type", ref: box, text: "Camoufox" }));
  show("enter", await call("computer", { action: "key", text: "Enter" }));
}
show("get_page_text", await call("get_page_text", { max_chars: 400 }), 8);
show("hn", await call("navigate", { url: "news.ycombinator.com" }));
page = await call("read_page");
show("read_page hn", page, 10);
const more = page.text.match(/link "More" (e\d+)/)?.[1];
if (more) show("click More", await call("computer", { action: "left_click", ref: more }));
show("network", await call("read_network_requests", { limit: 5 }));
show("console", await call("read_console_messages", { limit: 5 }));
show("http_request", await call("http_request", { url: "https://httpbin.org/headers" }), 30);
show("fetch_markdown", await call("fetch_markdown", { url: "https://example.com" }), 12);
show("antibot", await call("detect_anti_bot"));
show("find_session", await call("find_session", { site: "wikipedia" }));
await c.close();
await new Promise((r) => setTimeout(r, 2000));
rmSync(profiles, { recursive: true, force: true });
