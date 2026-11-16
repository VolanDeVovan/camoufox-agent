// Per-tab capture, on from the moment a tab exists: console, page errors, network,
// dialogs, downloads.
import { statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { existsSync } from "node:fs";
import type { Dialog, Download, Request } from "playwright-core";
import { downloadsDir, ensureDir } from "../paths.js";
import type { Tab } from "./tabs.js";

export interface ConsoleEntry {
  at: number;
  level: string;
  text: string;
  location: string;
}

export interface NetEntry {
  id: number;
  at: number;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  postData: string | null;
  status: number | null;
  statusText: string;
  responseHeaders: Record<string, string>;
  mimeType: string;
  /** Text body, when it was captured. */
  body: string | null;
  bodyNote: string;
  size: number | null;
  failed: string | null;
  finished: boolean;
  durationMs: number | null;
}

export interface DialogAnswer {
  accept: boolean;
  promptText?: string;
}

const MAX_CONSOLE = 1000;
const MAX_REQUESTS = 1000;
const MAX_BODY = 512 * 1024;
const TEXT_MIME = /json|text\/|xml|javascript|x-www-form-urlencoded|graphql/i;
const NO_BODY_TYPES = new Set(["image", "font", "media", "stylesheet", "script"]);

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function safeFileName(name: string): string {
  const clean = basename(String(name || "download")).replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_").replace(/^\.+/, "_");
  return clean.slice(0, 180) || "download";
}

function uniquePath(dir: string, name: string): string {
  let candidate = join(dir, name);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; existsSync(candidate); i++) candidate = join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

export function attachCapture(tab: Tab): void {
  const page = tab.page;

  page.on("console", (msg) => {
    const loc = msg.location();
    tab.console.push({
      at: Date.now(),
      level: msg.type(),
      text: msg.text(),
      location: loc?.url ? `${loc.url}:${loc.lineNumber}` : "",
    });
    if (tab.console.length > MAX_CONSOLE) tab.console.splice(0, tab.console.length - MAX_CONSOLE);
  });
  page.on("pageerror", (err) => {
    tab.console.push({ at: Date.now(), level: "error", text: `Uncaught ${err?.name || "Error"}: ${err?.message || err}`, location: "" });
    if (tab.console.length > MAX_CONSOLE) tab.console.splice(0, tab.console.length - MAX_CONSOLE);
  });

  const entries = new WeakMap<Request, NetEntry>();
  page.on("request", (req) => {
    const entry: NetEntry = {
      id: ++tab.requestSeq,
      at: Date.now(),
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      requestHeaders: req.headers(),
      postData: null,
      status: null,
      statusText: "",
      responseHeaders: {},
      mimeType: "",
      body: null,
      bodyNote: "",
      size: null,
      failed: null,
      finished: false,
      durationMs: null,
    };
    try {
      const post = req.postData();
      if (post) entry.postData = post.length > MAX_BODY ? post.slice(0, MAX_BODY) + "…[truncated]" : post;
    } catch {}
    entries.set(req, entry);
    tab.requests.push(entry);
    if (tab.requests.length > MAX_REQUESTS) tab.requests.splice(0, tab.requests.length - MAX_REQUESTS);
    tab.inflight++;
    tab.emitNet(entry, "request");
  });
  page.on("response", (res) => {
    const entry = entries.get(res.request());
    if (!entry) return;
    entry.status = res.status();
    entry.statusText = res.statusText();
    entry.responseHeaders = res.headers();
    entry.mimeType = (entry.responseHeaders["content-type"] || "").split(";")[0].trim();
    tab.emitNet(entry, "response");
  });
  page.on("requestfinished", async (req) => {
    const entry = entries.get(req);
    if (!entry) return;
    tab.inflight = Math.max(0, tab.inflight - 1);
    entry.durationMs = Date.now() - entry.at;
    try {
      entry.requestHeaders = await req.allHeaders();
    } catch {}
    try {
      const res = await req.response();
      if (res) {
        entry.responseHeaders = await res.allHeaders().catch(() => entry.responseHeaders);
        if (NO_BODY_TYPES.has(entry.resourceType)) entry.bodyNote = `body not captured for ${entry.resourceType} resources`;
        else if (entry.mimeType && !TEXT_MIME.test(entry.mimeType)) entry.bodyNote = `body not captured: ${entry.mimeType} is not text`;
        else {
          const buf = await res.body();
          entry.size = buf.length;
          if (buf.length > MAX_BODY) {
            entry.body = buf.subarray(0, MAX_BODY).toString("utf8");
            entry.bodyNote = `body truncated at ${formatSize(MAX_BODY)} of ${formatSize(buf.length)}`;
          } else entry.body = buf.toString("utf8");
        }
      }
    } catch (e: any) {
      entry.bodyNote = `body unavailable: ${String(e?.message || e).split("\n")[0]}`;
    }
    entry.finished = true;
    tab.emitNet(entry, "finished");
  });
  page.on("requestfailed", (req) => {
    const entry = entries.get(req);
    if (!entry) return;
    tab.inflight = Math.max(0, tab.inflight - 1);
    entry.failed = req.failure()?.errorText || "failed";
    entry.finished = true;
    entry.durationMs = Date.now() - entry.at;
    tab.emitNet(entry, "finished");
  });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      tab.navSeq++;
      tab.pristine = false;
    }
  });

  // Every dialog must be answered, or the page hangs. Without an armed answer the
  // default is dismiss, and the action that caused it reports that.
  page.on("dialog", async (dialog: Dialog) => {
    const type = dialog.type();
    const message = dialog.message();
    let answer: DialogAnswer;
    let why: string;
    if (type === "beforeunload") {
      answer = { accept: true };
      why = "accepted so the page can leave";
    } else if (tab.dialogOnce) {
      answer = tab.dialogOnce;
      tab.dialogOnce = null;
      why = `${answer.accept ? "accepted" : "dismissed"} by the armed handle_dialog answer`;
    } else if (tab.dialogRule) {
      answer = tab.dialogRule;
      why = `${answer.accept ? "accepted" : "dismissed"} by the standing handle_dialog rule`;
    } else {
      answer = { accept: false };
      why = "dismissed (no handle_dialog answer was armed)";
    }
    try {
      if (answer.accept) await dialog.accept(type === "prompt" ? answer.promptText ?? dialog.defaultValue() : undefined);
      else await dialog.dismiss();
    } catch {}
    const shown = message.length > 300 ? message.slice(0, 300) + "…" : message;
    const withText = answer.accept && type === "prompt" && answer.promptText !== undefined ? ` with text ${JSON.stringify(answer.promptText)}` : "";
    tab.pushEvent("dialog", `opened ${type} dialog ${JSON.stringify(shown)}: ${why}${withText}`);
  });

  // Downloads go to a fixed directory, not Playwright's temp folder, which dies with the context.
  page.on("download", (download: Download) => {
    const name = safeFileName(download.suggestedFilename());
    const event = tab.pushEvent("download", `download of ${name} started`);
    event.done = (async () => {
      try {
        const dir = ensureDir(downloadsDir(), 0o755);
        const target = uniquePath(dir, name);
        await download.saveAs(target);
        event.text = `downloaded ${basename(target)} (${formatSize(statSync(target).size)}) to ${target}`;
      } catch (e: any) {
        event.text = `download of ${name} failed: ${String(e?.message || e).split("\n")[0]}`;
      }
    })();
  });
}
