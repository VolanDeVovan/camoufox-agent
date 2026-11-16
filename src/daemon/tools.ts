// Tool handlers: the daemon side of every MCP tool (05-tools.md). Arguments arrive
// validated by the MCP server's schemas.
import type { ToolResult } from "../protocol.js";
import { fail, text } from "../protocol.js";
import { TEMP_PROFILE, validateProfileName } from "../paths.js";
import { goto, history, normalizeUrl, reload } from "./navigation.js";
import type { Daemon, Session } from "./state.js";
import { ToolError } from "./state.js";
import type { Tab } from "./tabs.js";

export interface Call {
  daemon: Daemon;
  session: Session;
}

type Handler = (call: Call, args: any) => Promise<ToolResult>;

export const handlers: Record<string, Handler> = {};
/** Per-tool deadline in ms; a function gets the arguments. Default 30 s. */
export const deadlines: Record<string, number | ((args: any) => number)> = {};

export function tool(name: string, handler: Handler, deadline?: number | ((args: any) => number)): void {
  handlers[name] = handler;
  if (deadline !== undefined) deadlines[name] = deadline;
}

/** Run a handler body with the tab's calls serialized. */
export async function onTab<T>(call: Call, tabId: number | undefined, body: (tab: Tab) => Promise<T>): Promise<T> {
  const tab = await call.daemon.tabs.resolve(call.session, tabId);
  const run = tab.queue.then(() => body(tab));
  tab.queue = run.catch(() => {});
  return run;
}

export async function tabLine(tab: Tab, active: boolean): Promise<string> {
  const title = (await tab.title()).replace(/\s+/g, " ").slice(0, 60);
  return `  ${String(tab.id).padEnd(3)} ${tab.profile.name.padEnd(12)} ${JSON.stringify(title)}  ${tab.url()}${active ? "   <- active" : ""}`;
}

export async function tabsContext(call: Call): Promise<string> {
  const { daemon, session } = call;
  const mine = daemon.tabs.of(session);
  const lines: string[] = [];
  if (session.lostActive) {
    lines.push(session.lostActive + " It was the active tab.");
    session.lostActive = null;
    const next = mine[mine.length - 1];
    if (next) session.activeTab = next.id;
  }
  lines.push("tabs (this session):");
  if (!mine.length) lines.push("  (none; tabs_create opens one, and any page tool opens a blank tab in the default profile)");
  for (const t of mine) lines.push(await tabLine(t, t.id === session.activeTab));
  const loose = daemon.tabs.unowned();
  if (loose.length) {
    lines.push("tabs opened by hand (no session owns them; pass the id as tabId to adopt one):");
    for (const t of loose) lines.push(await tabLine(t, false));
  }
  const profiles = daemon.profiles.list();
  lines.push(
    "profiles: " +
      (profiles.length ? profiles.map((p) => (p.running ? `${p.name} (running)` : p.name)).join(", ") : "(none yet)") +
      `   [default: ${session.defaultProfile}]`,
  );
  return lines.join("\n");
}

tool("tabs_context", async (call, args) => {
  if (args.createIfEmpty && !call.daemon.tabs.of(call.session).length && !call.session.lostActive) {
    const { created } = await call.daemon.tabs.open(call.session, call.session.defaultProfile);
    if (created) call.session.notices.push(created);
  }
  return text(await tabsContext(call));
}, 60000);

tool("tabs_create", async (call, args) => {
  const profileName = validateProfileName(args.profile ?? call.session.defaultProfile);
  const { tab, created } = await call.daemon.tabs.open(call.session, profileName);
  const out: string[] = [];
  if (created) out.push(created);
  if (profileName === TEMP_PROFILE) out.push('"temp" is a throwaway profile: it is deleted when its browser closes.');
  let navError = "";
  if (args.url) {
    try {
      await goto(tab, args.url);
    } catch (e: any) {
      navError = String(e?.message || e);
    }
  }
  out.push(`Opened tab ${tab.id} in profile "${tab.profile.name}"; it is the active tab. URL: ${tab.url()}`);
  if (navError) return fail(out.join("\n") + `\n${navError}`);
  for (const extra of await afterNavigation(call, tab)) out.push(extra);
  return text(out.join("\n"));
}, 90000);

