// TabRegistry: tab ids, which session owns each tab, each session's active tab.
import type { Dialog, Frame, Page } from "playwright-core";
import { attachCapture, type ConsoleEntry, type DialogAnswer, type NetEntry } from "./capture.js";
import type { RunningProfile } from "./profiles.js";
import type { Daemon, Session } from "./state.js";
import { evalWithin } from "./navigation.js";
import { maskUrl } from "./redact.js";
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
  /** A fresh browser's first page, blank, until a session takes it. */
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
  /** Opened blank because a tool needed a tab and the session had none; tabs_create takes it. */
  implicit = false;
  /** When an agent or the user last used the tab. */
  lastUsed = Date.now();
  /** Left open by a session that ended (otherwise a free tab was opened by the user or a page). */
  leftBySession = false;
  /** What an agent said the tab is for. */
  label: string | null = null;
  /** Exempt from the idle close. */
  keep = false;
  /** Agent calls acting on the tab right now, and when the last one ended. */
  acting = 0;
  agentAt = 0;
  /** In a window, a dialog no agent action opened is left for the user to answer. */
  userAnswers = false;
  /** Such a dialog, while it may still be open. */
  pendingDialog: { dialog: Dialog; what: string } | null = null;
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

  /** Run an agent action on the tab: a dialog it opens is the agent's to answer. */
  async act<T>(fn: () => Promise<T>): Promise<T> {
    this.acting++;
    try {
      return await fn();
    } finally {
      this.acting--;
      this.agentAt = Date.now();
      this.lastUsed = this.agentAt;
    }
  }

  /** Did an agent action open a dialog appearing now (one in flight, or one that just ended)? */
  agentActing(): boolean {
    return this.acting > 0 || Date.now() - this.agentAt < 2000;
  }

  /** Is the dialog left to the user still open? A page with an open dialog answers no script. */
  async dialogOpen(): Promise<boolean> {
    const pending = this.pendingDialog;
    if (!pending) return false;
    if ((await evalWithin<number>(this.page, "1", 700)) === undefined) return true;
    // The user answered it. Playwright still counts it as open (it ignores Juggler's
    // dialogClosed) and fails some calls meanwhile, page.title() among them: handling
    // it here clears that; Juggler, which no longer has it, refuses, and that is fine.
    this.pendingDialog = null;
    await pending.dialog.dismiss().catch(() => {});
    return false;
  }

  /** Drop console, network and events: they belonged to the previous owner. */
  forgetCaptures(): void {
    this.console = [];
    this.requests = [];
    this.events = [];
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

/**
 * The user's input counts as use of a tab, like an agent's call. Listeners in the
 * isolated world (the page cannot see them) note the last trusted pointer, key or wheel
 * event; the expression installs them when missing and answers how many ms ago that
 * was, or -1. A page cannot fake input to keep itself open: untrusted events are ignored.
 */
const INPUT_JS = `(function () {
  var s = window.__cfaInput;
  if (!s) {
    s = window.__cfaInput = { t: 0 };
    var note = function (e) { if (e.isTrusted) s.t = Date.now(); };
    ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"].forEach(function (type) {
      addEventListener(type, note, { capture: true, passive: true });
    });
  }
  return s.t ? Date.now() - s.t : -1;
})()`;

/** A duration for a reply: "60 min", "90 s". */
export function duration(ms: number): string {
  return ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`;
}

/** How long a window.open we gave up on may still open its tab. */
const ABANDONED_MS = 60000;

const OPEN_TAB_JS = `(function () { window.open("about:blank", "_blank", "noopener,noreferrer"); return 1; })()`;

export class TabRegistry {
  private nextId = 1;
  private sweeping = false;
  private sweepAgain = false;
  private tabs = new Map<number, Tab>();
  private byPage = new WeakMap<Page, Tab>();

  constructor(private daemon: Daemon) {}

  /** Start tracking a freshly launched browser. */
  attach(profile: RunningProfile, firstPage: Page | null): void {
    if (firstPage) this.register(firstPage, profile, null).pristine = true;
    profile.context.on("page", (page) => void this.onPage(profile, page));
  }

  private register(page: Page, profile: RunningProfile, owner: string | null): Tab {
    const existing = this.byPage.get(page);
    if (existing) return existing;
    const tab = new Tab(this.nextId++, page, profile, owner);
    tab.userAnswers = !this.daemon.config.headless;
    this.tabs.set(tab.id, tab);
    this.byPage.set(page, tab);
    attachCapture(tab);
    page.on("close", () => this.onClosed(tab));
    // A new document has no listeners yet. (load / domcontentloaded are not reliable in Camoufox.)
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      // A window.open we gave up on dies with the document that was to run it.
      profile.abandoned.delete(page);
      setTimeout(() => void this.userInput(tab), 1000);
    });
    void this.userInput(tab);
    return tab;
  }

  /** A page appeared in a browser: ours, a site's popup, or one the user opened by hand. */
  private async onPage(profile: RunningProfile, page: Page): Promise<void> {
    const opener = await page.opener().catch(() => null);
    // The tab we asked for starts blank and comes from the page we opened it from (Juggler
    // reports that page as its opener even with noopener). A popup another page opens
    // at the same moment is not handed to whoever is waiting.
    const blank = /^(about:blank)?$/.test(page.url());
    if (profile.expecting && (!opener || opener === profile.expectingFrom) && blank) {
      const resolve = profile.expecting;
      profile.expecting = null;
      // Any blank tab from that page will do; one of the abandoned ones may come first,
      // and then the tab of this call is the one that is closed.
      resolve(page);
      return;
    }
    // A tab we asked a busy page for and stopped waiting for: nobody wants it.
    if (opener && blank && this.settle(profile, opener)) {
      await page.close().catch(() => {});
      return;
    }
    let parent: Tab | undefined = opener ? this.byPage.get(opener) : undefined;
    // A link with rel=noopener has no opener; a tab appearing right after an agent action
    // is that action's. A tab the user opens by hand (Ctrl+T: about:newtab / about:home)
    // is not, and belongs to no session.
    const byHand = /^about:(newtab|home|privatebrowsing|welcome)/.test(page.url());
    if (!parent && !byHand && profile.lastAction && Date.now() - profile.lastAction.at < 1500) parent = this.byPage.get(profile.lastAction.page);
    if (this.byPage.has(page) || page.isClosed()) return;
    // A session that has ended owns nothing: a popup its tab opens late is free.
    const owner = parent?.owner && this.daemon.sessions.has(parent.owner) ? parent.owner : null;
    const tab = this.register(page, profile, owner);
    profile.visible = page; // Firefox selects a tab a page opens
    if (parent) parent.pushEvent("popup", `opened tab ${tab.id}`);
  }

  /** One window.open of ours from `opener` produced its tab; true if we had given up on it. */
  private settle(profile: RunningProfile, opener: Page): boolean {
    const late = (profile.abandoned.get(opener) ?? []).filter((at) => Date.now() - at < ABANDONED_MS);
    const ours = late.shift() !== undefined;
    if (late.length) profile.abandoned.set(opener, late);
    else profile.abandoned.delete(opener);
    return ours;
  }

  private onClosed(tab: Tab): void {
    tab.profile.abandoned.delete(tab.page);
    if (!this.tabs.delete(tab.id)) return;
    const profile = tab.profile;
    if (profile.visible === tab.page) profile.visible = null;
    const session = tab.owner ? this.daemon.sessions.get(tab.owner) : undefined;
    if (!session) return;
    const what = `Tab ${tab.id} (${profile.name}, ${maskUrl(tab.url()) || "about:blank"}) was closed by the user or by the page.`;
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

  /** The browser of a profile is gone: forget its tabs and tell their owners. */
  dropProfile(profile: RunningProfile, notice: string): void {
    profile.goneNotice = notice;
    const told = new Set<string>();
    for (const tab of [...this.tabs.values()]) {
      if (tab.profile !== profile) continue;
      this.tabs.delete(tab.id);
      const session = tab.owner ? this.daemon.sessions.get(tab.owner) : undefined;
      if (!session) continue;
      const wasActive = session.activeTab === tab.id;
      if (wasActive) session.activeTab = null;
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

  /** Tabs no session owns (left by an ended session, or opened by the user or a page): any session may take one. */
  free(): Tab[] {
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
    if (this.daemon.sessions.get(session.id) !== session) {
      // The session went away while its tab was opening: nobody would ever close it.
      await this.close(tab).catch(() => {});
      throw new ToolError("The session ended before the tab opened.");
    }
    session.activeTab = tab.id;
    session.lostActive = null;
    tab.lastUsed = Date.now();
    return { tab, created };
  }

  private async openIn(profile: RunningProfile, session: Session): Promise<Tab> {
    // A fresh browser's blank first page is taken first.
    const spare = this.inProfile(profile).find((t) => t.pristine && t.owner === null && !t.page.isClosed() && t.url() === "about:blank");
    if (spare) {
      spare.pristine = false;
      spare.owner = session.id;
      this.select(spare);
      return spare;
    }
    // So is the blank tab a tool opened for this session when it had none (cookies,
    // read_page before any tabs_create): otherwise it stays beside the new one.
    const unused = this.of(session).find((t) => t.implicit && t.profile === profile && !t.page.isClosed() && t.url() === "about:blank");
    if (unused) {
      unused.implicit = false;
      this.select(unused);
      return unused;
    }
    // New tabs open beside an existing one, inside the profile's window. Juggler's
    // Browser.newPage always opens a new window, a focus risk each time.
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
    // No page to open from (the window was closed, or every page is busy): a new window
    // is the only way. It is expected like any other tab, so the page event does not
    // register it first as a tab the user opened by hand.
    const page = await this.expectTab(profile, null, () => profile.context.newPage().then(() => {}), 30000);
    if (!page) throw new ToolError(`Could not open a tab in profile "${profile.name}".`);
    profile.visible = page;
    return this.register(page, profile, session.id);
  }

  private async openBeside(profile: RunningProfile, opener: Page): Promise<Page | null> {
    // A page with a busy main thread never answers: the wait is on the tab appearing, not on this call.
    const page = await this.expectTab(profile, opener, () => opener.evaluate(OPEN_TAB_JS).then(() => {}), 5000);
    // Given up: the call still opens its tab once the page is free again, and that tab is closed.
    if (!page && !opener.isClosed()) profile.abandoned.set(opener, [...(profile.abandoned.get(opener) ?? []), Date.now()]);
    return page;
  }

  /** Run `open` and wait for the blank tab it makes (from `opener`, or with none). */
  private expectTab(profile: RunningProfile, opener: Page | null, open: () => Promise<void>, timeoutMs: number): Promise<Page | null> {
    let timer: NodeJS.Timeout;
    let giveUp!: () => void;
    const appeared = new Promise<Page | null>((resolve) => {
      const expecting = (page: Page) => {
        clearTimeout(timer);
        resolve(page);
      };
      giveUp = () => {
        clearTimeout(timer);
        if (profile.expecting === expecting) profile.expecting = null;
        resolve(null);
      };
      timer = setTimeout(giveUp, timeoutMs);
      profile.expecting = expecting;
      profile.expectingFrom = opener;
    });
    // A failed call opens nothing (the browser is closing, the page went away): do not wait for it.
    open().catch(giveUp);
    return appeared;
  }

  /**
   * Follow the agent: show the tab the agent works on, where that cannot take
   * keyboard focus. Measured on Wayland: selecting a tab neither focuses nor
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
   * blank tab in the default profile when the session has none.
   */
  async resolve(session: Session, tabId?: number | null): Promise<Tab> {
    // A call still running when its session ended (a long browser_batch) acts no more.
    if (this.daemon.sessions.get(session.id) !== session) throw new ToolError("The session has ended.");
    let tab: Tab | undefined;
    if (tabId !== undefined && tabId !== null) {
      tab = this.tabs.get(tabId);
      if (!tab || tab.page.isClosed()) throw new ToolError(`Tab ${tabId} does not exist (it may have been closed). ${await this.describe(session)}`);
      if (tab.owner !== null && tab.owner !== session.id) throw new ToolError(`Tab ${tabId} belongs to another session. ${await this.describe(session)}`);
      if (tab.owner === null) {
        tab.owner = session.id;
        tab.pristine = false;
        tab.leftBySession = false;
        // What was captured while it was free (the user may have logged in there) is not handed over.
        tab.forgetCaptures();
        session.notices.push(`Took tab ${tab.id}: it is this session's tab now.`);
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
        if (tab.url() === "about:blank") tab.implicit = true;
      }
    }
    session.activeTab = tab.id;
    tab.lastUsed = Date.now();
    this.select(tab);
    return tab;
  }

  async describe(session: Session): Promise<string> {
    const mine = this.of(session);
    if (!mine.length) return "This session has no tabs; tabs_create opens one.";
    const lines = await Promise.all(mine.map(async (t) => `${t.id} (${t.profile.name}) ${maskUrl(t.url())}`));
    return `Your tabs: ${lines.join("; ")}.`;
  }

  /** Close a tab. The browser closes with its last tab, as Firefox does with its last window. */
  async close(tab: Tab): Promise<void> {
    this.tabs.delete(tab.id); // first: onClosed then says nothing (the agent closed it)
    const owner = tab.owner ? this.daemon.sessions.get(tab.owner) : undefined;
    if (owner?.activeTab === tab.id) owner.activeTab = null;
    const others = tab.profile.context.pages().filter((p) => p !== tab.page && !p.isClosed());
    if (!others.length && !tab.profile.closing) await this.daemon.profiles.close(tab.profile.name);
    else await tab.page.close().catch(() => {});
  }

  /**
   * Close what nobody uses: a tab nobody (an agent or the user) used for tabIdleMs (its
   * owner, if any, is told on its next call; the browser goes with its last tab), and,
   * with no session connected, a browser left with nothing but its blank first page (a
   * safety net: a session's blank tabs are closed when it ends).
   */
  async sweep(): Promise<void> {
    if (this.sweeping) {
      this.sweepAgain = true;
      return;
    }
    this.sweeping = true;
    try {
      await Promise.all([...this.tabs.values()].map((t) => this.userInput(t)));
      const now = Date.now();
      for (const tab of [...this.tabs.values()]) {
        if (this.tabs.get(tab.id) !== tab || tab.keep || tab.profile.closing || now - tab.lastUsed < this.daemon.tabIdleMs) continue;
        await this.expire(tab);
      }
      for (const profile of this.daemon.profiles.allRunning()) {
        // A session may connect while a browser closes: checked for each.
        if (this.daemon.sessions.size > 0) break;
        if (!profile.closing && this.inProfile(profile).every((t) => t.pristine || t.page.isClosed())) await this.daemon.profiles.close(profile.name);
      }
    } catch (e: any) {
      this.daemon.log("sweep failed:", e?.stack || e);
    } finally {
      this.sweeping = false;
    }
    // A sweep asked for while this one ran (a session left) runs now, not at the next tick.
    if (this.sweepAgain) {
      this.sweepAgain = false;
      await this.sweep();
    }
  }

  /** Fold the user's last input in the tab into lastUsed (and install the listeners). */
  private async userInput(tab: Tab): Promise<void> {
    if (tab.page.isClosed()) return;
    const ago = await evalWithin<number>(tab.page, INPUT_JS, 1000);
    if (typeof ago === "number" && ago >= 0) tab.lastUsed = Math.max(tab.lastUsed, Date.now() - ago);
  }

  private async expire(tab: Tab): Promise<void> {
    const what = `Tab ${tab.id} (${tab.profile.name}, ${maskUrl(tab.url()) || "about:blank"}) was closed: nobody used it for ${duration(this.daemon.tabIdleMs)}.`;
    const session = tab.owner ? this.daemon.sessions.get(tab.owner) : undefined;
    if (session) {
      if (session.activeTab === tab.id) {
        session.activeTab = null;
        session.lostActive = what;
      } else session.notices.push(what);
    }
    this.daemon.log(`tab ${tab.id} (${tab.profile.name}) expired`);
    await this.close(tab);
  }

  /**
   * An MCP server exited. Its blank tabs are closed; the others stay open, owned by
   * nobody, for the user and for a later session to take. What the session set up in
   * them (request blocking, dialog answers) is undone, and what was captured in them
   * (console, network) is forgotten: the next owner is another session.
   */
  async closeSession(session: Session): Promise<void> {
    for (const tab of this.of(session)) {
      if (tab.page.isClosed() || /^(about:blank)?$/.test(tab.url())) await this.close(tab).catch(() => {});
      else await this.release(tab);
    }
  }

  private async release(tab: Tab): Promise<void> {
    tab.owner = null;
    tab.implicit = false;
    tab.leftBySession = true;
    tab.dialogOnce = null;
    tab.dialogRule = null;
    if (tab.blocking) {
      const { handler } = tab.blocking;
      tab.blocking = null;
      await tab.page.unroute("**/*", handler).catch(() => {});
    }
    tab.forgetCaptures();
  }
}
