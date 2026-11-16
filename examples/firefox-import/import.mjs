#!/usr/bin/env node
// Example, not part of the package: copy one Firefox container (or the no-container
// jar) into a camoufox-agent profile. No CLI contract, no support promise: copy it,
// adapt it, run it from your own scripts. See README.md next to this file.
//
//   node import.mjs --firefox-profile ~/.mozilla/firefox/xxxx.default \
//                   --container Work --target ~/.local/share/camoufox-agent/profiles/work [--storage] [--dry-run]
//
// Nothing is ever written to the Firefox profile, and no cookie value is printed.
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as sqlite from "node:sqlite";

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { container: "none", storage: false, idb: false, dryRun: false, domains: null, sessionDays: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (argv[i + 1] === undefined) fail(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--firefox-profile") out.source = expand(value());
    else if (a === "--target") out.target = expand(value());
    else if (a === "--container") out.container = value();
    else if (a === "--storage") out.storage = true;
    else if (a === "--idb") out.storage = out.idb = true;
    else if (a === "--domains") out.domains = value().split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    else if (a === "--session-days") out.sessionDays = Number(value());
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--list") out.list = true;
    else fail(`unknown argument ${a}`);
  }
  if (!out.source) fail("--firefox-profile DIR is required");
  if (!out.list && !out.target) fail("--target DIR (a camoufox-agent profile directory) is required");
  return out;
}

