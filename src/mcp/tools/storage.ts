import { z } from "zod";
import { revealValues, tabId, type ToolDef } from "./defs.js";

export const storageTools: ToolDef[] = [
  {
    name: "find_session",
    description:
      'Which profile holds a session for a site? Call it before logging in anywhere. `site` is a domain (dash.cloudflare.com, github.com) or a bare name (github); matching is on the registrable domain. The reply lists, per profile, the hosts with cookies or storage, the names of auth-looking cookies and their expiry - evidence, not a "logged in" verdict; values are never shown. A hit is a candidate: open a tab in that profile (tabs_create with profile) and check the page.',
    shape: { site: z.string().describe("Domain or bare site name.") },
    readOnly: true,
  },
  {
    name: "cookies",
    description:
      "Cookies of the profile a tab is in. list: for the tab's URL by default, or `url` / `domain` / `name`; values are masked unless reveal_values. set: name + value for `url` (default: the tab's) or `domain`. delete: by name and / or domain.",
    shape: {
      action: z.enum(["list", "set", "delete"]).optional().describe("Default: list."),
      url: z.string().optional(),
      domain: z.string().optional(),
      name: z.string().optional(),
      value: z.string().optional(),
      path: z.string().optional(),
      expires_in_s: z.number().positive().optional().describe("set: lifetime in seconds. Omitted: a session cookie."),
      http_only: z.boolean().optional(),
      secure: z.boolean().optional(),
      same_site: z.enum(["Strict", "Lax", "None"]).optional(),
      reveal_values: revealValues,
      tabId,
    },
  },
  {
    name: "web_storage",
    description:
      "localStorage / sessionStorage of the page in a tab. get: one `key`, or every key; set, remove, clear. Values under secret-looking keys and token-shaped values are masked unless reveal_values.",
    shape: {
      action: z.enum(["get", "set", "remove", "clear"]).optional().describe("Default: get."),
      kind: z.enum(["local", "session"]).optional().describe("Default: local."),
      key: z.string().optional(),
      value: z.string().optional(),
      reveal_values: revealValues,
      tabId,
    },
  },
];
