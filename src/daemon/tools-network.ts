// read_console_messages, read_network_requests and the `network` group (05-tools.md).
// Capture is on from the moment a tab exists (capture.ts); everything shown is masked
// unless reveal_values (07).
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, text } from "../protocol.js";
import { VERSION, downloadsDir, ensureDir } from "../paths.js";
import { formatSize, type NetEntry } from "./capture.js";
import { maskBody, maskHeaders, maskTokensInText, maskUrl, untrusted } from "./redact.js";
import { ToolError } from "./state.js";
import type { Tab } from "./tabs.js";
import { resolveLocalPath } from "./tools-computer.js";
import { tool, withTab } from "./tools.js";
import { urlMatches } from "./tools-wait.js";

function matcher(pattern: string | undefined, what: string): (s: string) => boolean {
  if (!pattern) return () => true;
  try {
    const re = new RegExp(pattern, "i");
    return (s) => re.test(s);
  } catch {
    throw new ToolError(`Invalid ${what} pattern ${JSON.stringify(pattern)}: it is a regular expression.`);
  }
}

const clock = (at: number) => new Date(at).toISOString().slice(11, 23);

const LEVELS: Record<string, string[]> = {
  error: ["error", "assert"],
  warning: ["warning", "warn"],
  info: ["info"],
  log: ["log"],
  debug: ["debug", "trace"],
};

tool("read_console_messages", (call, args) =>
  withTab(call, args.tabId, async (tab) => {
    const match = matcher(args.pattern, "console");
    const levels = args.level && args.level !== "all" ? LEVELS[args.level] || [args.level] : null;
    const all = tab.console.filter((m) => (!levels || levels.includes(m.level)) && match(m.text));
    const limit = args.limit ?? 100;
    const shown = all.slice(-limit);
    const lines = shown.map((m) => {
      const body = args.reveal_values ? m.text : maskTokensInText(m.text);
      return `[${clock(m.at)}] ${m.level}: ${body.length > 2000 ? body.slice(0, 2000) + "…" : body}${m.location ? `  (${maskUrl(m.location)})` : ""}`;
    });
    const total = tab.console.length;
    if (args.clear) tab.console.length = 0;
    const head = `Console of tab ${tab.id}: ${shown.length} of ${all.length} matching message(s)${all.length !== total ? `, ${total} captured in all` : ""}${args.clear ? "; buffer cleared" : ""}`;
    return text(lines.length ? untrusted(head, lines.join("\n")) : head + ".");
  }));

function requestLine(e: NetEntry, reveal: boolean): string {
  const status = e.failed ? `FAILED (${e.failed})` : e.status === null ? "pending" : String(e.status);
  const extra = [e.resourceType, e.size !== null ? formatSize(e.size) : "", e.durationMs !== null ? `${e.durationMs} ms` : ""].filter(Boolean).join(", ");
  return `#${e.id} ${e.method} ${status} ${reveal ? e.url : maskUrl(e.url)} (${extra})`;
}

function selectRequests(tab: Tab, args: any): NetEntry[] {
  const match = matcher(args.pattern, "URL");
  const since = args.since ?? 0;
  return tab.requests.filter(
    (e) =>
      e.id > since &&
      match(e.url) &&
      (!args.resource_type || e.resourceType === args.resource_type) &&
      (!args.method || e.method === String(args.method).toUpperCase()) &&
      (!args.failed_only || !!e.failed || (e.status !== null && e.status >= 400)),
  );
}

tool("read_network_requests", (call, args) =>
  withTab(call, args.tabId, async (tab) => {
    const all = selectRequests(tab, args);
    const limit = args.limit ?? 100;
    const shown = all.slice(-limit);
    const lines = shown.map((e) => requestLine(e, !!args.reveal_values));
    const total = tab.requests.length;
    if (args.clear) tab.requests.length = 0;
    const head = `Network of tab ${tab.id}: ${shown.length} of ${all.length} matching request(s)${all.length !== total ? `, ${total} captured in all` : ""}${args.clear ? "; buffer cleared" : ""}. get_network_request(id) shows headers and bodies`;
    return text(lines.length ? untrusted(head, lines.join("\n")) : head + ".");
  }));

