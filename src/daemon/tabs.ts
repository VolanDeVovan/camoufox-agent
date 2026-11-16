// TabRegistry: tab ids, which session owns each tab, each session's active tab (04-tabs-and-window.md).
import type { Frame, Page } from "playwright-core";
import { attachCapture, type ConsoleEntry, type DialogAnswer, type NetEntry } from "./capture.js";
import type { RunningProfile } from "./profiles.js";
import type { Daemon, Session } from "./state.js";
import { ToolError } from "./state.js";

export interface TabEvent {
  seq: number;
  at: number;
  kind: "dialog" | "download" | "popup";
  text: string;
  /** Resolves when the event's text is final (a download finished). */
  done?: Promise<void>;
}

type NetListener = (entry: NetEntry, phase: "request" | "response" | "finished") => void;

export class Tab {
  owner: string | null;
  /** A blank tab nobody has used yet (a fresh browser's first page, or a parked one). */
  pristine = false;
  console: ConsoleEntry[] = [];
  requests: NetEntry[] = [];
  requestSeq = 0;
  inflight = 0;
  navSeq = 0;
  events: TabEvent[] = [];
  eventSeq = 0;
  dialogOnce: DialogAnswer | null = null;
  dialogRule: DialogAnswer | null = null;
  /** Frames that got a ref prefix in a read_page ("f1" -> frame). */
  frames = new Map<string, Frame>();
  framePrefixes = new WeakMap<Frame, string>();
  frameSeq = 0;
  /** Refs are never reused within a tab, so a stale ref cannot name another element. */
  refSeq = 1;
  blocking: { types: Set<string>; patterns: string[]; handler: any } | null = null;
  /** Screenshot pixels per CSS pixel in the last screenshot handed to the agent (coordinates are mapped back). */
  shotScale = 1;
  closedByAgent = false;
  private netListeners = new Set<NetListener>();
  /** Calls on one tab run one at a time. */
  queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly id: number,
    readonly page: Page,
    readonly profile: RunningProfile,
    owner: string | null,
  ) {
    this.owner = owner;
  }

  pushEvent(kind: TabEvent["kind"], text: string): TabEvent {
    const event: TabEvent = { seq: ++this.eventSeq, at: Date.now(), kind, text };
    this.events.push(event);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    return event;
  }

  onNet(listener: NetListener): () => void {
    this.netListeners.add(listener);
    return () => this.netListeners.delete(listener);
  }

  emitNet(entry: NetEntry, phase: "request" | "response" | "finished"): void {
    for (const l of this.netListeners) {
      try {
        l(entry, phase);
      } catch {}
    }
  }

  async title(): Promise<string> {
    try {
      return await Promise.race([this.page.title(), new Promise<string>((r) => setTimeout(() => r(""), 1500))]);
    } catch {
      return "";
    }
  }

  url(): string {
    try {
      return this.page.url();
    } catch {
      return "";
    }
  }
}

const OPEN_TAB_JS = `(function () { window.open("about:blank", "_blank", "noopener,noreferrer"); return 1; })()`;

export class TabRegistry {
  private nextId = 1;
  private tabs = new Map<number, Tab>();
  private byPage = new WeakMap<Page, Tab>();

  constructor(private daemon: Daemon) {}

  /** Start tracking a freshly launched browser. */
  attach(profile: RunningProfile): void {
    if (profile.initialPage) this.register(profile.initialPage, profile, null).pristine = true;
    profile.context.on("page", (page) => void this.onPage(profile, page));
  }

  private register(page: Page, profile: RunningProfile, owner: string | null): Tab {
    const existing = this.byPage.get(page);
    if (existing) return existing;
    const tab = new Tab(this.nextId++, page, profile, owner);
    this.tabs.set(tab.id, tab);
    this.byPage.set(page, tab);
    attachCapture(tab);
    page.on("close", () => this.onClosed(tab));
    return tab;
  }

  /** A page appeared in a browser: ours, a site's popup, or one the user opened by hand. */
  private async onPage(profile: RunningProfile, page: Page): Promise<void> {
    if (profile.expecting) {
      const resolve = profile.expecting;
      profile.expecting = null;
      resolve(page);
      return;
    }
    let parent: Tab | undefined;
    try {
      const opener = await page.opener();
      if (opener) parent = this.byPage.get(opener);
    } catch {}
    // A link with rel=noopener has no opener; a tab appearing right after an agent action is that action's.
    if (!parent && profile.lastAction && Date.now() - profile.lastAction.at < 3000) parent = this.byPage.get(profile.lastAction.page);
    if (this.byPage.has(page) || page.isClosed()) return;
    const tab = this.register(page, profile, parent?.owner ?? null);
    profile.visible = page; // Firefox selects a tab a page opens
    if (parent) parent.pushEvent("popup", `opened tab ${tab.id}`);
  }

