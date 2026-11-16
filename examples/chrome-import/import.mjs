#!/usr/bin/env node
// Example, not part of the package: copy one Chromium-family browser profile (Chrome,
// Chromium, Brave, Edge, Vivaldi, Opera) into a camoufox-agent profile. No CLI contract,
// no support promise: copy it, adapt it, run it from your own scripts. See README.md
// next to this file.
//
//   node import.mjs --chrome-profile ~/.config/google-chrome/Default \
//                   --target ~/.local/share/camoufox-agent/profiles/work [--storage] [--dry-run]
//
// Nothing is ever written to the Chrome profile, and no cookie value is printed.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as sqlite from "node:sqlite";

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { dryRun: false, storage: false, domains: null, sessionDays: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (argv[i + 1] === undefined) fail(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--chrome-profile") out.source = expand(value());
    else if (a === "--target") out.target = expand(value());
    else if (a === "--keyring-app") out.keyringApp = value();
    else if (a === "--domains") out.domains = value().split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    else if (a === "--session-days") out.sessionDays = Number(value());
    else if (a === "--storage") out.storage = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--list") out.list = true;
    else fail(`unknown argument ${a}`);
  }
  if (!out.source) fail("--chrome-profile DIR is required (a profile directory such as ~/.config/google-chrome/Default)");
  if (!out.list && !out.target) fail("--target DIR (a camoufox-agent profile directory) is required");
  return out;
}

