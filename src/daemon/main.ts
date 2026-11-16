#!/usr/bin/env node
// camoufox-agentd: one per user (and config). Holds every browser; MCP servers are its
// clients (01-architecture.md). Socket server, client sessions, idle exit.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { resolve, sep } from "node:path";
import { VERSION, defaultProfilesDir, ensureDir, socketPath, type DaemonConfig } from "../paths.js";
import { readLines, send, fail, type Hello, type Request, type ToolResult } from "../protocol.js";
import { BrowserNotReady } from "./install.js";
import { ProfileManager } from "./profiles.js";
import type { Daemon, Session } from "./state.js";
import { ToolError } from "./state.js";
import { TabRegistry } from "./tabs.js";
import { deadlines, handlers } from "./tools.js";
import "./register.js";

function parseArgs(argv: string[]): { config: DaemonConfig; idleMs: number; socket: string } {
  const config: DaemonConfig = { profilesDir: defaultProfilesDir(), headless: false };
  let idleMs = Number(process.env.CAMOUFOX_AGENT_IDLE_MS) || 10 * 60 * 1000;
  let socket = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profiles-dir") config.profilesDir = resolve(argv[++i]);
    else if (a === "--headless") config.headless = true;
    else if (a === "--idle-ms") idleMs = Number(argv[++i]);
    else if (a === "--socket") socket = argv[++i];
  }
  return { config, idleMs, socket: socket || socketPath(config) };
}

const log = (...args: unknown[]) => console.error(new Date().toISOString(), ...args);

/** Is this pid a live daemon of ours? A pid alone is not enough: a dead daemon's pid may have been reused. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e: any) {
    if (e?.code !== "EPERM") return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(`daemon${sep}main.js`);
  } catch {
    return true; // no /proc here: believe the pid
  }
}

/**
 * The exclusive lock next to the socket: two MCP servers racing to start a daemon end
 * with one. Returns false when a live daemon already holds it.
 */
async function takeLock(lockPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      // Two daemons replacing a stale lock at once could both get here; the file names the winner.
      await new Promise((r) => setTimeout(r, 30 + Math.random() * 40));
      return readFileSync(lockPath, "utf8").trim() === String(process.pid);
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      let holder = NaN;
      try {
        holder = Number(readFileSync(lockPath, "utf8").trim());
      } catch {}
      if (Number.isFinite(holder) && holder > 0 && pidAlive(holder)) return false;
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
  return false;
}

const DEFAULT_DEADLINE = 30000;

