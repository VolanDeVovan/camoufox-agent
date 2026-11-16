// Launch configuration: the same for every launch, fixed per profile (03-lifecycle.md).
import { existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { holds, largestDisplay, screenFor, setScreen, type Size } from "./display.js";
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

function writeIdentity(profileDir: string, os: string, fingerprint: Record<string, any>, created?: string): Record<string, any> {
  const id: Identity = { v: 1, created: created || new Date().toISOString(), os, fingerprint };
  const json = JSON.stringify(id);
  writeFileSync(join(profileDir, IDENTITY_FILE), json, { mode: 0o600 });
  // What is launched is always the stored form, so every launch sees the same bytes.
  return JSON.parse(json).fingerprint;
}

/**
 * The device a profile shows to sites: drawn once, on the profile's first launch, and
 * stored in the profile, so a profile is the same device every time (02-profiles.md).
 * What is stored is the launcher's own input (an fpgen fingerprint); the launcher
 * derives fonts, voices, GPU parameters and noise seeds from it deterministically.
 *
 * `mustHold` is the largest display (or a window found larger than the stored
 * screen): the screen is kept at least that large (04, Viewport), which changes the
 * stored device only when a larger display appears.
 */
async function profileFingerprint(profileDir: string, os: string, mustHold: Size | null): Promise<Record<string, any>> {
  const stored = readIdentity(profileDir, os);
  if (stored) {
    if (!mustHold || holds(stored.fingerprint.screen, mustHold)) return stored.fingerprint;
    setScreen(stored.fingerprint, screenFor(mustHold));
    return writeIdentity(profileDir, os, stored.fingerprint, stored.created);
  }
  const { utilsDeps } = await import("camoufox/dist/utils.js" as string);
  const { Screen } = await import("camoufox");
  let drawn: Record<string, any>;
  if (!mustHold) drawn = await utilsDeps.generateFingerprint({ os });
  else {
    // A device whose screen is exactly this display, if the generator knows one; else
    // any device, given this display's size. (The generator ignores a bound it cannot meet.)
    const exact = new Screen({ minWidth: mustHold.width, maxWidth: mustHold.width, minHeight: mustHold.height, maxHeight: mustHold.height });
    drawn = await utilsDeps.generateFingerprint({ os, screen: exact });
    if (!holds(drawn.screen, mustHold) || drawn.screen.width !== mustHold.width || drawn.screen.height !== mustHold.height) setScreen(drawn, mustHold);
  }
  return writeIdentity(profileDir, os, drawn);
}

async function launchOnce(profileDir: string, headless: boolean, os: string, mustHold: Size | null): Promise<BrowserContext> {
  const { firefox } = await import("playwright-core");
  const { launchOptions, NewBrowser } = await import("camoufox");
  const fingerprint = await profileFingerprint(profileDir, os, mustHold);
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

export async function launchProfile(profileDir: string, headless: boolean): Promise<BrowserContext> {
  // The ref selector engine has to exist before the context is created (06).
  await refEngineReady();
  const os = HOST_OS[process.platform] || "linux";
  const display = headless ? null : await largestDisplay();
  let context = await launchOnce(profileDir, headless, os, display);
  if (headless) return context;
  // The safety net for a display that could not be probed: a window larger than the
  // screen the profile claims. Fix the claim and launch again, once.
  try {
    const page = context.pages()[0];
    const raw = page
      ? ((await Promise.race([
          page.evaluate("JSON.stringify({ width: window.outerWidth, height: window.outerHeight, sw: screen.width, sh: screen.height })"),
          new Promise((r) => setTimeout(() => r(null), 3000)),
        ])) as string | null)
      : null;
    const seen = raw ? JSON.parse(raw) : null;
    if (seen && (seen.width > seen.sw || seen.height > seen.sh)) {
      await context.close().catch(() => {});
      context = await launchOnce(profileDir, headless, os, { width: Math.max(seen.width, seen.sw), height: Math.max(seen.height, seen.sh) });
    }
  } catch {}
  return context;
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