tool("tabs_close", async (call, args) => {
  const { daemon, session } = call;
  const id = args.tabId ?? session.activeTab;
  if (id === null || id === undefined) return fail("No tab to close: this session has no active tab. " + (await daemon.tabs.describe(session)));
  const tab = daemon.tabs.get(id);
  if (!tab) return fail(`Tab ${id} does not exist. ` + (await daemon.tabs.describe(session)));
  if (tab.owner !== session.id) return fail(`Tab ${id} is not this session's tab. ` + (await daemon.tabs.describe(session)));
  await daemon.tabs.close(tab);
  session.lostActive = null;
  const rest = daemon.tabs.of(session);
  if (session.activeTab === null && rest.length) session.activeTab = rest[rest.length - 1].id;
  return text(`Closed tab ${id}.` + (session.activeTab !== null ? ` Active tab is now ${session.activeTab}.` : " This session has no tabs left."));
});

/** Extra reply lines after landing on a page: challenge detection, cross-profile hint. Filled in by later modules. */
export const navigationHooks: ((call: Call, tab: Tab) => Promise<string | null>)[] = [];

export async function afterNavigation(call: Call, tab: Tab): Promise<string[]> {
  const out: string[] = [];
  for (const hook of navigationHooks) {
    try {
      const line = await hook(call, tab);
      if (line) out.push(line);
    } catch {}
  }
  return out;
}

tool("navigate", (call, args) =>
  onTab(call, args.tabId, async (tab) => {
    const target = String(args.url).trim();
    const lower = target.toLowerCase();
    if (lower === "back" || lower === "forward") {
      const moved = await history(tab, lower);
      if (!moved) return fail(`Cannot go ${lower}: there is no ${lower === "back" ? "previous" : "next"} page in this tab's history. URL: ${tab.url()}`);
    } else if (lower === "reload") {
      await reload(tab);
    } else {
      if (!normalizeUrl(target)) throw new ToolError("navigate needs a url, or back / forward / reload.");
      await goto(tab, target);
    }
    const title = await tab.title();
    const out = [`Tab ${tab.id} is at ${tab.url()}${title ? ` (${title})` : ""}`];
    for (const extra of await afterNavigation(call, tab)) out.push(extra);
    return text(out.join("\n"));
  }), 60000);

tool("close_browser", async (call, args) => {
  const { daemon, session } = call;
  if (args.profile) {
    const name = validateProfileName(args.profile);
    const closed = await daemon.profiles.close(name, session.id);
    return text(closed ? `Closed the browser of profile "${name}" (for every session).` : `Profile "${name}" was not running.`);
  }
  // Without a profile: the browsers this session has tabs in; browsers other sessions still use stay open.
  const mine = daemon.tabs.of(session);
  const profiles = [...new Set(mine.map((t) => t.profile))];
  if (!profiles.length) return text("This session has no tabs, so there is no browser to close.");
  const closed: string[] = [];
  const kept: string[] = [];
  for (const profile of profiles) {
    const others = daemon.tabs.inProfile(profile).some((t) => t.owner !== null && t.owner !== session.id);
    if (others) {
      for (const t of mine.filter((t) => t.profile === profile)) await daemon.tabs.close(t);
      kept.push(profile.name);
    } else {
      await daemon.profiles.close(profile.name, session.id);
      closed.push(profile.name);
    }
  }
  session.activeTab = null;
  session.lostActive = null;
  const parts: string[] = [];
  if (closed.length) parts.push(`Closed the browser of: ${closed.join(", ")}.`);
  if (kept.length) parts.push(`Closed this session's tabs in ${kept.join(", ")}; that browser stays open because another session uses it.`);
  return text(parts.join(" "));
}, 60000);