function expand(p) {
  return resolve(p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
}

function fail(message) {
  console.error(`firefox-import: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- helpers

/** Is a Firefox-family browser running on this profile? (the `lock` symlink names its pid) */
function lockHolder(dir) {
  try {
    const m = readlinkSync(join(dir, "lock")).match(/\+(\d+)$/);
    if (!m) return null;
    process.kill(Number(m[1]), 0);
    return Number(m[1]);
  } catch (e) {
    return e?.code === "EPERM" ? -1 : null;
  }
}

/**
 * A consistent copy of a SQLite database that may be open in a running Firefox:
 * the backup API when this Node has it (a snapshot including the WAL), else a copy of
 * the file and its WAL. The source is opened read-only and never written to.
 */
async function snapshot(file, scratch) {
  const copy = join(scratch, `${Math.random().toString(36).slice(2)}.sqlite`);
  if (typeof sqlite.backup === "function") {
    const src = new sqlite.DatabaseSync(file, { readOnly: true });
    try {
      await sqlite.backup(src, copy);
      return copy;
    } catch {
      // fall through to the file copy
    } finally {
      src.close();
    }
  }
  copyFileSync(file, copy);
  if (existsSync(file + "-wal")) copyFileSync(file + "-wal", copy + "-wal");
  return copy;
}

const MOZLZ4_MAGIC = Buffer.from("mozLz40\0", "latin1");
function decodeMozLz4(file) {
  if (!file.subarray(0, 8).equals(MOZLZ4_MAGIC)) throw new Error("not a mozlz4 file");
  const out = Buffer.allocUnsafe(file.readUInt32LE(8));
  let ip = 12, op = 0;
  while (ip < file.length) {
    const token = file[ip++];
    let lit = token >> 4;
    if (lit === 15) for (let b = 255; b === 255; ) lit += b = file[ip++];
    file.copy(out, op, ip, ip + lit);
    ip += lit;
    op += lit;
    if (ip >= file.length) break;
    const offset = file[ip] | (file[ip + 1] << 8);
    ip += 2;
    let len = (token & 15) + 4;
    if ((token & 15) === 15) for (let b = 255; b === 255; ) len += b = file[ip++];
    for (let from = op - offset, end = op + len; op < end; ) out[op++] = out[from++];
  }
  return out.subarray(0, op);
}

/** "^userContextId=3&partitionKey=..." -> { userContextId: "3", partitionKey: "..." } */
function parseAttrs(suffix) {
  const out = {};
  for (const pair of String(suffix || "").replace(/^\^/, "").split("&")) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    out[at < 0 ? pair : pair.slice(0, at)] = at < 0 ? "" : pair.slice(at + 1);
  }
  return out;
}
function formatAttrs(attrs) {
  const keys = Object.keys(attrs);
  return keys.length ? "^" + keys.map((k) => `${k}=${attrs[k]}`).join("&") : "";
}
/** The attributes of a container's entry moved to the default context, or null if it is not that container's. */
function toDefaultContext(suffix, containerId) {
  const attrs = parseAttrs(suffix);
  const id = Number(attrs.userContextId || 0);
  if (id !== containerId) return null;
  delete attrs.userContextId;
  return formatAttrs(attrs);
}

// Cookies bound to the browser's fingerprint: they would be rejected, or worse, flag the new device.
const FINGERPRINT_BOUND = /^(cf_clearance|__cf_bm|_cfuvid|__cflb|_px.*|pxcts|datadome|ak_bmsc|bm_sv|bm_sz|_abck|incap_ses_.*|visid_incap_.*|reese84|aws-waf-token)$/i;

function domainAllowed(host, domains) {
  if (!domains) return true;
  const h = String(host).replace(/^\./, "").toLowerCase();
  return domains.some((d) => h === d || h.endsWith("." + d));
}

// ---------------------------------------------------------------- containers

function containers(source) {
  const list = [{ id: 0, name: "none" }];
  try {
    const data = JSON.parse(readFileSync(join(source, "containers.json"), "utf8"));
    for (const c of data.identities || []) {
      if (!c.public) continue;
      // Built-in containers carry a localisation id instead of a name.
      const name = c.name || String(c.l10nId || c.l10nID || "").replace(/^user-context-|^userContext|\.label$/g, "") || `container-${c.userContextId}`;
      list.push({ id: c.userContextId, name });
    }
  } catch {}
  return list;
}

function resolveContainer(source, wanted) {
  if (wanted === "none" || wanted === "0") return 0;
  if (/^\d+$/.test(wanted)) return Number(wanted);
  const hit = containers(source).find((c) => c.name.toLowerCase() === wanted.toLowerCase());
  if (!hit) fail(`no container named "${wanted}". Known: ${containers(source).map((c) => `${c.name} (${c.id})`).join(", ")}`);
  return hit.id;
}

// ---------------------------------------------------------------- cookies

async function importCookies(opts, containerId, scratch, report) {
  const sourceDb = join(opts.source, "cookies.sqlite");
  const targetDb = join(opts.target, "cookies.sqlite");
  if (!existsSync(sourceDb)) return;
  if (!existsSync(targetDb)) {
    fail(`${targetDb} does not exist. Launch the target profile once first (tabs_create(profile=...)) and close its browser, so the cookie database has the schema of the browser that will read it.`);
  }
  const src = new sqlite.DatabaseSync(await snapshot(sourceDb, scratch), { readOnly: true });
  const dst = new sqlite.DatabaseSync(opts.dryRun ? await snapshot(targetDb, scratch) : targetDb);
  try {
    const columns = (db) => db.prepare("PRAGMA table_info(moz_cookies)").all().map((c) => c.name);
    // Copy by column name: the two browsers may be different Firefox versions.
    const shared = columns(src).filter((c) => c !== "id" && columns(dst).includes(c));
    const version = (db) => db.prepare("PRAGMA user_version").get().user_version;
    report.push(`cookie schema: source v${version(src)}, target v${version(dst)}; copying columns ${shared.join(", ")}`);
    // Expiry is in seconds in older schemas and milliseconds in newer ones: convert by magnitude.
    const unit = (db) => {
      const m = Number(db.prepare("SELECT max(expiry) AS m FROM moz_cookies").get()?.m || 0);
      return m > 1e11 ? "ms" : m > 0 ? "s" : null;
    };
    const srcUnit = unit(src) || "s";
    const dstUnit = unit(dst) || (version(dst) >= 16 ? "ms" : "s");
    const insert = dst.prepare(`INSERT OR REPLACE INTO moz_cookies (${shared.join(", ")}) VALUES (${shared.map(() => "?").join(", ")})`);
    let copied = 0, skippedBound = 0;
    const seen = new Set();
    dst.exec("BEGIN");
    for (const row of src.prepare("SELECT * FROM moz_cookies").all()) {
      const attrs = toDefaultContext(row.originAttributes, containerId);
      if (attrs === null || !domainAllowed(row.host, opts.domains)) continue;
      if (FINGERPRINT_BOUND.test(row.name)) {
        skippedBound++;
        continue;
      }
      row.originAttributes = attrs;
      if (srcUnit !== dstUnit) row.expiry = srcUnit === "ms" ? Math.floor(Number(row.expiry) / 1000) : Number(row.expiry) * 1000;
      insert.run(...shared.map((c) => row[c]));
      seen.add(`${row.host}|${row.name}|${row.path}|${attrs}`);
      copied++;
    }
    // Cookies without an expiry live only in the session store. They are written as
    // ordinary cookies with a limited lifetime: simpler than forging a session store.
    let session = 0;
    for (const c of sessionCookies(opts.source)) {
      const id = Number(c.originAttributes?.userContextId || 0);
      if (id !== containerId || !domainAllowed(c.host, opts.domains) || FINGERPRINT_BOUND.test(c.name || "")) continue;
      const attrs = c.originAttributes?.partitionKey ? `^partitionKey=${encodeURIComponent(c.originAttributes.partitionKey)}` : "";
      const key = `${c.host}|${c.name}|${c.path || "/"}|${attrs}`;
      if (seen.has(key)) continue;
      const now = Date.now();
      const expiry = Math.floor(now / 1000) + opts.sessionDays * 86400;
      const row = {
        originAttributes: attrs, name: c.name || "", value: c.value || "", host: c.host || "", path: c.path || "/",
        expiry: dstUnit === "ms" ? expiry * 1000 : expiry, lastAccessed: now * 1000, creationTime: now * 1000, updateTime: now * 1000,
        isSecure: c.secure ? 1 : 0, isHttpOnly: c.httponly ? 1 : 0, inBrowserElement: 0, sameSite: c.sameSite ?? 0,
        schemeMap: c.schemeMap ?? 0, isPartitionedAttributeSet: c.isPartitioned ? 1 : 0,
      };
      insert.run(...shared.map((col) => row[col] ?? 0));
      session++;
    }
    dst.exec(opts.dryRun ? "ROLLBACK" : "COMMIT");
    report.push(`cookies: ${copied} copied, ${session} session cookie(s) copied with a ${opts.sessionDays}-day lifetime, ${skippedBound} fingerprint-bound skipped`);
  } finally {
    src.close();
    dst.close();
  }
}

function sessionCookies(source) {
  // A running Firefox keeps the live session in recovery.jsonlz4; a closed one in sessionstore.jsonlz4.
  const files = [join(source, "sessionstore-backups", "recovery.jsonlz4"), join(source, "sessionstore.jsonlz4")]
    .filter((f) => existsSync(f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of files) {
    try {
      return JSON.parse(decodeMozLz4(readFileSync(file)).toString("utf8")).cookies || [];
    } catch {}
  }
  return [];
}

// ---------------------------------------------------------------- storage

/**
 * `.metadata-v2` of an origin directory (QuotaManager): int64 timestamp, bool persisted,
 * two reserved uint32, then three length-prefixed strings (legacy suffix, legacy group,
 * origin) and a trailing bool. Rewritten for the default context.
 */
function rewriteMetadata(buf, containerId) {
  let p = 17;
  const strings = [];
  for (let i = 0; i < 3; i++) {
    const n = buf.readUInt32BE(p);
    strings.push(buf.subarray(p + 4, p + 4 + n).toString("utf8"));
    p += 4 + n;
  }
  const tail = buf.subarray(p);
  const strip = (s) => {
    const at = s.indexOf("^");
    if (at < 0) return s;
    const attrs = toDefaultContext(s.slice(at), containerId);
    return s.slice(0, at) + (attrs ?? s.slice(at));
  };
  const parts = [buf.subarray(0, 17)];
  for (const s of strings.map(strip)) {
    const bytes = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    parts.push(len, bytes);
  }
  parts.push(tail);
  return Buffer.concat(parts);
}

function hostOfOriginDir(name) {
  const m = /^[a-z-]+\+\+\+([^+^]+)/.exec(name);
  return m ? m[1] : "";
}

function importStorage(opts, containerId, report) {
  const srcRoot = join(opts.source, "storage", "default");
  const dstRoot = join(opts.target, "storage", "default");
  let names = [];
  try {
    names = readdirSync(srcRoot);
  } catch {
    return;
  }
  let copied = 0, existing = 0, bytes = 0;
  for (const name of names) {
    const at = name.indexOf("^");
    const attrs = toDefaultContext(at < 0 ? "" : name.slice(at), containerId);
    if (attrs === null || !domainAllowed(hostOfOriginDir(name), opts.domains)) continue;
    const from = join(srcRoot, name);
    const subdirs = ["ls", ...(opts.idb ? ["idb", "cache"] : [])].filter((d) => existsSync(join(from, d)));
    if (!subdirs.length || !existsSync(join(from, ".metadata-v2"))) continue;
    const to = join(dstRoot, (at < 0 ? name : name.slice(0, at)) + attrs);
    if (existsSync(to)) {
      existing++; // the target already has data for this origin: left alone
      continue;
    }
    copied++;
    if (opts.dryRun) continue;
    mkdirSync(to, { recursive: true });
    for (const d of subdirs) cpSync(join(from, d), join(to, d), { recursive: true });
    writeFileSync(join(to, ".metadata-v2"), rewriteMetadata(readFileSync(join(from, ".metadata-v2")), containerId));
    // localStorage and IndexedDB databases record their own origin, attributes
    // included, and refuse to open under another one.
    const dbs = [join(to, "ls", "data.sqlite"), ...(existsSync(join(to, "idb")) ? readdirSync(join(to, "idb")).filter((f) => f.endsWith(".sqlite")).map((f) => join(to, "idb", f)) : [])];
    for (const file of dbs.filter((f) => existsSync(f))) {
      const db = new sqlite.DatabaseSync(file);
      try {
        // (IndexedDB's table is WITHOUT ROWID, so rows are addressed by the origin itself.)
        for (const row of db.prepare("SELECT DISTINCT origin FROM database").all()) {
          const cut = String(row.origin).indexOf("^");
          if (cut < 0) continue;
          const moved = toDefaultContext(row.origin.slice(cut), containerId);
          if (moved !== null) db.prepare("UPDATE database SET origin = ? WHERE origin = ?").run(row.origin.slice(0, cut) + moved, row.origin);
        }
      } catch {
        // not a schema we know: the browser will discard this store, nothing else is affected
      } finally {
        db.close();
      }
    }
    for (const d of subdirs) bytes += dirSize(join(to, d));
  }
  if (copied && !opts.dryRun) {
    // QuotaManager caches the origin list in storage.sqlite; without it, it rebuilds the list from the directories.
    rmSync(join(opts.target, "storage.sqlite"), { force: true });
    rmSync(join(opts.target, "storage.sqlite-wal"), { force: true });
    rmSync(join(opts.target, "storage.sqlite-shm"), { force: true });
  }
  report.push(`storage (${["localStorage", ...(opts.idb ? ["IndexedDB", "Cache API"] : [])].join(", ")}): ${copied} origin(s) copied${opts.dryRun ? "" : ` (${(bytes / 1048576).toFixed(1)} MB)`}, ${existing} already in the target and left alone`);
}

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) total += e.isDirectory() ? dirSize(join(dir, e.name)) : statSync(join(dir, e.name)).size;
  return total;
}

// ---------------------------------------------------------------- permissions

async function importPermissions(opts, containerId, scratch, report) {
  const sourceDb = join(opts.source, "permissions.sqlite");
  const targetDb = join(opts.target, "permissions.sqlite");
  if (!existsSync(sourceDb) || !existsSync(targetDb)) return;
  const src = new sqlite.DatabaseSync(await snapshot(sourceDb, scratch), { readOnly: true });
  const dst = new sqlite.DatabaseSync(opts.dryRun ? await snapshot(targetDb, scratch) : targetDb);
  try {
    const cols = (db) => db.prepare("PRAGMA table_info(moz_perms)").all().map((c) => c.name);
    const shared = cols(src).filter((c) => c !== "id" && cols(dst).includes(c));
    if (!shared.includes("origin")) return;
    const exists = dst.prepare("SELECT 1 FROM moz_perms WHERE origin = ? AND type = ?");
    const insert = dst.prepare(`INSERT INTO moz_perms (${shared.join(", ")}) VALUES (${shared.map(() => "?").join(", ")})`);
    let copied = 0;
    for (const row of src.prepare("SELECT * FROM moz_perms").all()) {
      const at = String(row.origin).indexOf("^");
      const attrs = toDefaultContext(at < 0 ? "" : row.origin.slice(at), containerId);
      if (attrs === null) continue;
      let host = "";
      try {
        host = new URL(at < 0 ? row.origin : row.origin.slice(0, at)).hostname;
      } catch {}
      if (!domainAllowed(host, opts.domains)) continue;
      row.origin = (at < 0 ? row.origin : row.origin.slice(0, at)) + attrs;
      if (exists.get(row.origin, row.type)) continue;
      if (!opts.dryRun) insert.run(...shared.map((c) => row[c]));
      copied++;
    }
    report.push(`site permissions: ${copied} copied`);
  } finally {
    src.close();
    dst.close();
  }
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
if (!existsSync(join(opts.source, "cookies.sqlite"))) fail(`${opts.source} does not look like a Firefox profile (no cookies.sqlite)`);
if (opts.list) {
  for (const c of containers(opts.source)) console.log(`${String(c.id).padStart(3)}  ${c.name}`);
  process.exit(0);
}
if (resolve(opts.source) === resolve(opts.target)) fail("source and target are the same directory");
if (!existsSync(opts.target)) fail(`target profile ${opts.target} does not exist`);
const holder = lockHolder(opts.target);
if (holder !== null) fail(`the target profile is in use${holder > 0 ? ` (pid ${holder})` : ""}: close its browser first (close its tabs, or its window). A profile may only be written while its browser is not running.`);

const containerId = resolveContainer(opts.source, opts.container);
const scratch = mkdtempSync(join(tmpdir(), "firefox-import-"));
const report = [];
try {
  await importCookies(opts, containerId, scratch, report);
  if (opts.storage) importStorage(opts, containerId, report);
  await importPermissions(opts, containerId, scratch, report);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`${opts.dryRun ? "[dry run] " : ""}container ${opts.container} (userContextId ${containerId}) of ${opts.source} -> ${opts.target}`);
for (const line of report) console.log("  " + line);
if (lockHolder(opts.source) !== null) console.log("  note: Firefox was running; data written in its last few seconds may be missing.");
