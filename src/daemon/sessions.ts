// find_session and the cross-profile hint: which profile holds a
// session for a site. Evidence from cookie names and storage, never a "logged in" verdict,
// and never a cookie value.
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDomain } from "tldts";
import { decodeMozLz4 } from "./mozlz4.js";
import type { Daemon } from "./state.js";

const require = createRequire(import.meta.url);

export interface CookieInfo {
  host: string;
  name: string;
  value: string;
  path: string;
  /** Unix seconds; -1 for a session cookie. */
  expires: number;
  secure: boolean;
  httpOnly: boolean;
}

export interface ProfileScan {
  cookies: CookieInfo[];
  /** host -> which storages exist for it */
  storage: Map<string, { ls: boolean; idb: boolean }>;
}

const hostOf = (cookieHost: string) => cookieHost.replace(/^\./, "").toLowerCase();

/** eTLD+1, or the host itself for IPs, localhost and single-label hosts. */
export function registrable(host: string): string {
  const h = hostOf(host);
  return getDomain(h, { allowPrivateDomains: false }) || h;
}

// Anti-bot and analytics cookies never count as a session: every profile that ever
// passed a challenge would otherwise "have" the vendor.
const ANTIBOT = /^(cf_clearance|__cf_bm|_cfuvid|__cflb|__cfruid|cf_chl_.*|_px.*|pxcts|datadome|ak_bmsc|bm_sv|bm_sz|bm_mi|_abck|incap_ses_.*|visid_incap_.*|nlbi_.*|reese84|__ddg.*|aws-waf-token|_GRECAPTCHA)$/i;
const ANALYTICS = /^(_ga.*|_gid|_gat.*|_gcl_.*|_fbp|_fbc|__utm.*|_hj.*|_pk_.*|_clck|_clsk|mp_.*|ajs_.*|amp_.*|amplitude.*|optimizely.*|intercom-.*|_uetsid|_uetvid|_scid.*|_ttp|_tt_.*|__gads|__gpi|_dd_s|OptanonConsent|OptanonAlertBoxClosed|CookieConsent.*)$/i;
const AUTH = /sess|(^|[^a-z])v?ses\d*([^a-z]|$)|sid\b|sid$|^sid|auth|token|jwt|login|logged|sso|oauth|remember|identity|credential|account|user_?id|\buid\b|secure.*id/i;

export const isAntiBot = (name: string) => ANTIBOT.test(name);
export function authLooking(name: string): boolean {
  if (ANTIBOT.test(name) || ANALYTICS.test(name)) return false;
  return AUTH.test(name.replace(/^__(Secure|Host)-/i, ""));
}

interface OriginAttrs {
  partitioned: boolean;
  container: boolean;
}
function attrsOf(originAttributes: unknown): OriginAttrs {
  if (originAttributes && typeof originAttributes === "object") {
    const o = originAttributes as any;
    return { partitioned: !!o.partitionKey, container: !!o.userContextId && Number(o.userContextId) !== 0 };
  }
  const s = String(originAttributes || "");
  return { partitioned: /partitionKey=/.test(s), container: /userContextId=(?!0\b)\d+/.test(s) };
}