function findRequest(tab: Tab, id: number): NetEntry {
  const entry = tab.requests.find((e) => e.id === id);
  if (!entry) throw new ToolError(`No captured request #${id} in tab ${tab.id} (ids come from read_network_requests; old entries are dropped after 1000 requests).`);
  return entry;
}

function headerLines(headers: Record<string, string>, reveal: boolean): string {
  const shown = reveal ? headers : maskHeaders(headers);
  return Object.entries(shown)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
}

function detail(e: NetEntry, reveal: boolean, maxChars: number): string {
  const cut = (s: string) => (s.length > maxChars ? s.slice(0, maxChars) + `\n[truncated at ${maxChars} of ${s.length} chars]` : s);
  const out = [requestLine(e, reveal), "request headers:", headerLines(e.requestHeaders, reveal)];
  if (e.postData !== null) out.push("request body:", cut(reveal ? e.postData : maskBody(e.postData)));
  if (e.status !== null) {
    out.push(`response: ${e.status} ${e.statusText}`.trim(), "response headers:", headerLines(e.responseHeaders, reveal));
    if (e.body !== null) out.push("response body:", cut(reveal ? e.body : maskBody(e.body)));
    if (e.bodyNote) out.push(`(${e.bodyNote})`);
  } else if (e.failed) out.push(`failed: ${e.failed}`);
  else out.push("(no response yet)");
  return out.join("\n");
}

tool("get_network_request", (call, args) =>
  withTab(call, args.tabId, async (tab) => {
    const e = findRequest(tab, args.id);
    return text(untrusted(`Request #${e.id} of tab ${tab.id}`, detail(e, !!args.reveal_values, args.max_chars ?? 20000)));
  }));

tool("wait_for_network", (call, args) =>
  withTab(call, args.tabId, async (tab) => {
    const timeout = Math.min(120, Math.max(0.1, args.timeout_s ?? 15)) * 1000;
    const match = matcher(args.pattern, "URL");
    const since = args.since ?? tab.requestSeq;
    const wantRequest = args.phase === "request";
    const fits = (e: NetEntry) => e.id > since && match(e.url) && (!args.method || e.method === String(args.method).toUpperCase()) && (wantRequest || e.finished);
    const found = await new Promise<NetEntry | null>((resolve) => {
      const have = tab.requests.find(fits);
      if (have) return resolve(have);
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeout);
      const off = tab.onNet((entry) => {
        if (!fits(entry)) return;
        clearTimeout(timer);
        off();
        resolve(entry);
      });
    });
    if (!found) {
      return fail(`No ${wantRequest ? "request" : "finished response"} matching ${JSON.stringify(args.pattern)} within ${timeout / 1000} s (looking at requests after #${since}; since=0 includes earlier ones).`);
    }
    return text(untrusted(`Matched request #${found.id} in tab ${tab.id}`, detail(found, !!args.reveal_values, args.max_chars ?? 8000)));
  }), (args) => (Math.min(120, Math.max(0.1, args.timeout_s ?? 15)) + 10) * 1000);

tool("block_requests", (call, args) =>
  withTab(call, args.tabId, async (tab) => {
    if (tab.blocking) {
      await tab.page.unroute("**/*", tab.blocking.handler).catch(() => {});
      tab.blocking = null;
    }
    const types: string[] = args.resource_types || [];
    const patterns: string[] = args.url_patterns || [];
    if (args.off || (!types.length && !patterns.length)) return text(`Tab ${tab.id}: request blocking is off.`);
    const typeSet = new Set(types);
    const handler = (route: any) => {
      const req = route.request();
      if (typeSet.has(req.resourceType()) || patterns.some((p) => urlMatches(req.url(), p))) return route.abort("blockedbyclient").catch(() => {});
      return route.fallback().catch(() => {});
    };
    await tab.page.route("**/*", handler);
    tab.blocking = { types: typeSet, patterns, handler };
    const what = [types.length ? `resource types ${types.join(", ")}` : "", patterns.length ? `URLs matching ${patterns.map((p) => JSON.stringify(p)).join(", ")}` : ""].filter(Boolean).join(" and ");
    return text(`Tab ${tab.id}: blocking ${what}. block_requests(off=true) stops it.`);
  }));

