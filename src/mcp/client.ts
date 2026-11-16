// The MCP server's connection to the daemon. Starts the daemon on first need
// (detached), reconnects if it went away, forwards one request per tool call.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openSync, readdirSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, runtimeDir, socketPath, type DaemonConfig } from "../paths.js";
import { readLines, send, type Request, type Response, type ToolResult } from "../protocol.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tryConnect(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", () => resolve(null));
  });
}

export class DaemonClient {
  readonly session = randomUUID();
  readonly socketFile: string;
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private retiredOld = false;

  constructor(
    private config: DaemonConfig,
    private defaultProfile: string,
  ) {
    this.socketFile = socketPath(config);
  }

  private spawnDaemon(): void {
    const main = join(dirname(fileURLToPath(import.meta.url)), "..", "daemon", "main.js");
    const args = [main, "--profiles-dir", this.config.profilesDir, "--socket", this.socketFile];
    if (this.config.headless) args.push("--headless");
    const logFd = openSync(this.socketFile + ".log", "a", 0o600);
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", logFd, logFd] });
    child.on("error", () => {});
    child.unref();
  }

  /** A daemon of another version on the same config is asked to exit once idle (01). */
  private retireOtherVersions(): void {
    if (this.retiredOld) return;
    this.retiredOld = true;
    const mine = basename(this.socketFile);
    const suffixOf = (name: string) => name.match(/(-[0-9a-f]{10})?\.sock$/)?.[1] || "";
    let names: string[] = [];
    try {
      names = readdirSync(runtimeDir());
    } catch {}
    for (const name of names) {
      if (!/^camoufox-agent-.+\.sock$/.test(name) || name === mine || suffixOf(name) !== suffixOf(mine)) continue;
      void tryConnect(join(runtimeDir(), name)).then((s) => {
        if (!s) return;
        send(s, { id: 1, method: "exitWhenIdle" });
        setTimeout(() => s.destroy(), 500);
      });
    }
  }

  private async open(): Promise<Socket> {
    let socket = await tryConnect(this.socketFile);
    if (!socket) {
      this.spawnDaemon();
      const deadline = Date.now() + 30000;
      for (let tries = 1; !socket && Date.now() < deadline; tries++) {
        await sleep(100);
        socket = await tryConnect(this.socketFile);
        // A daemon that is shutting down still holds the lock for a while, and the one
        // we started then exits at once: start another every couple of seconds.
        if (!socket && tries % 20 === 0) this.spawnDaemon();
      }
      if (!socket) throw new Error(`Could not start the camoufox-agent daemon (see ${this.socketFile}.log).`);
    }
    this.retireOtherVersions();
    readLines(socket, (msg: Response) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    const lost = () => {
      if (this.socket === socket) this.socket = null;
      for (const p of this.pending.values()) p.reject(new Error("The camoufox-agent daemon went away during the call; its browsers and this session's tabs are gone. The next call starts a new one."));
      this.pending.clear();
    };
    socket.on("close", lost);
    socket.on("error", lost);
    this.socket = socket;
    await this.request(socket, "hello", {
      version: VERSION,
      session: this.session,
      cwd: process.cwd(),
      defaultProfile: this.defaultProfile,
    });
    return socket;
  }

  private request(socket: Socket, method: Request["method"], params?: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      send(socket, { id, method, params });
    });
  }

  private async connection(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (!this.connecting) {
      this.connecting = this.open().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    const socket = await this.connection();
    return this.request(socket, "tool", { name, args });
  }

  async status(): Promise<any> {
    return this.request(await this.connection(), "status");
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
