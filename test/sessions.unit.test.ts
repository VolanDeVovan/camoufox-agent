// find_session on disk: wrong answers send the agent to the wrong profile.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { authLooking, cookiesForUrl, findSession, registrable, scanStopped } from "../src/daemon/sessions.js";
import { cleanupTemps, tempDir } from "./helpers.js";

afterAll(cleanupTemps);

const now = Math.floor(Date.now() / 1000);
const DAY = 86400;

type Row = [host: string, name: string, expiry: number, originAttributes?: string];

function createDb(file: string, rows: Row[], wal = false): DatabaseSync {
  const db = new DatabaseSync(file);
  if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  db.exec(
    "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0, sameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0)",
  );
  insert(db, rows);
  return db;
}
function insert(db: DatabaseSync, rows: Row[]): void {
  const stmt = db.prepare("INSERT INTO moz_cookies (host, name, value, path, expiry, originAttributes, isSecure, isHttpOnly) VALUES (?, ?, 'v4lue', '/', ?, ?, 1, 1)");
  for (const [host, name, expiry, attrs] of rows) stmt.run(host, name, expiry, attrs || "");
}

/** A stub of what findSession needs from the daemon: profiles on disk, none running. */
function daemonOf(root: string, names: string[]): any {
  return { profiles: { list: () => names.map((name) => ({ name, running: false })), running: () => null, dirOf: (n: string) => join(root, n) } };
}

function profile(root: string, name: string, rows: Row[]): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  createDb(join(dir, "cookies.sqlite"), rows).close();
  return dir;
}

test("eTLD+1 matching, partitioned / container / anti-bot cookies excluded, values never shown", async () => {
  const root = tempDir();
  const golove = profile(root, "golove", [
    ["dash.cloudflare.com", "CF_Authorization", now + 23 * DAY],
    ["dash.cloudflare.com", "vses2", now + 2 * DAY],
    [".cloudflare.com", "_ga", now + 300 * DAY],
    ["cloudflareinsights.com", "sessionid", now + DAY],
    ["github.co.uk", "user_session", now + DAY],
  ]);
  mkdirSync(join(golove, "storage", "default", "https+++dash.cloudflare.com", "ls"), { recursive: true });
  writeFileSync(join(golove, "storage", "default", "https+++dash.cloudflare.com", "ls", "data.sqlite"), "x");
  mkdirSync(join(golove, "storage", "default", "https+++dash.cloudflare.com^userContextId=3", "idb"), { recursive: true });
  writeFileSync(join(golove, "storage", "default", "https+++dash.cloudflare.com^userContextId=3", "idb", "x.sqlite"), "x");
  profile(root, "default", [
    ["cloudflare.com", "locale", now + DAY],
    // A Cloudflare challenge passed on some other site: must not make this profile "have" Cloudflare.
    [".cloudflare.com", "cf_clearance", now + DAY, "^partitionKey=%28https%2Cexample.com%29"],
    ["challenges.cloudflare.com", "__cf_bm", now + DAY],
  ]);
  profile(root, "work", [
    ["dash.cloudflare.com", "CF_Authorization", now + DAY, "^userContextId=3"],
    ["example.org", "sid", now + DAY],
  ]);
  const out = await findSession(daemonOf(root, ["default", "golove", "work"]), "cloudflare");
  expect(out).toMatch(/^cloudflare:\n {2}golove\n {4}dash\.cloudflare\.com\s+2 cookies, auth-looking: CF_Authorization, vses2; latest expiry in 23 d/);
  expect(out).toContain("localStorage yes, IndexedDB no");
  expect(out).toMatch(/ {2}default\n {4}cloudflare\.com\s+1 cookie, none auth-looking/);
  expect(out).not.toContain("challenges.cloudflare.com");
  expect(out).not.toContain("cloudflareinsights");
  expect(out).toContain("nothing in: work");
  expect(out).not.toContain("v4lue");
  // A full domain matches its registrable domain, also for multi-label suffixes.
  expect(await findSession(daemonOf(root, ["golove"]), "https://www.cloudflare.com/login")).toContain("dash.cloudflare.com");
  expect(await findSession(daemonOf(root, ["golove"]), "github.co.uk")).toContain("user_session");
  expect(await findSession(daemonOf(root, ["golove"]), "co.uk")).not.toContain("user_session");
  expect(registrable("a.b.github.co.uk")).toBe("github.co.uk");
});

