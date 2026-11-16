import { z } from "zod";
import { tabId, type ToolDef } from "./defs.js";

export const waitTools: ToolDef[] = [
  {
    name: "wait_for",
    description:
      "Wait until one of the given conditions holds; the first match wins and is named in the reply. A timeout is an error. Conditions: text appears, text_gone disappears, a CSS selector is visible, the URL contains a substring (or matches a * pattern), the page changed, the network is idle.",
    shape: {
      text: z.string().optional().describe("Wait for this text on the page (case-insensitive)."),
      text_gone: z.string().optional().describe("Wait until this text is no longer on the page (a spinner, 'Loading...')."),
      selector: z.string().optional().describe("Wait for a CSS selector to be visible."),
      url: z.string().optional().describe("Wait for the tab's URL to contain this, or to match it when it has * wildcards."),
      page_changed: z.boolean().optional().describe("Wait for the page to change (navigation, DOM size, text)."),
      network_idle: z.boolean().optional().describe("Wait for no request in flight for 500 ms."),
      timeout_s: z.number().min(0.1).max(120).optional().describe("Seconds to wait (default 10)."),
      tabId,
    },
    readOnly: true,
  },
  {
    name: "handle_dialog",
    description:
      "Arm the answer for the next alert / confirm / prompt in a tab, or set a standing rule. Without it every dialog is dismissed (and the reply of the action that caused it says so). Arm it before the action that opens the dialog.",
    shape: {
      accept: z.boolean().optional().describe("true: OK / accept. false: Cancel / dismiss."),
      prompt_text: z.string().optional().describe("Text to enter into a prompt()."),
      standing: z.boolean().optional().describe("Apply to every dialog in this tab until cleared, not only the next one."),
      clear: z.boolean().optional().describe("Remove armed answers and the standing rule."),
      tabId,
    },
  },
];