  private onClosed(tab: Tab): void {
    if (!this.tabs.delete(tab.id)) return;
    const profile = tab.profile;
    if (profile.visible === tab.page) profile.visible = null;
    const session = tab.owner ? this.daemon.sessions.get(tab.owner) : undefined;
    if (!session || tab.closedByAgent) return;
    const what = `Tab ${tab.id} (${profile.name}, ${tab.url() || "about:blank"}) was closed by the user or by the page.`;
    const wasActive = session.activeTab === tab.id;
    if (wasActive) {
      session.activeTab = null;
      session.lostActive = what;
    } else session.notices.push(what);
    // When a browser dies its pages close first. A moment later we know which it was,
    // and the notice names the browser instead of the tab.
    setTimeout(() => {
      if (this.daemon.profiles.running(profile.name) === profile) return;
      const gone = profile.goneNotice;
      const fix = (text: string | null) => (text === what ? gone : text);
      if (session.lostActive === what) session.lostActive = gone;
      session.notices = [...new Set(session.notices.map((n) => fix(n)).filter((n): n is string => !!n))];
    }, 250);
  }

  /** The browser of a profile is gone: forget its tabs and tell their owners (except `by`). */
  dropProfile(profile: RunningProfile, notice: string, by: string | null): void {
    profile.goneNotice = notice;
    const told = new Set<string>();
    for (const tab of [...this.tabs.values()]) {
      if (tab.profile !== profile) continue;
      this.tabs.delete(tab.id);
      const session = tab.owner ? this.daemon.sessions.get(tab.owner) : undefined;
      if (!session) continue;
      const wasActive = session.activeTab === tab.id;
      if (wasActive) session.activeTab = null;
      if (session.id === by) continue;
      if (wasActive) session.lostActive = notice;
      else if (!told.has(session.id) && !session.notices.includes(notice)) session.notices.push(notice);
      told.add(session.id);
    }
  }

  get(id: number): Tab | undefined {
    return this.tabs.get(id);
  }

  of(session: Session): Tab[] {
    return [...this.tabs.values()].filter((t) => t.owner === session.id);
  }

  /** Tabs the user opened by hand: they belong to no session until one adopts them. */
  unowned(): Tab[] {
    return [...this.tabs.values()].filter((t) => t.owner === null && !t.pristine);
  }

  inProfile(profile: RunningProfile): Tab[] {
    return [...this.tabs.values()].filter((t) => t.profile === profile);
  }

  /** Open a tab for a session in a profile, launching the profile if needed. */
  async open(session: Session, profileName: string): Promise<{ tab: Tab; created: string | null }> {
    const { profile, created } = await this.daemon.profiles.ensure(profileName);
    const run = profile.opening.then(() => this.openIn(profile, session));
    profile.opening = run.catch(() => {});
    const tab = await run;
    session.activeTab = tab.id;
    session.lostActive = null;
    return { tab, created };
  }

  private async openIn(profile: RunningProfile, session: Session): Promise<Tab> {
    // A blank tab nobody uses (the browser's first page, or a parked one) is taken first.
    const spare = this.inProfile(profile).find((t) => t.pristine && t.owner === null && !t.page.isClosed() && t.url() === "about:blank");
    if (spare) {
      spare.pristine = false;
      spare.owner = session.id;
      this.select(spare);
      return spare;
    }
    // New tabs open beside an existing one, inside the profile's window. Juggler's
    // Browser.newPage always opens a new window, a focus risk each time (04).
    const own = this.of(session).filter((t) => t.profile === profile);
    const active = own.find((t) => t.id === session.activeTab);
    const openers = [active, ...own, ...this.inProfile(profile)]
      .filter((t): t is Tab => !!t && !t.page.isClosed())
      .filter((t, i, all) => all.indexOf(t) === i)
      .slice(0, 3);
    for (const opener of openers) {
      const page = await this.openBeside(profile, opener.page);
      if (page) {
        profile.visible = page;
        return this.register(page, profile, session.id);
      }
    }
    // No page to open from (the window was closed): a new window is the only way.
    const page = await profile.context.newPage();
    profile.visible = page;
    return this.register(page, profile, session.id);
  }