test("expired cookies are ignored, and a site whose cookies all expired says so", async () => {
  const root = tempDir();
  profile(root, "default", [
    ["old.example.com", "sessionid", now - 3 * DAY],
    ["live.example.net", "sessionid", now - 3 * DAY],
    ["live.example.net", "auth_token", now + 5 * DAY],
  ]);
  expect(await findSession(daemonOf(root, ["default"]), "example.com")).toMatch(/session expired 3 d ago/);
  const live = await findSession(daemonOf(root, ["default"]), "example.net");
  expect(live).toMatch(/1 cookie, auth-looking: auth_token; latest expiry in 5 d/);
});

test("a leftover -wal after a crash is read, and the profile is not written to", async () => {
  const root = tempDir();
  const dir = join(root, "crashed");
  mkdirSync(dir);
  const scratch = tempDir();
  const db = createDb(join(scratch, "cookies.sqlite"), [["old.example.com", "pref", now + DAY]], true);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  insert(db, [["app.example.com", "session_token", now + DAY]]); // lives only in the WAL
  copyFileSync(join(scratch, "cookies.sqlite"), join(dir, "cookies.sqlite"));
  copyFileSync(join(scratch, "cookies.sqlite-wal"), join(dir, "cookies.sqlite-wal"));
  db.close();
  const scan = scanStopped(dir);
  expect(scan.cookies.map((c) => c.name).sort()).toEqual(["pref", "session_token"]);
  const { readdirSync } = await import("node:fs");
  expect(readdirSync(dir).sort()).toEqual(["cookies.sqlite", "cookies.sqlite-wal"]);
});

test("auth-looking is a hint from names; anti-bot and analytics never count", () => {
  for (const yes of ["sessionid", "CF_Authorization", "__Secure-next-auth.session-token", "user_session", "jwt", "sid", "SSID", "logged_in", "remember_me"]) expect(authLooking(yes), yes).toBe(true);
  for (const no of ["cf_clearance", "__cf_bm", "_cfuvid", "_pxvid", "datadome", "_ga", "_gid", "_hjSessionUser_123", "locale", "theme", "__Host-pref"]) expect(authLooking(no), no).toBe(false);
});

test("cookies for a URL follow domain, path and secure rules", () => {
  const scan = {
    storage: new Map(),
    cookies: [
      { host: ".example.com", name: "wide", value: "1", path: "/", expires: now + DAY, secure: false, httpOnly: false },
      { host: "app.example.com", name: "hostonly", value: "1", path: "/", expires: -1, secure: false, httpOnly: true },
      { host: "example.com", name: "secure", value: "1", path: "/", expires: now + DAY, secure: true, httpOnly: false },
      { host: "example.com", name: "admin", value: "1", path: "/admin", expires: now + DAY, secure: false, httpOnly: false },
      { host: "example.com", name: "stale", value: "1", path: "/", expires: now - 1, secure: false, httpOnly: false },
      { host: "evil-example.com", name: "other", value: "1", path: "/", expires: now + DAY, secure: false, httpOnly: false },
    ],
  };
  const names = (url: string) => cookiesForUrl(scan, url).map((c) => c.name).sort();
  expect(names("http://example.com/")).toEqual(["wide"]);
  expect(names("https://example.com/admin/users")).toEqual(["admin", "secure", "wide"]);
  expect(names("https://app.example.com/")).toEqual(["hostonly", "wide"]);
  expect(names("https://notexample.com/")).toEqual([]);
});