function harEntry(e: NetEntry): any {
  const pairs = (h: Record<string, string>) => Object.entries(h).flatMap(([name, value]) => String(value).split("\n").map((v) => ({ name, value: v })));
  let query: { name: string; value: string }[] = [];
  try {
    query = [...new URL(e.url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {}
  return {
    startedDateTime: new Date(e.at).toISOString(),
    time: e.durationMs ?? 0,
    request: {
      method: e.method,
      url: e.url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: pairs(e.requestHeaders),
      queryString: query,
      headersSize: -1,
      bodySize: e.postData ? Buffer.byteLength(e.postData) : 0,
      ...(e.postData !== null ? { postData: { mimeType: e.requestHeaders["content-type"] || "", text: e.postData } } : {}),
    },
    response: {
      status: e.status ?? 0,
      statusText: e.failed ? e.failed : e.statusText,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: pairs(e.responseHeaders),
      content: { size: e.size ?? -1, mimeType: e.mimeType || "", ...(e.body !== null ? { text: e.body } : {}), ...(e.bodyNote ? { comment: e.bodyNote } : {}) },
      redirectURL: e.responseHeaders["location"] || "",
      headersSize: -1,
      bodySize: e.size ?? -1,
    },
    cache: {},
    timings: { send: 0, wait: e.durationMs ?? 0, receive: 0 },
    _resourceType: e.resourceType,
  };
}

tool("export_har", (call, args) =>
  withTab(call, args.tabId, async (tab) => {
    const entries = selectRequests(tab, args);
    if (!entries.length) return fail(`No captured requests${args.pattern ? ` matching ${JSON.stringify(args.pattern)}` : ""} in tab ${tab.id}.`);
    const har = {
      log: {
        version: "1.2",
        creator: { name: "camoufox-agent", version: VERSION },
        pages: [{ startedDateTime: new Date(entries[0].at).toISOString(), id: "page_1", title: await tab.title(), pageTimings: {} }],
        entries: entries.map((e) => ({ pageref: "page_1", ...harEntry(e) })),
      },
    };
    const target = args.path
      ? resolveLocalPath(args.path, call.session.cwd)
      : join(ensureDir(downloadsDir(), 0o755), `tab-${tab.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.har`);
    // The file holds real cookies and tokens: owner-only.
    writeFileSync(target, JSON.stringify(har, null, 1), { mode: 0o600 });
    chmodSync(target, 0o600); // the mode above applies only to a file that did not exist
    return text(`Wrote ${entries.length} request(s) of tab ${tab.id} as HAR 1.2 to ${target} (mode 0600: it holds real cookies and tokens, unmasked).`);
  }));

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

tool("export_curl", (call, args) =>
  withTab(call, args.tabId, async (tab) => {
    const e = findRequest(tab, args.id);
    const reveal = !!args.reveal_values;
    const headers = reveal ? e.requestHeaders : maskHeaders(e.requestHeaders);
    const parts = [`curl ${shq(reveal ? e.url : maskUrl(e.url))}`];
    if (e.method !== "GET" && !(e.method === "POST" && e.postData !== null)) parts.push(`-X ${e.method}`);
    for (const [k, v] of Object.entries(headers)) {
      if (/^(host|content-length|connection)$/i.test(k) || k.startsWith(":")) continue;
      parts.push(`-H ${shq(`${k}: ${v}`)}`);
    }
    if (e.postData !== null) parts.push(`--data-raw ${shq(reveal ? e.postData : maskBody(e.postData))}`);
    parts.push("--compressed");
    return text(parts.join(" \\\n  ") + (reveal ? "" : "\n\n(secrets are masked; reveal_values=true gives a command that runs as is)"));
  }));
