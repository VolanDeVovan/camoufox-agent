// Group `http`: http_request, fetch_markdown, extract_table (05-tools.md).
// Browserless HTTP with Firefox's TLS fingerprint (impit) and the profile's cookies.
// A cookie only ever goes to its own origin: the Cookie header is recomputed for
// every redirect hop, so a redirect cannot carry a session to another site (07).
import { existsSync } from "node:fs";
import { fail, text } from "../protocol.js";
import { validateProfileName } from "../paths.js";
import { htmlToMarkdown } from "./markdown.js";
import { evalWithin, goto } from "./navigation.js";
import { maskBody, maskHeaders, maskUrl, untrusted } from "./redact.js";
import { cookiesForUrl, scanStopped } from "./sessions.js";
import { callOn, refLocator } from "./snapshot.js";
import type { Daemon } from "./state.js";
import { ToolError } from "./state.js";
import { onTab, tool, type Call } from "./tools.js";
import { normalizeUrl } from "./navigation.js";

let impitModule: any = null;
async function client(timeoutMs: number): Promise<any> {
  if (!impitModule) {
    try {
      impitModule = await import("impit");
    } catch (e: any) {
      throw new ToolError(`The HTTP client (impit) is not available on this platform: ${e?.message || e}. Use the browser tools instead.`);
    }
  }
  return new impitModule.Impit({ browser: "firefox", timeout: timeoutMs, followRedirects: false });
}

/** The Cookie header a profile would send to this URL: live from a running browser, else from disk. */
async function cookieHeader(daemon: Daemon, profile: string, url: string): Promise<string> {
  const running = daemon.profiles.running(profile);
  if (running) {
    const cookies = await running.context.cookies([url]).catch(() => []);
    return cookies.filter((c: any) => !c.partitionKey).map((c) => `${c.name}=${c.value}`).join("; ");
  }
  const dir = daemon.profiles.dirOf(profile);
  if (!existsSync(dir)) return "";
  return cookiesForUrl(scanStopped(dir), url).map((c) => `${c.name}=${c.value}`).join("; ");
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
  trail: string[];
  sentCookies: boolean;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 8;

export async function httpFetch(
  daemon: Daemon,
  opts: { url: string; method?: string; headers?: Record<string, string>; body?: string; profile: string; useCookies: boolean; followRedirects: boolean; timeoutMs: number },
): Promise<HttpResult> {
  const http = await client(opts.timeoutMs);
  const own: Record<string, string> = { ...(opts.headers || {}) };
  let url = normalizeUrl(opts.url);
  let method = (opts.method || "GET").toUpperCase();
  let body = opts.body;
  const trail: string[] = [];
  let sentCookies = false;
  for (let hop = 0; ; hop++) {
    const headers: Record<string, string> = { ...own };
    const callerCookie = Object.keys(own).some((k) => k.toLowerCase() === "cookie");
    if (opts.useCookies && !callerCookie) {
      const cookie = await cookieHeader(daemon, opts.profile, url); // for THIS hop's URL only
      if (cookie) {
        headers["Cookie"] = cookie;
        sentCookies = true;
      }
    }
    const res = await http.fetch(url, { method, headers, ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}) });
    const resHeaders: Record<string, string> = {};
    try {
      for (const [k, v] of res.headers.entries()) resHeaders[k.toLowerCase()] = resHeaders[k.toLowerCase()] ? `${resHeaders[k.toLowerCase()]}\n${v}` : String(v);
    } catch {}
    const location = resHeaders["location"];
    if (!opts.followRedirects || !REDIRECTS.has(res.status) || !location) {
      return { status: res.status, headers: resHeaders, body: await res.text().catch(() => ""), url, trail, sentCookies };
    }
    if (hop >= MAX_HOPS) throw new ToolError(`Too many redirects (more than ${MAX_HOPS}): ${trail.join(" ")}`);
    let next: string;
    try {
      next = new URL(location, url).toString();
    } catch {
      throw new ToolError(`Redirect with an invalid Location header: ${location}`);
    }
    const sameOrigin = new URL(next).origin === new URL(url).origin;
    if (!sameOrigin) {
      // Credentials the caller put on the request belong to the first origin only.
      for (const k of Object.keys(own)) if (/^(cookie|authorization|proxy-authorization)$/i.test(k)) delete own[k];
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
      method = "GET";
      body = undefined;
    }
    trail.push(`${res.status} -> ${maskUrl(next)}${sameOrigin ? "" : " (another origin: credentials not carried over)"}`);
    url = next;
  }
}