async function main(): Promise<void> {
  const { config, idleMs, socket } = parseArgs(process.argv.slice(2));
  const lockPath = socket + ".lock";
  if (!(await takeLock(lockPath))) {
    log("another daemon holds", lockPath, "- exiting");
    process.exit(0);
  }
  ensureDir(config.profilesDir);

  const sessions = new Map<string, Session>();
  const daemon = { config, sessions, log } as Daemon;
  daemon.tabs = new TabRegistry(daemon);
  daemon.profiles = new ProfileManager(daemon);

  let server: Server;
  let exitWhenIdle = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  const shutdown = async (why: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutting down:", why);
    try {
      server?.close();
    } catch {}
    for (const s of sessions.values()) s.socket?.destroy();
    // Browsers are our children and are closed on every exit path (03).
    await Promise.race([daemon.profiles.closeAll(), new Promise((r) => setTimeout(r, 15000))]);
    // A clean exit needs no post-mortem; the log stays only after a crash.
    if (code === 0) {
      try {
        unlinkSync(socket + ".log");
      } catch {}
    }
    for (const f of [socket, lockPath]) {
      try {
        if (f !== lockPath || readFileSync(lockPath, "utf8").trim() === String(process.pid)) unlinkSync(f);
      } catch {}
    }
    process.exit(code);
  };

  const checkIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (sessions.size > 0 || shuttingDown) return;
    if (exitWhenIdle) return void shutdown("asked to exit once idle");
    idleTimer = setTimeout(() => {
      if (sessions.size === 0) void shutdown(`no clients for ${idleMs} ms`);
    }, idleMs);
  };

  const callTool = async (session: Session, name: string, args: any): Promise<ToolResult> => {
    const handler = handlers[name];
    if (!handler) return fail(`Unknown tool: ${name}`);
    const spec = deadlines[name];
    const limit = typeof spec === "function" ? spec(args ?? {}) : spec ?? DEFAULT_DEADLINE;
    let timer: NodeJS.Timeout;
    let result: ToolResult;
    const call = { daemon, session, cancelled: false };
    try {
      result = await Promise.race([
        handler(call, args ?? {}),
        new Promise<ToolResult>((_, reject) => {
          timer = setTimeout(() => ((call.cancelled = true), reject(new ToolError(`${name} did not finish within ${Math.round(limit / 1000)} s. The page may be wedged; try again, reload, or use another tab.`))), limit);
        }),
      ]);
    } catch (e: any) {
      if (!(e instanceof ToolError) && !(e instanceof BrowserNotReady)) log(`tool ${name} failed:`, e?.stack || e);
      result = fail(cleanError(e));
    } finally {
      clearTimeout(timer!);
    }
    if (session.notices.length) {
      const notices = session.notices.splice(0).join("\n");
      result = { ...result, content: [{ type: "text", text: notices }, ...result.content] };
    }
    return result;
  };

  const onConnection = (conn: Socket) => {
    let session: Session | null = null;
    readLines(conn, (msg: Request) => {
      void (async () => {
        try {
          if (msg.method === "hello") {
            const hello = msg.params as Hello;
            if (hello.version !== VERSION) {
              send(conn, { id: msg.id, error: { message: `version mismatch: daemon ${VERSION}, client ${hello.version}` } });
              return;
            }
            session = {
              id: hello.session,
              cwd: hello.cwd,
              defaultProfile: hello.defaultProfile,
              socket: conn,
              activeTab: null,
              notices: [],
              lostActive: null,
              hinted: new Set(),
            };
            sessions.set(session.id, session);
            checkIdle();
            send(conn, { id: msg.id, result: { version: VERSION, pid: process.pid } });
          } else if (msg.method === "status") {
            send(conn, {
              id: msg.id,
              result: { version: VERSION, pid: process.pid, sessions: sessions.size, profiles: daemon.profiles.list() },
            });
          } else if (msg.method === "exitWhenIdle") {
            exitWhenIdle = true;
            send(conn, { id: msg.id, result: { ok: true } });
            checkIdle();
          } else if (msg.method === "tool") {
            if (!session) return send(conn, { id: msg.id, error: { message: "hello first" } });
            const result = await callTool(session, msg.params?.name, msg.params?.args);
            send(conn, { id: msg.id, result });
          } else {
            send(conn, { id: msg.id, error: { message: `unknown method ${String((msg as any).method)}` } });
          }
        } catch (e: any) {
          send(conn, { id: msg.id, error: { message: String(e?.message || e) } });
        }
      })();
    });
    const gone = () => {
      if (!session) return;
      const s = session;
      session = null;
      if (sessions.get(s.id) !== s) return;
      sessions.delete(s.id);
      s.socket = null;
      // Its tabs are closed; browsers stay for other sessions (03).
      void daemon.tabs.closeSession(s).finally(checkIdle);
    };
    conn.on("close", gone);
    conn.on("error", gone);
  };

  // We hold the lock, so a socket file left here belongs to a dead daemon.
  if (existsSync(socket)) {
    try {
      unlinkSync(socket);
    } catch {}
  }
  server = createServer(onConnection);
  server.on("error", (e) => void shutdown(`socket error: ${e.message}`, 1));
  server.listen(socket, () => {
    log(`camoufox-agentd ${VERSION} listening on ${socket} (profiles: ${config.profilesDir}, headless: ${config.headless}, pid ${process.pid})`);
    checkIdle();
  });

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void shutdown(sig));
  process.on("uncaughtException", (e) => {
    log("uncaught exception:", e?.stack || e);
  });
  process.on("unhandledRejection", (e: any) => {
    log("unhandled rejection:", e?.stack || e);
  });
}

function cleanError(e: any): string {
  const msg = String(e?.message || e);
  if (e instanceof ToolError || e instanceof BrowserNotReady) return msg;
  // Playwright errors carry a call log and ANSI colours; the first line is the message.
  return msg.replace(/\u001b\[[0-9;]*m/g, "").split("\nCall log:")[0].trim();
}

void main();
