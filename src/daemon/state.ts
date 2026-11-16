// Shared daemon state types.
import type { Socket } from "node:net";
import type { DaemonConfig } from "../paths.js";
import type { ProfileManager } from "./profiles.js";
import type { TabRegistry } from "./tabs.js";

/** One connected MCP server = one Claude Code session. */
export interface Session {
  id: string;
  cwd: string;
  defaultProfile: string;
  socket: Socket | null;
  /** The tab page tools act on when no tabId is given. */
  activeTab: number | null;
  /** Things that happened behind the session's back; shown on its next reply. */
  notices: string[];
  /** Set when the active tab went away; the next call says so instead of silently switching. */
  lostActive: string | null;
  /** Sites the cross-profile hint was already given for, so it is said once. */
  hinted: Set<string>;
}

export interface Daemon {
  config: DaemonConfig;
  profiles: ProfileManager;
  tabs: TabRegistry;
  sessions: Map<string, Session>;
  /** A tab nobody (an agent or the user) used for this long is closed (CAMOUFOX_AGENT_TAB_IDLE_MS). */
  tabIdleMs: number;
  /** Something that keeps the daemon alive went away: exit if nothing is left. */
  checkIdle(): void;
  log(...args: unknown[]): void;
}

/** An error whose message is meant for the agent as is. */
export class ToolError extends Error {}