function profileOf(call: Call, args: any): string {
  return validateProfileName(args.profile ?? call.session.defaultProfile);
}

tool("http_request", async (call, args) => {
  const profile = profileOf(call, args);
  const timeoutMs = Math.min(120, Math.max(1, args.timeout_s ?? 30)) * 1000;
  let r: HttpResult;
  try {
    r = await httpFetch(call.daemon, {
      url: String(args.url),
      method: args.method,
      headers: args.headers,
      body: args.body,
      profile,
      useCookies: args.use_cookies !== false,
      followRedirects: args.follow_redirects !== false,
      timeoutMs,
    });
  } catch (e: any) {
    if (e instanceof ToolError) throw e;
    return fail(`Request to ${maskUrl(String(args.url))} failed: ${String(e?.message || e).split("\n")[0].replace(/https?:\/\/\S+/g, (u) => maskUrl(u))}`);
  }
  const reveal = !!args.reveal_values;
  const max = args.max_chars ?? 20000;
  const shownBody = reveal ? r.body : maskBody(r.body);
  const head = [
    `${r.status} ${maskUrl(r.url)}`,
    ...(r.trail.length ? [`redirects: ${r.trail.join("; ")}`] : []),
    args.use_cookies === false ? "cookies: not sent" : r.sentCookies ? `cookies: sent from profile "${profile}" (each only to its own origin)` : `cookies: profile "${profile}" has none for this URL`,
    "headers:",
    ...Object.entries(reveal ? r.headers : maskHeaders(r.headers)).map(([k, v]) => `  ${k}: ${v}`),
  ].join("\n");
  const cut = shownBody.length > max ? shownBody.slice(0, max) + `\n[truncated at ${max} of ${shownBody.length} chars]` : shownBody;
  return text(`${head}\n${untrusted("body", cut || "(empty)")}`);
}, (args) => (Math.min(120, Math.max(1, args.timeout_s ?? 30)) + 10) * 1000);

tool("fetch_markdown", async (call, args) => {
  const profile = profileOf(call, args);
  const url = normalizeUrl(String(args.url));
  const max = args.max_chars ?? 30000;
  let html: string;
  let finalUrl = url;
  let how: string;
  if (args.use_browser) {
    // A JS page: render it in a tab of the profile, read the DOM, close the tab.
    const { daemon, session } = call;
    const previous = session.activeTab;
    const { tab, created } = await daemon.tabs.open(session, profile);
    if (created) session.notices.push(created);
    try {
      await goto(tab, url);
      html = (await evalWithin<string>(tab.page, "document.documentElement.outerHTML", 10000)) ?? "";
      finalUrl = tab.url();
    } finally {
      await daemon.tabs.close(tab).catch(() => {});
      session.activeTab = previous !== null && daemon.tabs.get(previous) ? previous : session.activeTab;
    }
    how = `rendered in a tab of profile "${profile}"`;
  } else {
    let r: HttpResult;
    try {
      r = await httpFetch(call.daemon, { url, profile, useCookies: args.use_cookies !== false, followRedirects: true, timeoutMs: 30000 });
    } catch (e: any) {
      if (e instanceof ToolError) throw e;
      return fail(`Request to ${maskUrl(url)} failed: ${String(e?.message || e).split("\n")[0].replace(/https?:\/\/\S+/g, (u) => maskUrl(u))}`);
    }
    if (r.status >= 400) return fail(`${maskUrl(r.url)} answered ${r.status}. For a page behind anti-bot protection or one that needs JavaScript, try use_browser=true or open it with navigate.`);
    html = r.body;
    finalUrl = r.url;
    how = "fetched without a browser";
  }
  // Link targets are URLs like any other: tokens in them are masked.
  const md = htmlToMarkdown(html, finalUrl).replace(/\]\((https?:[^)\s]+)\)/g, (_m, u) => `](${maskUrl(u)})`);
  if (md.replace(/^# .*\n?/, "").trim().length < 80 && !args.use_browser && /<script/i.test(html)) {
    return text(untrusted(`${maskUrl(finalUrl)} (${how})`, md || "(no text)") + "\nThe page has almost no text without JavaScript; use_browser=true renders it.");
  }
  const cut = md.length > max ? md.slice(0, max) + `\n\n[truncated at ${max} of ${md.length} chars]` : md;
  return text(untrusted(`${maskUrl(finalUrl)} as markdown (${how})`, cut || "(no text)"));
}, 90000);