function expand(p) {
  return resolve(p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
}

function fail(message) {
  console.error(`chrome-import: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- helpers

/** Is a Firefox-family browser running on this profile? (the `lock` symlink names its pid) */
function firefoxLockHolder(dir) {
  try {
    const m = readlinkSync(join(dir, "lock")).match(/\+(\d+)$/);
    if (!m) return null;
    process.kill(Number(m[1]), 0);
    return Number(m[1]);
  } catch (e) {
    return e?.code === "EPERM" ? -1 : null;
  }
}

/** Is a Chromium browser running on this user data directory? (`SingletonLock` -> "host-pid") */
function chromeRunning(userDataDir) {
  try {
    const m = readlinkSync(join(userDataDir, "SingletonLock")).match(/-(\d+)$/);
    if (!m) return false;
    process.kill(Number(m[1]), 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/**
 * A copy of a SQLite database that may be open in a running browser: the backup API
 * when this Node has it, else a copy of the file (and its WAL). The source is opened
 * read-only and never written to.
 */
async function snapshot(file, scratch) {
  const copy = join(scratch, `${Math.random().toString(36).slice(2)}.sqlite`);
  if (typeof sqlite.backup === "function") {
    try {
      const src = new sqlite.DatabaseSync(file, { readOnly: true });
      try {
        await sqlite.backup(src, copy);
        return copy;
      } finally {
        src.close();
      }
    } catch {
      // a running Chrome may hold the database locked: fall through to the file copy
    }
  }
  copyFileSync(file, copy);
  if (existsSync(file + "-wal")) copyFileSync(file + "-wal", copy + "-wal");
  return copy;
}

// Cookies bound to the browser's fingerprint: they would be rejected, or worse, flag the new device.
const FINGERPRINT_BOUND = /^(cf_clearance|__cf_bm|_cfuvid|__cflb|_px.*|pxcts|datadome|ak_bmsc|bm_sv|bm_sz|_abck|incap_ses_.*|visid_incap_.*|reese84|aws-waf-token)$/i;

function domainAllowed(host, domains) {
  if (!domains) return true;
  const h = String(host).replace(/^\./, "").toLowerCase();
  return domains.some((d) => h === d || h.endsWith("." + d));
}

// ---------------------------------------------------------------- profiles

/** The profiles of a user data directory, from its `Local State`. */
function profiles(userDataDir) {
  try {
    const cache = JSON.parse(readFileSync(join(userDataDir, "Local State"), "utf8")).profile?.info_cache || {};
    return Object.entries(cache).map(([dir, info]) => ({ dir, name: info.name || dir, user: info.user_name || "" }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- the key
//
// Chromium encrypts cookie values with AES-128-CBC (IV of 16 spaces) under a key
// derived by PBKDF2-SHA1 with the salt "saltysalt" from a password:
//   Linux  "v11": a random password in the Secret Service (GNOME Keyring, KWallet 6,
//                 KeePassXC) or KWallet 5; "v10": the fixed password "peanuts"
//                 (--password-store=basic, or no keyring). 1 iteration.
//   macOS  "v10": a random password in the login Keychain. 1003 iterations.
//   Windows: DPAPI, and since Chrome 127 app-bound encryption ("v20") that only
//            Chrome itself can undo. Not supported here.

/** The keyring application name of each browser, recognised from the user data directory. */
const BROWSERS = [
  { match: /google-chrome|Google\/Chrome/i, app: "chrome", mac: ["Chrome Safe Storage", "Chrome"], kwallet: ["Chrome Keys", "Chrome Safe Storage"] },
  { match: /chromium/i, app: "chromium", mac: ["Chromium Safe Storage", "Chromium"], kwallet: ["Chromium Keys", "Chromium Safe Storage"] },
  { match: /BraveSoftware/i, app: "brave", mac: ["Brave Safe Storage", "Brave"], kwallet: ["Brave Keys", "Brave Safe Storage"] },
  { match: /microsoft-edge|Microsoft Edge/i, app: "microsoft-edge", mac: ["Microsoft Edge Safe Storage", "Microsoft Edge"], kwallet: ["Microsoft Edge Keys", "Microsoft Edge Safe Storage"] },
  { match: /vivaldi/i, app: "vivaldi", mac: ["Vivaldi Safe Storage", "Vivaldi"], kwallet: ["Vivaldi Keys", "Vivaldi Safe Storage"] },
  { match: /opera/i, app: "opera", mac: ["Opera Safe Storage", "Opera"], kwallet: ["Opera Keys", "Opera Safe Storage"] },
];

async function cookieKeys(opts, userDataDir, needed) {
  const browser = BROWSERS.find((b) => b.match.test(userDataDir));
  const app = opts.keyringApp || browser?.app;
  const keys = {};
  if (process.platform === "linux") {
    keys.v10 = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
    if (needed.has("v11")) {
      const password = process.env.CHROME_SAFE_STORAGE_PASSWORD ?? (await secretServicePassword(app)) ?? kwalletPassword(browser);
      if (password == null) {
        fail(`no "${app}" password found in the Secret Service or KWallet, and the cookies need it (v11). ` +
          `Pass --keyring-app NAME (the "application" attribute of the "... Safe Storage" item, e.g. as shown by Seahorse), ` +
          `or the password itself in CHROME_SAFE_STORAGE_PASSWORD.`);
      }
      // Older builds fell back to an empty password when the keyring had none.
      keys.v11 = [pbkdf2Sync(password, "saltysalt", 1, 16, "sha1"), pbkdf2Sync("", "saltysalt", 1, 16, "sha1")];
    }
  } else if (process.platform === "darwin") {
    let password = process.env.CHROME_SAFE_STORAGE_PASSWORD;
    if (password == null && browser) {
      try {
        password = execFileSync("security", ["find-generic-password", "-w", "-s", browser.mac[0], "-a", browser.mac[1]], { encoding: "utf8" }).trim();
      } catch {}
    }
    if (password == null) fail("no Safe Storage password in the Keychain; pass it in CHROME_SAFE_STORAGE_PASSWORD");
    keys.v10 = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  } else {
    fail("only Linux and macOS are supported: on Windows, Chrome's app-bound encryption can only be undone by Chrome itself");
  }
  return keys;
}

function kwalletPassword(browser) {
  if (!browser) return null;
  for (const wallet of ["kdewallet"]) {
    try {
      const out = execFileSync("kwallet-query", ["-r", browser.kwallet[1], "-f", browser.kwallet[0], wallet], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (out && !/^Failed/i.test(out)) return out;
    } catch {}
  }
  return null;
}

/**
 * The password stored under `application=<app>` in the Secret Service, or null.
 * A session of the Secret Service only lives as long as the D-Bus connection that
 * opened it, so `gdbus call` cannot be chained: this talks D-Bus itself.
 */
async function secretServicePassword(app) {
  if (!app) return null;
  let bus;
  try {
    bus = await DBus.session();
  } catch {
    return null; // no session bus (a headless box): no Secret Service either
  }
  const SS = "org.freedesktop.secrets", SP = "/org/freedesktop/secrets", SERVICE = "org.freedesktop.Secret.Service";
  try {
    const [, session] = await bus.call(SS, SP, SERVICE, "OpenSession", "sv", ["plain", ["s", ""]]);
    let [unlocked, locked] = await bus.call(SS, SP, SERVICE, "SearchItems", "a{ss}", [{ application: app }]);
    if (!unlocked.length && locked.length) {
      // The keyring is locked: ask the Secret Service to prompt the user for its password.
      const [done, prompt] = await bus.call(SS, SP, SERVICE, "Unlock", "ao", [locked]);
      unlocked = done;
      if (prompt !== "/") {
        console.error("chrome-import: the keyring is locked; unlock it in the dialog that just opened");
        const completed = bus.signal(prompt, "org.freedesktop.Secret.Prompt", "Completed");
        await bus.call(SS, prompt, "org.freedesktop.Secret.Prompt", "Prompt", "s", [""]);
        const [dismissed, result] = await completed;
        if (dismissed) fail("the keyring was not unlocked");
        unlocked = result;
      }
    }
    if (!unlocked.length) return null;
    const [[, , secret]] = await bus.call(SS, unlocked[0], "org.freedesktop.Secret.Item", "GetSecret", "o", [session]);
    return secret.toString("utf8");
  } catch (e) {
    if (/ServiceUnknown|NameHasNoOwner/.test(String(e?.message))) return null; // no Secret Service on this bus
    throw e;
  } finally {
    bus.close();
  }
}

/** The value of an `encrypted_value`, or null if no key opens it. */
function decrypt(blob, hostKey, keys, metaVersion) {
  const buf = Buffer.from(blob);
  const prefix = buf.subarray(0, 3).toString("latin1");
  const candidates = [keys[prefix]].flat().filter(Boolean);
  for (const key of candidates) {
    try {
      const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
      let plain = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
      // Since database version 24 the value is preceded by SHA-256(host_key): a check that the key was right.
      if (metaVersion >= 24) {
        if (!plain.subarray(0, 32).equals(createHash("sha256").update(hostKey).digest())) continue;
        plain = plain.subarray(32);
      }
      return plain.toString("utf8");
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- cookies

// Chromium time: microseconds since 1601-01-01 UTC.
const WINDOWS_EPOCH_US = 11644473600000000n;
const chromeToUnixUs = (t) => Number(BigInt(t) - WINDOWS_EPOCH_US);

// SameSite: Chromium -1 unspecified, 0 None, 1 Lax, 2 Strict; Firefox 256 unset, 0 None, 1 Lax, 2 Strict.
const SAME_SITE = { "-1": 256, 0: 0, 1: 1, 2: 2 };

/** "https://example.com" (Chromium's top_frame_site_key) -> Firefox's "^partitionKey=(https,example.com)", or null. */
function partitionAttrs(topFrameSite) {
  if (!topFrameSite) return "";
  const m = /^(https?):\/\/([^/:]+)$/.exec(topFrameSite);
  return m ? `^partitionKey=${encodeURIComponent(`(${m[1]},${m[2]})`)}` : null;
}

async function importCookies(opts, userDataDir, scratch, report) {
  const sourceDb = [join(opts.source, "Network", "Cookies"), join(opts.source, "Cookies")].find(existsSync);
  const targetDb = join(opts.target, "cookies.sqlite");
  if (!sourceDb) fail(`${opts.source} has no cookie database (Cookies or Network/Cookies)`);
  if (!existsSync(targetDb)) {
    fail(`${targetDb} does not exist. Launch the target profile once first (tabs_create(profile=...)) and close its browser, so the cookie database has the schema of the browser that will read it.`);
  }
  const src = new sqlite.DatabaseSync(await snapshot(sourceDb, scratch), { readOnly: true });
  const dst = new sqlite.DatabaseSync(opts.dryRun ? await snapshot(targetDb, scratch) : targetDb);
  try {
    const metaVersion = Number(src.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value || 0);
    // Chromium times (microseconds since 1601) do not fit a double: read integers as BigInt.
    const select = src.prepare("SELECT * FROM cookies");
    select.setReadBigInts(true);
    const rows = select.all();
    const prefixes = new Set(rows.filter((r) => r.encrypted_value?.length).map((r) => Buffer.from(r.encrypted_value).subarray(0, 3).toString("latin1")));
    const keys = await cookieKeys(opts, userDataDir, prefixes);

    const dstColumns = dst.prepare("PRAGMA table_info(moz_cookies)").all().map((c) => c.name);
    const version = dst.prepare("PRAGMA user_version").get().user_version;
    const maxExpiry = Number(dst.prepare("SELECT max(expiry) AS m FROM moz_cookies").get()?.m || 0);
    const expiryInMs = maxExpiry > 1e11 || (maxExpiry === 0 && version >= 16);
    report.push(`cookie schema: source v${metaVersion} (${[...prefixes].join(", ") || "unencrypted"}), target v${version}`);

    const nowUs = Date.now() * 1000;
    const columns = ["originAttributes", "name", "value", "host", "path", "expiry", "lastAccessed", "creationTime", "isSecure", "isHttpOnly",
      "inBrowserElement", "sameSite", "schemeMap", "isPartitionedAttributeSet", "updateTime"].filter((c) => dstColumns.includes(c));
    const insert = dst.prepare(`INSERT OR REPLACE INTO moz_cookies (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    let copied = 0, session = 0, skippedBound = 0, expired = 0, undecryptable = 0, otherPartition = 0;
    dst.exec("BEGIN");
    for (const r of rows) {
      if (!domainAllowed(r.host_key, opts.domains)) continue;
      if (FINGERPRINT_BOUND.test(r.name)) {
        skippedBound++;
        continue;
      }
      const attrs = partitionAttrs(r.top_frame_site_key);
      if (attrs === null) {
        otherPartition++; // partitioned under a chrome:// or chrome-extension:// page: nothing to map it to
        continue;
      }
      const value = r.encrypted_value?.length ? decrypt(r.encrypted_value, r.host_key, keys, metaVersion) : r.value;
      if (value == null) {
        undecryptable++;
        continue;
      }
      // A cookie without an expiry (only kept by a Chrome that restores sessions) gets a limited lifetime.
      const persistent = Number(r.has_expires) && Number(r.is_persistent);
      const expiresUs = persistent ? chromeToUnixUs(r.expires_utc) : nowUs + opts.sessionDays * 86400e6;
      if (expiresUs <= nowUs) {
        expired++;
        continue;
      }
      if (!persistent) session++;
      const secure = Number(r.is_secure) ? 1 : 0;
      const row = {
        originAttributes: attrs, name: r.name, value, host: r.host_key, path: r.path || "/",
        expiry: expiryInMs ? Math.floor(expiresUs / 1000) : Math.floor(expiresUs / 1e6),
        lastAccessed: Number(r.last_access_utc) ? chromeToUnixUs(r.last_access_utc) : nowUs,
        creationTime: Number(r.creation_utc) ? chromeToUnixUs(r.creation_utc) : nowUs,
        updateTime: Number(r.last_update_utc) ? chromeToUnixUs(r.last_update_utc) : nowUs,
        isSecure: secure, isHttpOnly: Number(r.is_httponly) ? 1 : 0, inBrowserElement: 0,
        sameSite: SAME_SITE[String(r.samesite)] ?? 256,
        // source_scheme: 0 unset, 1 http, 2 https; schemeMap: a bit set, 1 http, 2 https.
        schemeMap: Number(r.source_scheme) === 1 ? 1 : Number(r.source_scheme) === 2 ? 2 : secure ? 2 : 1,
        isPartitionedAttributeSet: attrs ? 1 : 0,
      };
      insert.run(...columns.map((c) => row[c]));
      copied++;
    }
    dst.exec(opts.dryRun ? "ROLLBACK" : "COMMIT");
    report.push(`cookies: ${copied} copied (${session} without an expiry, given a ${opts.sessionDays}-day lifetime), ` +
      `${skippedBound} fingerprint-bound skipped, ${expired} expired skipped` +
      (otherPartition ? `, ${otherPartition} partitioned under browser pages skipped` : "") +
      (undecryptable ? `, ${undecryptable} could not be decrypted (wrong key?)` : ""));
    if (undecryptable && !copied) fail("no cookie could be decrypted: the key is wrong. Nothing was written.");
  } finally {
    src.close();
    dst.close();
  }
}

// ---------------------------------------------------------------- localStorage
//
// Chromium keeps localStorage in one LevelDB (`Local Storage/leveldb`), keyed
//   "_" + storage key + "\0" + encoded key
// where the storage key is an origin ("https://example.com"), or, for a third-party
// frame, "https://embed.com/^0https://top.com". Keys and values start with a byte
// that names their encoding: 0 UTF-16LE, 1 Latin-1.
//
// Firefox keeps one directory per origin, storage/default/https+++example.com/, with
// a QuotaManager `.metadata-v2` and the data in ls/data.sqlite (+ ls/usage).

function varint(buf, pos) {
  let v = 0, shift = 0, b;
  do {
    b = buf[pos++];
    v += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return [v, pos];
}

function snappyDecompress(src) {
  let [length, p] = varint(src, 0);
  const out = Buffer.allocUnsafe(length);
  let op = 0;
  while (p < src.length) {
    const tag = src[p++];
    if ((tag & 3) === 0) { // literal
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = 0;
        for (let i = 0; i < bytes; i++) n += src[p++] * 2 ** (8 * i);
      }
      n += 1;
      src.copy(out, op, p, p + n);
      p += n;
      op += n;
      continue;
    }
    let n, offset;
    if ((tag & 3) === 1) {
      n = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | src[p++];
    } else if ((tag & 3) === 2) {
      n = (tag >> 2) + 1;
      offset = src.readUInt16LE(p);
      p += 2;
    } else {
      n = (tag >> 2) + 1;
      offset = src.readUInt32LE(p);
      p += 4;
    }
    for (let i = 0; i < n; i++, op++) out[op] = out[op - offset]; // copies may overlap
  }
  return out.subarray(0, op);
}

/** The [key, value] pairs of an SSTable block (prefix-compressed keys, restart array at the end). */
function blockEntries(buf) {
  const restarts = buf.readUInt32LE(buf.length - 4);
  const end = buf.length - 4 - 4 * restarts;
  const out = [];
  let p = 0, last = Buffer.alloc(0);
  while (p < end) {
    let shared, unshared, valueLength;
    [shared, p] = varint(buf, p);
    [unshared, p] = varint(buf, p);
    [valueLength, p] = varint(buf, p);
    const key = Buffer.concat([last.subarray(0, shared), buf.subarray(p, p + unshared)]);
    p += unshared;
    out.push([key, buf.subarray(p, p + valueLength)]);
    p += valueLength;
    last = key;
  }
  return out;
}

function tableBlock(file, offset, size) {
  const raw = file.subarray(offset, offset + size);
  const compression = file[offset + size];
  if (compression === 0) return raw;
  if (compression === 1) return snappyDecompress(raw);
  throw new Error(`unknown LevelDB block compression ${compression}`);
}

/** Entries of an .ldb / .sst table: [user key, sequence, type (1 put, 0 delete), value]. */
function* tableEntries(file) {
  const footer = file.subarray(file.length - 48);
  let p = 0, offset, size;
  [, p] = varint(footer, p); // metaindex handle: not needed
  [, p] = varint(footer, p);
  [offset, p] = varint(footer, p);
  [size, p] = varint(footer, p);
  for (const [, handle] of blockEntries(tableBlock(file, offset, size))) {
    const [blockOffset, q] = varint(handle, 0);
    const [blockSize] = varint(handle, q);
    for (const [internalKey, value] of blockEntries(tableBlock(file, blockOffset, blockSize))) {
      const tag = internalKey.readBigUInt64LE(internalKey.length - 8);
      yield [internalKey.subarray(0, internalKey.length - 8), tag >> 8n, Number(tag & 0xffn), value];
    }
  }
}

/** Entries of a .log file: 32 KiB blocks of records (checksum, length, type) carrying write batches. */
function* logEntries(file) {
  const batches = [];
  let fragments = null;
  for (let block = 0; block < file.length; block += 32768) {
    const end = Math.min(block + 32768, file.length);
    for (let p = block; p + 7 <= end; ) {
      const length = file.readUInt16LE(p + 4);
      const type = file[p + 6];
      if (type === 0) break; // the zero padding of a block, or a preallocated tail
      const data = file.subarray(p + 7, p + 7 + length);
      p += 7 + length;
      if (type === 1) batches.push(data); // FULL
      else if (type === 2) fragments = [data]; // FIRST
      else if (type === 3) fragments?.push(data); // MIDDLE
      else if (type === 4 && fragments) { // LAST
        fragments.push(data);
        batches.push(Buffer.concat(fragments));
        fragments = null;
      }
    }
  }
  for (const batch of batches) {
    let sequence = batch.readBigUInt64LE(0);
    const count = batch.readUInt32LE(8);
    let p = 12;
    for (let i = 0; i < count && p < batch.length; i++) {
      const type = batch[p++];
      let length;
      [length, p] = varint(batch, p);
      const key = batch.subarray(p, p + length);
      p += length;
      let value = null;
      if (type === 1) {
        [length, p] = varint(batch, p);
        value = batch.subarray(p, p + length);
        p += length;
      }
      yield [key, sequence++, type, value];
    }
  }
}

/** The live contents of a LevelDB directory: the newest entry of each key, deletions applied. */
function readLevelDb(dir) {
  const newest = new Map();
  for (const name of readdirSync(dir)) {
    const entries = /\.(ldb|sst)$/.test(name) ? tableEntries : name.endsWith(".log") ? logEntries : null;
    if (!entries) continue;
    let file;
    try {
      file = readFileSync(join(dir, name));
    } catch {
      continue; // compacted away while we were reading
    }
    for (const [key, sequence, type, value] of entries(file)) {
      const k = key.toString("latin1");
      const seen = newest.get(k);
      if (!seen || seen.sequence < sequence) newest.set(k, { sequence, type, value: value && Buffer.from(value) });
    }
  }
  const out = new Map();
  for (const [k, e] of newest) if (e.type === 1) out.set(k, e.value);
  return out;
}

/** A Chromium-encoded string: a leading 0 means UTF-16LE, 1 Latin-1. */
function chromeString(buf) {
  return buf[0] === 0 ? buf.subarray(1).toString("utf16le") : buf.subarray(1).toString("latin1");
}

/** QuotaManager's group of an origin: its registrable domain (tldts when it can be loaded). */
async function groupOf(host) {
  try {
    const { getDomain } = await import("tldts");
    const domain = getDomain(host, { allowPrivateDomains: false });
    if (domain) return domain;
  } catch {}
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return host;
  return host.split(".").slice(-2).join(".");
}

/**
 * `.metadata-v2` for an origin of the default context: int64 timestamp (µs), bool
 * persisted, two uint32 written as Camoufox 158 writes them, then the suffix, group
 * and origin strings (uint32 length + UTF-8), and a trailing bool (isApp).
 */
function originMetadata(group, origin) {
  const string = (s) => {
    const bytes = Buffer.from(s, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return [length, bytes];
  };
  const head = Buffer.alloc(17);
  head.writeBigInt64BE(BigInt(Date.now()) * 1000n, 0);
  head.writeUInt32BE(1, 9);
  return Buffer.concat([head, ...string(""), ...string(group), ...string(origin), Buffer.alloc(1)]);
}

/** Writes one origin's localStorage the way Firefox's LSNG keeps it. */
function writeFirefoxLocalStorage(dir, origin, items) {
  const ls = join(dir, "ls");
  mkdirSync(ls, { recursive: true });
  const db = new sqlite.DatabaseSync(join(ls, "data.sqlite"));
  let usage = 0;
  try {
    db.exec(`PRAGMA page_size = 4096; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA user_version = 80;
      CREATE TABLE database( origin TEXT NOT NULL, usage INTEGER NOT NULL DEFAULT 0, last_vacuum_time INTEGER NOT NULL DEFAULT 0, last_analyze_time INTEGER NOT NULL DEFAULT 0, last_vacuum_size INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE data( key TEXT PRIMARY KEY, utf16_length INTEGER NOT NULL, conversion_type INTEGER NOT NULL, compression_type INTEGER NOT NULL, last_access_time INTEGER NOT NULL DEFAULT 0, value BLOB NOT NULL);`);
    // conversion_type 1: the value is stored as UTF-8; compression_type 0: uncompressed.
    const insert = db.prepare("INSERT OR REPLACE INTO data (key, utf16_length, conversion_type, compression_type, value) VALUES (?, ?, 1, 0, ?)");
    db.exec("BEGIN");
    for (const [key, value] of items) {
      insert.run(key, value.length, Buffer.from(value, "utf8"));
      usage += key.length + value.length; // LSNG counts usage in UTF-16 code units
    }
    db.prepare("INSERT INTO database (origin, usage) VALUES (?, ?)").run(origin, usage);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  // ls/usage: a magic number and the same usage, so QuotaManager need not open the database.
  const usageFile = Buffer.alloc(12);
  usageFile.writeUInt32BE(0x420a420a, 0);
  usageFile.writeBigUInt64BE(BigInt(usage), 4);
  writeFileSync(join(ls, "usage"), usageFile);
}

async function importLocalStorage(opts, report) {
  const source = join(opts.source, "Local Storage", "leveldb");
  if (!existsSync(source)) return;
  const byOrigin = new Map();
  let thirdParty = 0, otherScheme = 0;
  for (const [key, value] of readLevelDb(source)) {
    if (!key.startsWith("_")) continue; // META:, METAACCESS:, VERSION
    const cut = key.indexOf("\0");
    const storageKey = key.slice(1, cut);
    let url;
    try {
      url = new URL(storageKey.split("^")[0]);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      otherScheme++; // chrome-extension://, devtools://, ...
      continue;
    }
    if (!domainAllowed(url.hostname, opts.domains)) continue;
    if (storageKey.includes("^")) {
      thirdParty++; // partitioned storage of an embedded frame
      continue;
    }
    const name = chromeString(Buffer.from(key.slice(cut + 1), "latin1"));
    if (!byOrigin.has(url.origin)) byOrigin.set(url.origin, []);
    byOrigin.get(url.origin).push([name, chromeString(value)]);
  }

  const root = join(opts.target, "storage", "default");
  let copied = 0, existing = 0, items = 0;
  for (const [origin, entries] of byOrigin) {
    // https://example.com:8443 -> https+++example.com+8443
    const dir = join(root, origin.replace(/[:/]/g, "+"));
    if (existsSync(dir)) {
      existing++; // the target already has data for this origin: left alone
      continue;
    }
    copied++;
    items += entries.length;
    if (opts.dryRun) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".metadata-v2"), originMetadata(await groupOf(new URL(origin).hostname), origin));
    writeFirefoxLocalStorage(dir, origin, entries);
  }
  if (copied && !opts.dryRun) {
    // QuotaManager caches the origin list in storage.sqlite; without it, it rebuilds the list from the directories.
    for (const f of ["storage.sqlite", "storage.sqlite-wal", "storage.sqlite-shm"]) rmSync(join(opts.target, f), { force: true });
  }
  report.push(`localStorage: ${copied} origin(s) copied (${items} items), ${existing} already in the target and left alone` +
    (thirdParty ? `, ${thirdParty} item(s) of embedded third-party frames skipped` : "") +
    (otherScheme ? `, ${otherScheme} of extensions and browser pages skipped` : ""));
}

// ---------------------------------------------------------------- a minimal D-Bus client
//
// Just enough of the wire protocol (little endian, EXTERNAL auth, method calls and
// signals) to read one secret from the Secret Service without libsecret.

function parseSig(sig, i = 0) {
  const c = sig[i];
  if (c === "a") {
    const [inner, next] = parseSig(sig, i + 1);
    return [{ t: "a", inner }, next];
  }
  if (c === "(" || c === "{") {
    const close = c === "(" ? ")" : "}";
    const fields = [];
    let j = i + 1;
    while (sig[j] !== close) {
      const [f, next] = parseSig(sig, j);
      fields.push(f);
      j = next;
    }
    return [{ t: c, fields }, j + 1];
  }
  return [{ t: c }, i + 1];
}

function sigTypes(sig) {
  const out = [];
  for (let i = 0; i < sig.length; ) {
    const [t, next] = parseSig(sig, i);
    out.push(t);
    i = next;
  }
  return out;
}

const ALIGN = { y: 1, b: 4, u: 4, i: 4, s: 4, o: 4, g: 1, v: 1, a: 4, "(": 8, "{": 8 };

class Writer {
  chunks = [];
  len = 0;
  bytes(b) {
    this.chunks.push(b);
    this.len += b.length;
  }
  pad(n) {
    const p = (n - (this.len % n)) % n;
    if (p) this.bytes(Buffer.alloc(p));
  }
  u32(v) {
    this.pad(4);
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    this.bytes(b);
  }
  write(type, v) {
    switch (type.t) {
      case "y": return this.bytes(Buffer.from([v]));
      case "b": return this.u32(v ? 1 : 0);
      case "u": return this.u32(v);
      case "s":
      case "o": {
        const b = Buffer.from(v, "utf8");
        this.u32(b.length);
        return this.bytes(Buffer.concat([b, Buffer.alloc(1)]));
      }
      case "g": {
        const b = Buffer.from(v, "utf8");
        return this.bytes(Buffer.concat([Buffer.from([b.length]), b, Buffer.alloc(1)]));
      }
      case "v": // [signature, value]
        this.write({ t: "g" }, v[0]);
        return this.write(parseSig(v[0])[0], v[1]);
      case "a": {
        this.u32(0);
        const lengthChunk = this.chunks[this.chunks.length - 1];
        this.pad(ALIGN[type.inner.t]);
        const start = this.len;
        for (const item of type.inner.t === "{" ? Object.entries(v) : v) this.write(type.inner, item);
        lengthChunk.writeUInt32LE(this.len - start);
        return;
      }
      case "(":
      case "{":
        this.pad(8);
        return type.fields.forEach((f, k) => this.write(f, v[k]));
      default:
        throw new Error(`D-Bus type ${type.t} is not supported`);
    }
  }
  buffer() {
    return Buffer.concat(this.chunks);
  }
}

class Reader {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }
  pad(n) {
    this.pos += (n - (this.pos % n)) % n;
  }
  u32() {
    this.pad(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  read(type) {
    switch (type.t) {
      case "y": return this.buf[this.pos++];
      case "b": return this.u32() !== 0;
      case "u": return this.u32();
      case "i": return this.u32() | 0;
      case "s":
      case "o": {
        const n = this.u32();
        const s = this.buf.toString("utf8", this.pos, this.pos + n);
        this.pos += n + 1;
        return s;
      }
      case "g": {
        const n = this.buf[this.pos++];
        const s = this.buf.toString("utf8", this.pos, this.pos + n);
        this.pos += n + 1;
        return s;
      }
      case "v": return this.read(parseSig(this.read({ t: "g" }))[0]);
      case "a": {
        const n = this.u32();
        this.pad(ALIGN[type.inner.t]);
        const end = this.pos + n;
        if (type.inner.t === "y") {
          const b = Buffer.from(this.buf.subarray(this.pos, end));
          this.pos = end;
          return b;
        }
        const out = type.inner.t === "{" ? {} : [];
        while (this.pos < end) {
          const item = this.read(type.inner);
          if (type.inner.t === "{") out[item[0]] = item[1];
          else out.push(item);
        }
        return out;
      }
      case "(":
      case "{":
        this.pad(8);
        return type.fields.map((f) => this.read(f));
      default:
        throw new Error(`D-Bus type ${type.t} is not supported`);
    }
  }
}

class DBus {
  static async session() {
    const address = process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${process.getuid()}/bus`;
    const m = /unix:(path|abstract)=([^,;]+)/.exec(address);
    if (!m) throw new Error(`unsupported D-Bus address ${address}`);
    const path = (m[1] === "abstract" ? "\0" : "") + decodeURIComponent(m[2]);
    const bus = new DBus(createConnection(path));
    await bus.auth();
    await bus.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello");
    return bus;
  }

  constructor(sock) {
    this.sock = sock;
    this.serial = 0;
    this.pending = new Map();
    this.listeners = [];
    this.buf = Buffer.alloc(0);
    sock.on("error", (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
  }

  auth() {
    return new Promise((resolve, reject) => {
      const onData = (d) => {
        this.sock.off("data", onData);
        const line = d.toString("latin1");
        if (!line.startsWith("OK")) return reject(new Error(`D-Bus authentication failed: ${line.trim()}`));
        this.sock.write("BEGIN\r\n");
        this.sock.on("data", (chunk) => this.onData(chunk));
        resolve();
      };
      this.sock.on("data", onData);
      this.sock.once("error", reject);
      this.sock.write("\0AUTH EXTERNAL " + Buffer.from(String(process.getuid())).toString("hex") + "\r\n");
    });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 16) {
      const bodyLength = this.buf.readUInt32LE(4);
      const fieldsLength = this.buf.readUInt32LE(12);
      const headerLength = 16 + fieldsLength + ((8 - ((16 + fieldsLength) % 8)) % 8);
      if (this.buf.length < headerLength + bodyLength) return;
      const msg = this.buf.subarray(0, headerLength + bodyLength);
      this.buf = this.buf.subarray(headerLength + bodyLength);
      const fields = Object.fromEntries(new Reader(msg, 12).read(parseSig("a(yv)")[0]));
      const bodyReader = new Reader(msg.subarray(headerLength));
      const body = fields[8] ? sigTypes(fields[8]).map((t) => bodyReader.read(t)) : [];
      const type = msg[1];
      if (type === 2 || type === 3) {
        const p = this.pending.get(fields[5]);
        if (!p) continue;
        this.pending.delete(fields[5]);
        if (type === 3) p.reject(new Error(`${fields[4]}: ${body[0] ?? ""}`));
        else p.resolve(body);
      } else if (type === 4) {
        for (const l of this.listeners) l(fields[1], fields[2], fields[3], body);
      }
    }
  }

  call(destination, path, iface, member, sig = "", args = []) {
    const serial = ++this.serial;
    const body = new Writer();
    sigTypes(sig).forEach((t, k) => body.write(t, args[k]));
    const bodyBuf = body.buffer();
    const fields = [[1, ["o", path]], [2, ["s", iface]], [3, ["s", member]], [6, ["s", destination]]];
    if (sig) fields.push([8, ["g", sig]]);
    const header = new Writer();
    header.bytes(Buffer.from([0x6c /* 'l' */, 1 /* method call */, 0, 1]));
    header.u32(bodyBuf.length);
    header.u32(serial);
    header.write(parseSig("a(yv)")[0], fields);
    header.pad(8);
    return new Promise((resolve, reject) => {
      this.pending.set(serial, { resolve, reject });
      this.sock.write(Buffer.concat([header.buffer(), bodyBuf]));
    });
  }

  /** Resolves with the body of the next signal `member` emitted by `path`. */
  async signal(path, iface, member) {
    const rule = `type='signal',interface='${iface}',member='${member}',path='${path}'`;
    await this.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "AddMatch", "s", [rule]);
    return new Promise((resolve) => {
      this.listeners.push((p, i, m, body) => {
        if (p === path && i === iface && m === member) resolve(body);
      });
    });
  }

  close() {
    this.sock.end();
  }
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
// --chrome-profile may name the user data directory itself (for --list), or a profile in it.
const isUserDataDir = existsSync(join(opts.source, "Local State"));
const userDataDir = isUserDataDir ? opts.source : dirname(opts.source);
if (opts.list) {
  const list = profiles(userDataDir);
  if (!list.length) fail(`${userDataDir} has no Local State listing profiles`);
  for (const p of list) console.log(`${p.dir.padEnd(12)}  ${p.name}${p.user ? `  <${p.user}>` : ""}`);
  console.log(`\nimport one with --chrome-profile ${join(userDataDir, list[0].dir)}`);
  process.exit(0);
}
if (isUserDataDir) fail(`${opts.source} is a user data directory, not a profile: pass one of its profiles (--list shows them), e.g. ${join(opts.source, "Default")}`);
if (resolve(opts.source) === resolve(opts.target)) fail("source and target are the same directory");
if (!existsSync(opts.target)) fail(`target profile ${opts.target} does not exist`);
const holder = firefoxLockHolder(opts.target);
if (holder !== null) fail(`the target profile is in use${holder > 0 ? ` (pid ${holder})` : ""}: close its browser first (close its tabs, or its window). A profile may only be written while its browser is not running.`);

const scratch = mkdtempSync(join(tmpdir(), "chrome-import-"));
const report = [];
try {
  await importCookies(opts, userDataDir, scratch, report);
  if (opts.storage) await importLocalStorage(opts, report);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const name = profiles(userDataDir).find((p) => p.dir === basename(opts.source))?.name;
console.log(`${opts.dryRun ? "[dry run] " : ""}${opts.source}${name ? ` ("${name}")` : ""} -> ${opts.target}`);
for (const line of report) console.log("  " + line);
if (chromeRunning(userDataDir)) console.log("  note: the browser was running; data it wrote in the last seconds may be missing.");
