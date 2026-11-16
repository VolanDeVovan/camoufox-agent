import { z } from "zod";
import { profileArg, tabId, type ToolDef } from "./defs.js";

export const tabTools: ToolDef[] = [
  {
    name: "tabs_context",
    description:
      "List this session's tabs across all profiles (id, profile, title, url, which is active) and every profile on disk (running or stopped). Call it first in a browsing task. Tab ids are stable and never reused.",
    shape: {
      createIfEmpty: z.boolean().optional().describe("Open a blank tab in the default profile when this session has none."),
    },
    readOnly: true,
  },
  {
    name: "tabs_create",
    description:
      'Open a new tab and make it active. `profile` picks the identity (default: the default profile); the profile\'s browser is launched if it is not running, and a name that does not exist yet is created (the reply says so and lists existing names). A profile is an identity (a set of logins), not a task: use the default one unless you need another account; call find_session(site) before logging in anywhere. "temp" is a throwaway profile.',
    shape: {
      url: z.string().optional().describe("Address to open. Omitted: a blank tab."),
      profile: profileArg.describe("Profile (identity) to open the tab in."),
    },
  },
  {
    name: "tabs_close",
    description: "Close one of this session's tabs (default: the active tab).",
    shape: { tabId },
  },
  {
    name: "navigate",
    description:
      'Go to a URL in a tab, or "back" / "forward" / "reload". A bare host gets https://. The reply gives the final URL and title, flags a challenge page (hand those to the user), and notes when another profile already holds a session for the site. Call read_page after navigating.',
    shape: {
      url: z.string().describe('URL, or "back", "forward", "reload".'),
      tabId,
    },
  },
  {
    name: "close_browser",
    description:
      "Close a browser. With `profile`: that profile's browser, for every session using it. Without: the browsers this session has tabs in (a browser another session still uses stays open; only this session's tabs in it are closed). Profiles keep their logins on disk.",
    shape: { profile: profileArg.describe("Profile whose browser to close.") },
  },
];
