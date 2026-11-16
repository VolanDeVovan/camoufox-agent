// Where things live on disk: profiles, the daemon socket, downloads.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION: string = (() => {
  try {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return String(JSON.parse(readFileSync(pkg, "utf8")).version);
  } catch {
    return "0.0.0";
  }
})();

/** What makes one daemon different from another. Sessions with the same config share a daemon. */
export interface DaemonConfig {
  profilesDir: string;
  headless: boolean;
}

export function defaultProfilesDir(): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "camoufox-agent", "profiles");
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function runtimeDir(): string {
  const dir = process.env.XDG_RUNTIME_DIR || join(tmpdir(), `camoufox-agent-${userInfo().uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * The daemon socket. Versioned, so a new package never talks to an old daemon; a
 * non-default config (another profiles root, headless) gets its own daemon, since
 * those are properties of the browsers a daemon owns.
 */
export function socketPath(cfg: DaemonConfig): string {
  const isDefault = resolve(cfg.profilesDir) === resolve(defaultProfilesDir()) && !cfg.headless;
  const suffix = isDefault
    ? ""
    : "-" + createHash("sha256").update(`${resolve(cfg.profilesDir)}\0${cfg.headless}`).digest("hex").slice(0, 10);
  return join(runtimeDir(), `camoufox-agent-${VERSION}${suffix}.sock`);
}

/** `$XDG_DOWNLOAD_DIR/camoufox-agent`, falling back to `~/Downloads/camoufox-agent`. */
export function downloadsDir(): string {
  let base = process.env.XDG_DOWNLOAD_DIR || "";
  if (!base) {
    try {
      const cfgHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
      const m = readFileSync(join(cfgHome, "user-dirs.dirs"), "utf8").match(/^XDG_DOWNLOAD_DIR="?([^"\n]+)"?/m);
      if (m) base = m[1].replace(/^\$HOME/, homedir());
    } catch {}
  }
  if (!base) base = join(homedir(), "Downloads");
  return join(base, "camoufox-agent");
}

const PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;
export const TEMP_PROFILE = "temp";

/** Profile names become directory names, so they are restricted (02, 07). Throws with a message for the agent. */
export function validateProfileName(name: unknown): string {
  if (typeof name !== "string" || !PROFILE_NAME.test(name) || name.length > 64) {
    throw new Error(
      `Invalid profile name ${JSON.stringify(name)}: names match [a-z0-9][a-z0-9-]* (lowercase letters, digits, dashes; at most 64 chars).`,
    );
  }
  return name;
}

export function ensureDir(dir: string, mode = 0o700): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode });
  return dir;
}
