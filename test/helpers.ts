// Test harness: a real MCP client over stdio against the built server, a real
// (headless) Camoufox, pages from a local HTTP server. No mocks.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER = join(ROOT, "dist", "mcp", "server.js");
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const temps: string[] = [];
export function tempDir(prefix = "cfa-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
/**
 * Remove the temp directories of a test file. The daemon of a profiles directory
 * outlives its last client while free tabs are open, and its browsers write while they
 * close, so it is stopped (SIGTERM closes its browsers) and the directory is removed
 * once it is gone.
 */
export async function cleanupTemps(): Promise<void> {
  const dirs = temps.splice(0);
  for (const d of dirs) {
    for (const pid of daemonPids(d)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && dirs.some((d) => daemonPids(d).length > 0)) await sleep(200);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

export interface Reply {
  text: string;
  isError: boolean;
  content: any[];
}

export interface TestSession {
  client: Client;
  pid: number;
  call(name: string, args?: Record<string, unknown>): Promise<Reply>;
  close(): Promise<void>;
}

export interface SessionOptions {
  profilesDir: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export async function startSession(opts: SessionOptions): Promise<TestSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, "--profiles-dir", opts.profilesDir, "--headless", ...(opts.args || [])],
    env: { ...(process.env as Record<string, string>), XDG_DOWNLOAD_DIR: join(opts.profilesDir, "..downloads"), ...(opts.env || {}) },
    cwd: opts.cwd,
    stderr: "inherit",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return {
    client,
    pid: transport.pid!,
    async call(name, args = {}) {
      const res: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
      const text = (res.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      return { text, isError: !!res.isError, content: res.content || [] };
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}

export type Route = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void | Promise<void>;

export interface Fixture {
  base: string;
  port: number;
  /** Requests seen, newest last. */
  hits: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
}

/** A local HTTP server: `pages` maps a path to HTML or to a handler. */
export async function fixture(pages: Record<string, string | Route>, host = "127.0.0.1"): Promise<Fixture> {
  const hits: Fixture["hits"] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = (req.url || "/").split("?")[0];
      hits.push({ method: req.method || "GET", url: req.url || "/", headers: req.headers, body });
      const page = pages[path];
      if (page === undefined) {
        res.statusCode = 404;
        res.setHeader("content-type", "text/html");
        res.end("<title>404</title>not found");
      } else if (typeof page === "string") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(page);
      } else void page(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, host, r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://${host === "127.0.0.1" ? "127.0.0.1" : host}:${port}`,
    port,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Pids of browser processes started on a profile directory (by their -profile argument). */
export function browsersOn(dirPrefix: string): number[] {
  const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\n")
    .filter((l) => l.includes(`-profile ${dirPrefix}`) && !l.includes("-contentproc"))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

export function daemonPids(profilesDir: string): number[] {
  const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\n")
    .filter((l) => l.includes("daemon/main.js") && l.includes(`--profiles-dir ${profilesDir}`))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

/** Close a session's tabs in a profile; the browser closes with its last tab. */
export async function closeTabsIn(s: TestSession, profile: string): Promise<void> {
  const ctx = (await s.call("tabs_context")).text.split("free tabs")[0];
  for (const m of ctx.matchAll(new RegExp(`^\\s+(\\d+)\\s+${profile}\\s`, "gm"))) await s.call("tabs_close", { tabId: Number(m[1]) });
}

export async function waitFor(check: () => boolean | Promise<boolean>, ms = 10000, step = 100): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(step);
  }
}
