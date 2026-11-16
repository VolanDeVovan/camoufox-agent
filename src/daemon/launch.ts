// Launch configuration: the same for every launch, fixed per profile (03-lifecycle.md).
import { existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { refEngineReady } from "./snapshot.js";

export const IDENTITY_FILE = "mcp-identity.json";

const HOST_OS: Record<string, string> = { linux: "linux", darwin: "macos", win32: "windows" };

/** Firefox prefs every profile runs with. */
export const PREFS: Record<string, unknown> = {
  // camoufox.cfg used to ship 0, which disables back / forward (06, Camoufox quirks).
  "browser.sessionhistory.max_entries": 50,
  // Session restore keeps cookies without an expiry across restarts (03, Session cookies).
  "browser.startup.page": 3,
  "browser.sessionstore.resume_from_crash": true,
  "browser.sessionstore.max_resumed_crashes": -1,
  "browser.sessionstore.privacy_level": 0,
  "browser.sessionstore.restore_on_demand": true,
  "browser.sessionstore.restore_tabs_lazily": true,
  "browser.sessionstore.interval": 5000,
  // The window is normally unfocused, often hidden: keep frames and timers running (04, R9).
  "widget.wayland.vsync.enabled": false,
  "dom.min_background_timeout_value": 4,
  "dom.timeout.enable_budget_timer_throttling": false,
  "layout.throttled_frame_rate": 60,
  // Popups a site opens become tabs in the profile's window, not new toplevels that could take focus (04).
  "browser.link.open_newwindow": 3,
  "browser.link.open_newwindow.restriction": 0,
  "browser.tabs.warnOnClose": false,
  "browser.warnOnQuit": false,
  "browser.aboutwelcome.enabled": false,
};

interface Identity {
  v: 1;
  created: string;
  os: string;
  fingerprint: Record<string, any>;
}

function readIdentity(profileDir: string, os: string): Identity | null {
  try {
    const id = JSON.parse(readFileSync(join(profileDir, IDENTITY_FILE), "utf8"));
    if (id?.v !== 1 || id.os !== os || typeof id.fingerprint?.navigator?.userAgent !== "string") return null;
    return id;
  } catch {
    return null;
  }
}

/**
 * The device a profile shows to sites: drawn once, on the profile's first launch, and
 * stored in the profile, so a profile is the same device every time (02-profiles.md).
 * What is stored is the launcher's own input (an fpgen fingerprint); the launcher
 * derives fonts, voices, GPU parameters and noise seeds from it deterministically.
 */
async function profileFingerprint(profileDir: string, os: string, headless: boolean): Promise<Record<string, any>> {
  const stored = readIdentity(profileDir, os);
  if (stored) return stored.fingerprint;
  const { utilsDeps, getScreenCons } = await import("camoufox/dist/utils.js" as string);
  const drawn = await utilsDeps.generateFingerprint({ screen: getScreenCons(headless) ?? undefined, os });
  const id: Identity = { v: 1, created: new Date().toISOString(), os, fingerprint: drawn };
  const json = JSON.stringify(id);
  writeFileSync(join(profileDir, IDENTITY_FILE), json, { mode: 0o600 });
  // Launch with the stored form even the first time, so both launches see the same bytes.
  return JSON.parse(json).fingerprint;
}

export async function launchProfile(profileDir: string, headless: boolean): Promise<BrowserContext> {
  // The ref selector engine has to exist before the context is created (06).
  await refEngineReady();
  const { firefox } = await import("playwright-core");
  const { launchOptions, NewBrowser } = await import("camoufox");
  const os = HOST_OS[process.platform] || "linux";
  const fingerprint = await profileFingerprint(profileDir, os, headless);
  const options = await launchOptions({
    headless,
    // The host's OS: a foreign one forces canvas noise and is slower and heavier (03).
    os,
    fingerprint,
    humanize: 0.5,
    main_world_eval: true,
    firefox_user_prefs: { ...PREFS },
    i_know_what_im_doing: true,
    // Playwright options, passed through by the launcher.
    acceptDownloads: true,
    // Playwright adds -foreground to a headed Firefox, which raises the window (04, Focus rules).
    ignoreDefaultArgs: ["-foreground"],
    // The daemon closes its browsers itself on every exit path.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  return (await NewBrowser(firefox, {
    // The launcher reads the profile directory from the options it is handed.
    from_options: { ...options, user_data_dir: profileDir },
    persistent_context: true,
  })) as BrowserContext;
}

/** The pid of a foreign process holding this Firefox profile, or null. */
export function foreignLockHolder(profileDir: string, ownPids: Set<number>): number | null {
  try {
    const target: string = readlinkSync(join(profileDir, "lock"));
    const m = target.match(/\+(\d+)$/);
    if (!m) return null;
    const pid = Number(m[1]);
    if (ownPids.has(pid)) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch (e: any) {
      return e?.code === "EPERM" ? pid : null;
    }
  } catch {
    return null;
  }
}

export function profileHasIdentity(profileDir: string): boolean {
  return existsSync(join(profileDir, IDENTITY_FILE));
}