/** Rows of a stopped profile's cookies.sqlite, read without touching the profile. */
function readCookieDb(dir: string): CookieInfo[] {
  const db = join(dir, "cookies.sqlite");
  if (!existsSync(db)) return [];
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const query = (file: string, uri: boolean): CookieInfo[] => {
    const handle = uri ? new DatabaseSync(file, { readOnly: true } as any) : new DatabaseSync(file, { readOnly: true });
    try {
      const rows = handle.prepare("SELECT host, name, value, path, expiry, originAttributes, isSecure, isHttpOnly FROM moz_cookies").all() as any[];
      const out: CookieInfo[] = [];
      for (const r of rows) {
        const attrs = attrsOf(r.originAttributes);
        // Partitioned cookies (a vendor's cookie inside other sites) and container cookies are not this identity's sessions.
        if (attrs.partitioned || attrs.container) continue;
        let expiry = Number(r.expiry);
        if (expiry > 1e11) expiry = Math.floor(expiry / 1000); // newer schemas store milliseconds
        out.push({ host: String(r.host), name: String(r.name), value: String(r.value ?? ""), path: String(r.path || "/"), expires: expiry, secure: !!r.isSecure, httpOnly: !!r.isHttpOnly });
      }
      return out;
    } finally {
      handle.close();
    }
  };
  const wal = db + "-wal";
  const hasWal = existsSync(wal) && statSync(wal).size > 0;
  if (!hasWal) {
    // Immutable: no locks, no -shm, nothing written next to the profile's file.
    try {
      return query(`file:${encodeURI(db)}?immutable=1`, true);
    } catch {}
  }
  // A leftover -wal (the browser crashed) holds recent writes that immutable mode
  // would ignore. Read a private copy with its WAL, so the profile is never written to.
  const tmp = mkdtempSync(join(tmpdir(), "camoufox-agent-scan-"));
  try {
    copyFileSync(db, join(tmp, "cookies.sqlite"));
    if (hasWal) copyFileSync(wal, join(tmp, "cookies.sqlite-wal"));
    return query(join(tmp, "cookies.sqlite"), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Cookies without an expiry, as session restore keeps them. */
function readSessionCookies(dir: string): CookieInfo[] {
  const candidates = [join(dir, "sessionstore.jsonlz4"), join(dir, "sessionstore-backups", "recovery.jsonlz4")]
    .filter((f) => existsSync(f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of candidates) {
    try {
      const data = JSON.parse(decodeMozLz4(readFileSync(file)).toString("utf8"));
      const out: CookieInfo[] = [];
      for (const c of data.cookies || []) {
        const attrs = attrsOf(c.originAttributes);
        if (attrs.partitioned || attrs.container) continue;
        out.push({ host: String(c.host || ""), name: String(c.name || ""), value: String(c.value ?? ""), path: String(c.path || "/"), expires: -1, secure: !!c.secure, httpOnly: !!c.httponly });
      }
      return out;
    } catch {}
  }
  return [];
}

function readStorage(dir: string): ProfileScan["storage"] {
  const out: ProfileScan["storage"] = new Map();
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, "storage", "default"));
  } catch {}
  for (const name of names) {
    // "https+++dash.cloudflare.com", optionally "+8443", optionally "^userContextId=3&partitionKey=..."
    if (name.includes("^")) continue;
    const m = /^https?\+\+\+([^+^]+)/.exec(name);
    if (!m) continue;
    const base = join(dir, "storage", "default", name);
    const has = (sub: string) => {
      try {
        return readdirSync(join(base, sub)).length > 0;
      } catch {
        return false;
      }
    };
    const entry = out.get(m[1]) || { ls: false, idb: false };
    entry.ls ||= has("ls");
    entry.idb ||= has("idb");
    if (entry.ls || entry.idb) out.set(m[1], entry);
  }
  return out;
}

const cache = new Map<string, { key: string; scan: ProfileScan }>();
const mtime = (f: string) => {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

/** A stopped profile, read from disk and cached by file mtime, so the hint costs next to nothing. */
export function scanStopped(dir: string): ProfileScan {
  const key = ["cookies.sqlite", "cookies.sqlite-wal", "sessionstore.jsonlz4", join("sessionstore-backups", "recovery.jsonlz4"), join("storage", "default")]
    .map((f) => mtime(join(dir, f)))
    .join(":");
  const hit = cache.get(dir);
  if (hit && hit.key === key) return hit.scan;
  let cookies: CookieInfo[] = [];
  try {
    cookies = readCookieDb(dir);
  } catch {}
  const seen = new Set(cookies.map((c) => `${c.host}|${c.name}|${c.path}`));
  for (const c of readSessionCookies(dir)) if (!seen.has(`${c.host}|${c.name}|${c.path}`)) cookies.push(c);
  const scan = { cookies, storage: readStorage(dir) };
  cache.set(dir, { key, scan });
  return scan;
}

/** A profile's cookies and storage: from the live browser when it runs (never from disk then), else from disk. */
export async function scanProfile(daemon: Daemon, name: string): Promise<ProfileScan> {
  const running = daemon.profiles.running(name);
  if (!running) return scanStopped(daemon.profiles.dirOf(name));
  const live = await running.context.cookies();
  const cookies: CookieInfo[] = live
    .filter((c: any) => !c.partitionKey)
    .map((c) => ({ host: c.domain, name: c.name, value: c.value, path: c.path, expires: c.expires, secure: c.secure, httpOnly: c.httpOnly }));
  return { cookies, storage: readStorage(running.dir) };
}

/** Cookies a browser would send to `url`, from a scan. Used by http_request for a stopped profile. */
export function cookiesForUrl(scan: ProfileScan, url: string): CookieInfo[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const host = u.hostname.toLowerCase();
  const now = Date.now() / 1000;
  return scan.cookies.filter((c) => {
    if (c.expires !== -1 && c.expires <= now) return false;
    if (c.secure && u.protocol !== "https:") return false;
    const domain = hostOf(c.host);
    const domainOk = c.host.startsWith(".") ? host === domain || host.endsWith("." + domain) : host === domain;
    if (!domainOk) return false;
    const path = c.path || "/";
    return u.pathname === path || u.pathname.startsWith(path.endsWith("/") ? path : path + "/") || path === "/";
  });
}

function siteMatcher(site: string): { label: string; match: (host: string) => boolean } {
  let s = site.trim().toLowerCase();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = new URL(s).hostname;
  } catch {}
  s = s.replace(/^\.+|\/.*$/g, "");
  if (!s.includes(".") && s !== "localhost") {
    // A bare name: the registrable domain's first label. "cloudflare" matches
    // cloudflare.com and its hosts, not cloudflareinsights.com.
    return { label: s, match: (host) => registrable(host).split(".")[0] === s || hostOf(host) === s };
  }
  const domain = registrable(s);
  return { label: domain, match: (host) => registrable(host) === domain };
}

function ago(seconds: number): string {
  const s = Math.abs(seconds);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

interface HostEvidence {
  host: string;
  live: CookieInfo[];
  expired: CookieInfo[];
  auth: string[];
  ls: boolean;
  idb: boolean;
}

function evidence(scan: ProfileScan, match: (host: string) => boolean): HostEvidence[] {
  const now = Date.now() / 1000;
  const byHost = new Map<string, HostEvidence>();
  const at = (host: string) => {
    let e = byHost.get(host);
    if (!e) byHost.set(host, (e = { host, live: [], expired: [], auth: [], ls: false, idb: false }));
    return e;
  };
  for (const c of scan.cookies) {
    const host = hostOf(c.host);
    if (!match(host)) continue;
    const e = at(host);
    if (c.expires !== -1 && c.expires <= now) e.expired.push(c);
    else {
      e.live.push(c);
      if (authLooking(c.name) && !e.auth.includes(c.name)) e.auth.push(c.name);
    }
  }
  for (const [host, st] of scan.storage) {
    if (!match(host)) continue;
    const e = at(host);
    e.ls = st.ls;
    e.idb = st.idb;
  }
  // Hosts with nothing but anti-bot cookies and no storage are not evidence of anything.
  return [...byHost.values()]
    .filter((e) => e.ls || e.idb || e.expired.length || e.live.some((c) => !isAntiBot(c.name)))
    .sort((a, b) => b.auth.length - a.auth.length || b.live.length - a.live.length);
}

function describeHost(e: HostEvidence): string[] {
  const now = Date.now() / 1000;
  const pad = e.host.padEnd(Math.max(22, e.host.length + 2));
  let first: string;
  if (e.live.length) {
    // Expiry is about the session, so it is the auth-looking cookies' and is not shown without any.
    const auth = e.live.filter((c) => e.auth.includes(c.name));
    const latest = Math.max(0, ...auth.filter((c) => c.expires !== -1).map((c) => c.expires));
    const expiry = !auth.length ? "" : latest ? `; latest expiry in ${ago(latest - now)}` : "; session cookies (kept by session restore)";
    first = `${e.live.length} cookie${e.live.length === 1 ? "" : "s"}, ${e.auth.length ? `auth-looking: ${e.auth.slice(0, 8).join(", ")}` : "none auth-looking"}${expiry}`;
  } else if (e.expired.length) {
    const latest = Math.max(...e.expired.map((c) => c.expires));
    first = `session expired ${ago(now - latest)} ago (${e.expired.length} expired cookie${e.expired.length === 1 ? "" : "s"})`;
  } else first = "cookies none";
  const out = [`    ${pad}${first}`];
  if (e.ls || e.idb || !e.live.length) out.push(`    ${" ".repeat(pad.length)}localStorage ${e.ls ? "yes" : "no"}, IndexedDB ${e.idb ? "yes" : "no"}`);
  return out;
}

export async function findSession(daemon: Daemon, site: string): Promise<string> {
  const { label, match } = siteMatcher(site);
  const profiles = daemon.profiles.list();
  if (!profiles.length) return `No profiles exist yet, so no profile holds a session for ${label}.`;
  const hits: { name: string; running: boolean; hosts: HostEvidence[] }[] = [];
  const empty: string[] = [];
  for (const p of profiles) {
    let hosts: HostEvidence[] = [];
    try {
      hosts = evidence(await scanProfile(daemon, p.name), match);
    } catch {}
    if (hosts.length) hits.push({ name: p.name, running: p.running, hosts });
    else empty.push(p.name);
  }
  if (!hits.length) return `${label}: no profile holds cookies or storage for it (looked in: ${profiles.map((p) => p.name).join(", ")}).`;
  hits.sort((a, b) => Number(b.hosts.some((h) => h.auth.length > 0)) - Number(a.hosts.some((h) => h.auth.length > 0)));
  const lines = [`${label}:`];
  for (const h of hits) {
    lines.push(`  ${h.name}${h.running ? " (running)" : ""}`);
    for (const host of h.hosts.slice(0, 12)) lines.push(...describeHost(host));
    if (h.hosts.length > 12) lines.push(`    … ${h.hosts.length - 12} more hosts`);
  }
  if (empty.length) lines.push(`  nothing in: ${empty.join(", ")}`);
  lines.push("This is evidence, not a verdict: open a tab in the profile and check the page before acting.");
  return lines.join("\n");
}

/**
 * The safety net behind rule 2: one line when the profile a tab is in has no
 * auth-looking cookie for the site and another profile has. The server never
 * switches profiles by itself.
 */
export async function crossProfileHint(daemon: Daemon, currentProfile: string, url: string): Promise<{ domain: string; line: string } | null> {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  const domain = registrable(host);
  const match = (h: string) => registrable(h) === domain;
  const hasAuth = (hosts: HostEvidence[]) => hosts.some((h) => h.auth.length > 0);
  if (hasAuth(evidence(await scanProfile(daemon, currentProfile), match))) return null;
  for (const p of daemon.profiles.list()) {
    if (p.name === currentProfile) continue;
    let hosts: HostEvidence[];
    try {
      hosts = evidence(await scanProfile(daemon, p.name), match);
    } catch {
      continue;
    }
    const best = hosts.find((h) => h.auth.length > 0);
    if (!best) continue;
    return {
      domain,
      line: `Note: ${p.name} has cookies for ${best.host} (${best.auth.slice(0, 4).join(", ")}) - tabs_create(url, profile="${p.name}") to use that session.`,
    };
  }
  return null;
}