  private async openBeside(profile: RunningProfile, opener: Page): Promise<Page | null> {
    const appeared = new Promise<Page | null>((resolve) => {
      const timer = setTimeout(() => {
        profile.expecting = null;
        resolve(null);
      }, 5000);
      profile.expecting = (page) => {
        clearTimeout(timer);
        resolve(page);
      };
    });
    try {
      await opener.evaluate(OPEN_TAB_JS);
    } catch {
      profile.expecting = null;
      return null;
    }
    return appeared;
  }

  /**
   * Follow the agent: show the tab the agent works on, where that cannot take
   * keyboard focus. Measured on Wayland (R4): selecting a tab neither focuses nor
   * raises the window. Elsewhere the agent works in background tabs.
   */
  select(tab: Tab): void {
    const profile = tab.profile;
    if (profile.visible === tab.page) return;
    profile.visible = tab.page;
    if (this.daemon.config.headless || !process.env.WAYLAND_DISPLAY) return;
    tab.page.bringToFront().catch(() => {});
  }

  /**
   * The tab a tool call acts on: the given one, or the session's active tab, or a
   * blank tab in the default profile when the session has none (lazy launch, 03).
   */
  async resolve(session: Session, tabId?: number | null): Promise<Tab> {
    let tab: Tab | undefined;
    if (tabId !== undefined && tabId !== null) {
      tab = this.tabs.get(tabId);
      if (!tab || tab.page.isClosed()) throw new ToolError(`Tab ${tabId} does not exist (it may have been closed). ${await this.describe(session)}`);
      if (tab.owner !== null && tab.owner !== session.id) throw new ToolError(`Tab ${tabId} belongs to another session. ${await this.describe(session)}`);
      if (tab.owner === null) {
        tab.owner = session.id;
        tab.pristine = false;
        session.notices.push(`Adopted tab ${tab.id} (it was opened by hand in the "${tab.profile.name}" window).`);
      }
      session.lostActive = null;
    } else {
      if (session.lostActive) {
        const lost = session.lostActive;
        session.lostActive = null;
        const rest = this.of(session);
        const next = rest[rest.length - 1];
        if (next) session.activeTab = next.id;
        throw new ToolError(
          `${lost} It was the active tab, so nothing was done. ` +
            (next ? `Tab ${next.id} is active now; repeat the call if that is the tab you meant. ` : "") +
            (await this.describe(session)),
        );
      }
      tab = session.activeTab !== null ? this.tabs.get(session.activeTab) : undefined;
      if (!tab || tab.page.isClosed()) {
        const { tab: opened, created } = await this.open(session, session.defaultProfile);
        if (created) session.notices.push(created);
        tab = opened;
      }
    }
    session.activeTab = tab.id;
    this.select(tab);
    return tab;
  }

  async describe(session: Session): Promise<string> {
    const mine = this.of(session);
    if (!mine.length) return "This session has no tabs; tabs_create opens one.";
    const lines = await Promise.all(mine.map(async (t) => `${t.id} (${t.profile.name}) ${t.url()}`));
    return `Your tabs: ${lines.join("; ")}.`;
  }

  /**
   * Close a tab. The last tab of a window is parked as a blank spare instead: closing
   * it would close the window, and the next tab would need a new one (a focus risk).
   */
  async close(tab: Tab): Promise<void> {
    const others = tab.profile.context.pages().filter((p) => p !== tab.page && !p.isClosed());
    if (!others.length && !tab.profile.closing) {
      const owner = tab.owner ? this.daemon.sessions.get(tab.owner) : undefined;
      if (owner?.activeTab === tab.id) owner.activeTab = null;
      this.tabs.delete(tab.id);
      this.byPage.delete(tab.page);
      // A fresh Tab object for the same page: the old id is never reused.
      tab.closedByAgent = true;
      try {
        await tab.page.goto("about:blank", { waitUntil: "commit", timeout: 5000 });
      } catch {}
      tab.page.removeAllListeners();
      if (!tab.page.isClosed()) this.register(tab.page, tab.profile, null).pristine = true;
      return;
    }
    tab.closedByAgent = true;
    this.tabs.delete(tab.id);
    const owner = tab.owner ? this.daemon.sessions.get(tab.owner) : undefined;
    if (owner?.activeTab === tab.id) owner.activeTab = null;
    await tab.page.close().catch(() => {});
  }

  /** An MCP server exited: its tabs are closed; browsers stay for other sessions (03). */
  async closeSession(session: Session): Promise<void> {
    for (const tab of this.of(session)) await this.close(tab).catch(() => {});
  }
}
