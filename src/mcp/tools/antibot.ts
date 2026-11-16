import { tabId, type ToolDef } from "./defs.js";

export const antibotTools: ToolDef[] = [
  {
    name: "detect_anti_bot",
    description:
      "Is the page in a tab an anti-bot challenge (Cloudflare, DataDome, HUMAN / PerimeterX, Imperva, Akamai, AWS WAF, captcha-only pages), and which protection scripts or captcha widgets are present. On a challenge page, stop and hand over to the user: they solve it in the visible window. navigate and click replies flag challenge pages by themselves; this tool gives the detail.",
    shape: { tabId },
    readOnly: true,
  },
  {
    name: "fingerprint_audit",
    description:
      "What a page's scripts see of this browser (user agent, platform, screen, window, languages, timezone, WebGL, automation tells) and the contradictions in it. For diagnosing why a site treats the profile as a bot.",
    shape: { tabId },
    readOnly: true,
  },
];