const TABLE_FN = `function (el, arg) {
  function clean(t) { return String(t == null ? "" : t).replace(/\\s+/g, " ").trim(); }
  var tables;
  if (el && el.tagName) { var t = el.tagName === "TABLE" ? el : el.closest("table") || el.querySelector("table"); tables = t ? [t] : []; }
  else tables = Array.prototype.filter.call(document.querySelectorAll("table"), function (t) { return t.getBoundingClientRect().width > 0 && t.rows.length > 0; });
  var count = tables.length;
  var table = el && el.tagName ? tables[0] : tables[arg.index];
  if (!table) return JSON.stringify({ count: count });
  var rows = Array.prototype.slice.call(table.rows);
  var headRow = table.tHead && table.tHead.rows.length ? table.tHead.rows[table.tHead.rows.length - 1] : (rows[0] && rows[0].querySelector("th") ? rows[0] : null);
  var headers = headRow ? Array.prototype.map.call(headRow.cells, function (c) { return clean(c.innerText || c.textContent); }) : [];
  var body = rows.filter(function (r) { return r !== headRow && !(table.tHead && table.tHead.contains(r)); });
  var out = [];
  for (var i = 0; i < body.length && out.length < arg.max; i++) {
    var cells = Array.prototype.map.call(body[i].cells, function (c) { return clean(c.innerText || c.textContent); });
    if (!cells.length) continue;
    if (headers.length) { var o = {}; for (var j = 0; j < cells.length; j++) o[headers[j] || "col" + (j + 1)] = cells[j]; out.push(o); }
    else out.push(cells);
  }
  return JSON.stringify({ count: count, caption: table.caption ? clean(table.caption.innerText) : "", headers: headers, rows: out, total: body.length });
}`;

tool("extract_table", (call, args) =>
  onTab(call, args.tabId, async (tab) => {
    const arg = { index: args.index ?? 0, max: args.max_rows ?? 200 };
    let raw: string;
    if (args.ref) {
      const { locator } = await refLocator(tab, args.ref);
      raw = await callOn<string>(locator, TABLE_FN, arg);
    } else {
      raw = (await tab.page.evaluate(new Function("arg", `return (${TABLE_FN})(null, arg);`) as any, arg)) as string;
    }
    const t = JSON.parse(raw);
    if (!t.rows) {
      return fail(args.ref ? `No table at or around ${args.ref}.` : t.count ? `The page has ${t.count} table(s); index ${arg.index} does not exist.` : "The page has no visible HTML table.");
    }
    const head = `Table${args.ref ? ` at ${args.ref}` : ` ${arg.index + 1} of ${t.count}`}${t.caption ? ` "${t.caption}"` : ""}: ${t.rows.length} of ${t.total} row(s)${t.headers.length ? `, columns: ${t.headers.join(" | ")}` : ""}`;
    return text(untrusted(head, JSON.stringify(t.rows, null, 1)));
  }));
