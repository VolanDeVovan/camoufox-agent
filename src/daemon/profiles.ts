// ProfileManager: profile name -> running browser (or none). Lazy launch, close,
// crash handling (03-lifecycle.md).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { TEMP_PROFILE, validateProfileName } from "../paths.js";
import { requireBrowser } from "./install.js";
import { browserPid, foreignLockHolder, launchProfile } from "./launch.js";
import type { Daemon } from "./state.js";
import { ToolError } from "./state.js";

export interface RunningProfile {
  name: string;
  dir: string;
  temp: boolean;
  context: BrowserContext;
  /** The blank page a fresh browser starts with, until a session takes it. */
  initialPage: Page | null;
  /** Serializes tab opening: one expected page at a time. */
  opening: Promise<unknown>;
  /** Set while we wait for a tab we asked the browser to open. */
  expecting: ((page: Page) => void) | null;
  /** The page that tab is being opened from. */
  expectingFrom: Page | null;
  /** The page the daemon last selected in this window (follow-the-agent). */
  visible: Page | null;
  /** The last agent action in this browser, to attribute tabs a site opens without an opener. */
  lastAction: { page: Page; at: number } | null;
  closing: boolean;
  /** What the owners of this browser's tabs are told once it is gone. */
  goneNotice: string | null;
}

interface Entry {
  promise: Promise<RunningProfile>;
  running: RunningProfile | null;
}

export class ProfileManager {
  private entries = new Map<string, Entry>();

  constructor(private daemon: Daemon) {}

  get root(): string {
    return this.daemon.config.profilesDir;
  }

  /** Profiles on disk plus running ones (a running `temp` has no directory under the root). */
  list(): { name: string; running: boolean }[] {
    const names = new Set<string>();
    try {
      for (const d of readdirSync(this.root)) {
        if (/^[a-z0-9][a-z0-9-]*$/.test(d) && d !== TEMP_PROFILE && statSync(join(this.root, d)).isDirectory()) names.add(d);
      }
    } catch {}
    for (const [name, e] of this.entries) if (e.running) names.add(name);
    return [...names].sort().map((name) => ({ name, running: !!this.entries.get(name)?.running }));
  }

  dirOf(name: string): string {
    return join(this.root, name);
  }

  running(name: string): RunningProfile | null {
    return this.entries.get(name)?.running ?? null;
  }

  allRunning(): RunningProfile[] {
    return [...this.entries.values()].map((e) => e.running).filter((p): p is RunningProfile => !!p);
  }

  /**
   * The running browser of a profile, launched if needed. The launch slot is claimed
   * synchronously, before any await: tool calls arrive concurrently, and two launches
   * would otherwise build two contexts on one profile.
   */
  ensure(rawName: string): Promise<{ profile: RunningProfile; created: string | null }> {
    const name = validateProfileName(rawName);
    let entry = this.entries.get(name);
    let created: string | null = null;
    if (!entry) {
      const isNew = name !== TEMP_PROFILE && !existsSync(this.dirOf(name));
      if (isNew) {
        const existing = this.list().map((p) => p.name);
        created = `Created new profile "${name}". Existing: ${existing.length ? existing.join(", ") : "(none)"}.`;
      }
      const fresh: Entry = { promise: null as any, running: null };
      fresh.promise = this.launch(name).then(
        (profile) => {
          fresh.running = profile;
          return profile;
        },
        (err) => {
          if (this.entries.get(name) === fresh) this.entries.delete(name);
          throw err;
        },
      );
      this.entries.set(name, fresh);
      entry = fresh;
    }
    return entry.promise.then((profile) => ({ profile, created }));
  }

  private async launch(name: string): Promise<RunningProfile> {
    await Promise.resolve(); // keep everything below off the synchronous claim path
    await requireBrowser();
    const temp = name === TEMP_PROFILE;
    let dir: string;
    if (temp) {
      dir = mkdtempSync(join(tmpdir(), "camoufox-agent-temp-"));
    } else {
      dir = this.dirOf(name);
      const holder = existsSync(dir) ? foreignLockHolder(dir, new Set([process.pid])) : null;
      if (holder !== null) {
        throw new ToolError(
          `Profile "${name}" is in use by another process (pid ${holder}) that is not this daemon: a Firefox profile can be open in one browser at a time. Close that browser, or use another profile.`,
        );
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.daemon.log(`launching profile ${name} (${dir})`);
    const started = Date.now();
    let context: BrowserContext;
    try {
      context = await launchProfile(dir, this.daemon.config.headless);
    } catch (err) {
      if (temp) rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    this.daemon.log(`profile ${name} launched in ${Date.now() - started} ms`);
    let died = false;
    const early = () => (died = true);
    context.on("close", early);
    const pages = context.pages();
    // Session restore must not reopen tabs behind anyone's back: sessions own tabs (03).
    for (const extra of pages.slice(1)) await extra.close().catch(() => {});
    if (died) {
      if (temp) rmSync(dir, { recursive: true, force: true });
      throw new ToolError(`The browser of profile "${name}" exited right after it started. Try again.`);
    }
    context.off("close", early);
    const profile: RunningProfile = {
      name,
      dir,
      temp,
      context,
      initialPage: pages[0] ?? null,
      opening: Promise.resolve(),
      expecting: null,
      expectingFrom: null,
      visible: pages[0] ?? null,
      lastAction: null,
      closing: false,
      goneNotice: null,
    };
    context.on("close", () => this.onGone(profile));
    this.daemon.tabs.attach(profile);
    return profile;
  }

  /** The browser went away: we closed it, the user quit it, or it crashed. */
  private onGone(profile: RunningProfile): void {
    const entry = this.entries.get(profile.name);
    if (entry?.running !== profile) return;
    this.entries.delete(profile.name);
    this.daemon.log(`profile ${profile.name} is gone (${profile.closing ? "closed" : "died"})`);
    if (!profile.closing) {
      this.daemon.tabs.dropProfile(
        profile,
        `The browser of profile "${profile.name}" exited (it crashed, or the user closed it); its tabs are gone. The next use of the profile relaunches it.`,
        null,
      );
    }
    if (profile.temp) rmSync(profile.dir, { recursive: true, force: true });
  }

  /** Close one browser for everyone. `by` is the session that asked, if any. */
  async close(name: string, by: string | null): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry) return false;
    let profile: RunningProfile;
    try {
      profile = await entry.promise;
    } catch {
      return false;
    }
    if (profile.closing) return true;
    profile.closing = true;
    this.daemon.tabs.dropProfile(
      profile,
      by === null
        ? `The browser of profile "${name}" was closed; your tabs in it are gone.`
        : `The browser of profile "${name}" was closed by another session (close_browser); your tabs in it are gone. The next use of the profile relaunches it.`,
      by,
    );
    const closed = await Promise.race([profile.context.close().then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10000))]);
    if (!closed) {
      // It will not close: kill it, so that it is neither left running nor left holding the profile.
      const pid = browserPid(profile.dir);
      this.daemon.log(`profile ${name} did not close within 10 s; killing pid ${pid}`);
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    if (this.entries.get(name) === entry) this.entries.delete(name);
    if (profile.temp) rmSync(profile.dir, { recursive: true, force: true });
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((name) => this.close(name, null)));
  }
}
