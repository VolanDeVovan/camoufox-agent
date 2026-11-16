// The browser binary. The pinned `camoufox` launcher downloads it into its cache; we
// start that download in the background on first need and answer with progress until
// it is ready.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type State =
  | { status: "unknown" }
  | { status: "ready" }
  | { status: "downloading"; phase: string; percent: number | null; detail: string }
  | { status: "failed"; error: string };

let state: State = { status: "unknown" };
const settled = new Set<() => void>();

/** Is the browser being downloaded? The daemon must not exit meanwhile: that kills the download. */
export function downloading(): boolean {
  return state.status === "downloading";
}

/** Call `fn` whenever a download ends, ready or failed. */
export function onDownloadSettled(fn: () => void): void {
  settled.add(fn);
}

export class BrowserNotReady extends Error {}

async function installedPath(): Promise<string | null> {
  if ((process.env.CAMOUFOX_EXECUTABLE_PATH || "").trim()) return process.env.CAMOUFOX_EXECUTABLE_PATH!.trim();
  try {
    const { launchPath } = await import("camoufox/dist/pkgman.js" as string);
    const p = launchPath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** The fetch CLI of the same pinned launcher copy that will launch the browser. */
function launcherCli(): string {
  const entry = fileURLToPath(import.meta.resolve("camoufox"));
  return join(dirname(entry), "__main__.js");
}

function startDownload(): void {
  state = { status: "downloading", phase: "starting", percent: null, detail: "" };
  const child = spawn(process.execPath, [launcherCli(), "fetch"], { stdio: ["ignore", "pipe", "pipe"] });
  // The download must not outlive the daemon.
  const stop = () => child.kill();
  process.once("exit", stop);
  child.once("exit", () => process.removeListener("exit", stop));
  let tail = "";
  const onData = (chunk: Buffer) => {
    const s = chunk.toString("utf8");
    tail = (tail + s).slice(-2000);
    // The launcher prints a progress bar: "Downloading [███░░] 45% | ETA: 5s | 594 MB/1.3 GB"
    const all = [...tail.matchAll(/(\w[\w ]*?)\s*\[[^\]]*\]\s*(\d+)%(?:\s*\|\s*ETA:[^|]*\|\s*([^\r\n]+))?/g)];
    const last = all[all.length - 1];
    if (last && state.status === "downloading") {
      state = { status: "downloading", phase: last[1].trim(), percent: Number(last[2]), detail: (last[3] || "").trim() };
    } else if (/Extracting/i.test(s) && state.status === "downloading") {
      state = { status: "downloading", phase: "Extracting", percent: null, detail: "" };
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => {
    state = { status: "failed", error: String(e?.message || e) };
  });
  child.on("exit", async (code) => {
    if (code === 0 && (await installedPath())) state = { status: "ready" };
    else state = { status: "failed", error: `camoufox fetch exited with code ${code}: ${tail.replace(/\s+/g, " ").slice(-300)}` };
    for (const fn of settled) fn();
  });
}

/** Resolves when the browser is installed; throws BrowserNotReady with the progress otherwise. */
export async function requireBrowser(): Promise<void> {
  if (state.status === "ready") return;
  if (state.status === "unknown" || state.status === "failed") {
    const previous = state.status === "failed" ? state.error : "";
    if (await installedPath()) {
      state = { status: "ready" };
      return;
    }
    startDownload();
    throw new BrowserNotReady(
      (previous ? `The previous download attempt failed (${previous}). ` : "") +
        "The Camoufox browser is not installed yet; its download (about 1.3 GB, once) has just started. Call the tool again in a little while.",
    );
  }
  if (state.status === "downloading") {
    const pct = state.percent === null ? "" : ` ${state.percent}%`;
    const detail = state.detail ? ` (${state.detail})` : "";
    throw new BrowserNotReady(`The Camoufox browser is still being installed: ${state.phase}${pct}${detail}. Call the tool again in a little while.`);
  }
}
