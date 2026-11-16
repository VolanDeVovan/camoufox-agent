// ProfileManager: profile name -> running browser (or none). Lazy launch, close,
// crash handling.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { TEMP_PROFILE, validateProfileName } from "../paths.js";
import { guardFocus } from "./focus.js";
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
  /**
   * window.open calls we gave up waiting for, per opener page (its main thread was
   * busy), as the times we gave up. Each still opens a blank tab once the page wakes
   * up; that tab is closed. A call the page has not run within a minute, or before it
   * navigated, is forgotten: a blank tab it opens then is taken for the site's.
   */
  abandoned: Map<Page, number[]>;
  /** The page the daemon last selected in this window (follow-the-agent). */
  visible: Page | null;
  /** The last agent action in this browser, to attribute tabs a site opens without an opener. */
  lastAction: { page: Page; at: number } | null;
  closing: boolean;
  /** What the owners of this browser's tabs are told once it is gone. */
  goneNotice: string | null;
}

/** Wait up to `ms` for a process to be gone. */
async function exited(pid: number | null, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!pid) return true;
    try {
      process.kill(pid, 0);
    } catch (e: any) {
      if (e?.code !== "EPERM") return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Entry {
  promise: Promise<RunningProfile>;
  running: RunningProfile | null;
  /** Set while the browser is being closed; resolves once it is gone. */
  closed?: Promise<void>;
}

export class ProfileManager {
  private entries = new Map<string, Entry>();

  constructor(private daemon: Daemon) {}

  get root(): string {
    return this.daemon.config.profilesDir;
  }

  /** Is any browser running or starting? */
  any(): boolean {
    return this.entries.size > 0;
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
    // A browser being closed is not handed out: the next one is launched once it is gone.
    if (entry?.closed) return entry.closed.then(() => this.ensure(name));
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
          // Nobody may be left to wait for it: the daemon may have nothing else to live for.
          queueMicrotask(() => this.daemon.checkIdle());
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
    // Watching starts now: the window appears, and may be focused, before the launch returns.
    const focusGuard = await guardFocus(this.daemon.config.headless);
    try {
      context = await launchProfile(dir, this.daemon.config.headless);
    } catch (err) {
      void focusGuard();
      if (temp) rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    this.daemon.log(`profile ${name} launched in ${Date.now() - started} ms`);
    void focusGuard().then((times) => {
      if (times) this.daemon.log(`the compositor focused the new window of ${name}; focus was handed back (${times}x)`);
    });
    let died = false;
    const early = () => (died = true);
    context.on("close", early);
    const pages = context.pages();
    // Session restore must not reopen tabs behind anyone's back: sessions own tabs.
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
      abandoned: new Map(),
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
    this.daemon.log(`profile ${profile.name} is gone (${profile.closing ? "closed" : "died"})`);
    // Closed by us: close() forgets it once the process has exited and let go of the
    // profile. Forgetting it now would let a launch race the exiting browser.
    if (profile.closing) return;
    this.entries.delete(profile.name);
    if (!profile.closing) {
      this.daemon.tabs.dropProfile(
        profile,
        `The browser of profile "${profile.name}" exited (it crashed, or the user closed it); its tabs are gone. The next use of the profile relaunches it.`,
        null,
      );
    }
    if (profile.temp) rmSync(profile.dir, { recursive: true, force: true });
    this.daemon.checkIdle();
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
    if (profile.closing) {
      await entry.closed;
      return true;
    }
    profile.closing = true;
    let done!: () => void;
    entry.closed = new Promise<void>((r) => (done = r));
    try {
      await this.shut(name, entry, profile, by);
    } finally {
      done();
    }
    return true;
  }

  private async shut(name: string, entry: Entry, profile: RunningProfile, by: string | null): Promise<void> {
    this.daemon.tabs.dropProfile(
      profile,
      `The browser of profile "${name}" was closed; your tabs in it are gone. The next use of the profile relaunches it.`,
      by,
    );
    const pid = browserPid(profile.dir);
    const closed = await Promise.race([profile.context.close().then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10000))]);
    // The connection closes before the process has exited and let go of the profile; a
    // launch right after would take our own exiting browser for a foreign one.
    if (!closed || !(await exited(pid, 5000))) {
      // It will not close: kill it, so that it is neither left running nor left holding the profile.
      this.daemon.log(`profile ${name} did not close in time; killing pid ${pid}`);
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        await exited(pid, 2000);
      }
    }
    if (this.entries.get(name) === entry) this.entries.delete(name);
    if (profile.temp) rmSync(profile.dir, { recursive: true, force: true });
    this.daemon.checkIdle();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((name) => this.close(name, null)));
  }
}
