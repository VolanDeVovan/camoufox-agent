// Group `wait`: wait_for, handle_dialog (05-tools.md; dialogs in 06).
import { fail, text } from "../protocol.js";
import { evalWithin } from "./navigation.js";
import { maskUrl } from "./redact.js";
import { ToolError } from "./state.js";
import { tool, withTab } from "./tools.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function urlMatches(url: string, pattern: string): boolean {
  if (!pattern.includes("*")) return url.includes(pattern);
  const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(url);
}

const CHANGE_JS = `(function () { var b = document.body; var t = b ? b.innerText : ""; return location.href + "|" + document.getElementsByTagName("*").length + "|" + t.length + "|" + (function (s) { var x = 5381; for (var i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; return x; })(t); })()`;

tool("wait_for", (call, args) =>
  withTab(call, args.tabId, async (tab) => {
    const page = tab.page;
    const timeout = Math.min(120, Math.max(0.1, args.timeout_s ?? 10)) * 1000;
    const wants = ["text", "text_gone", "selector", "url"].filter((k) => typeof args[k] === "string" && args[k]).concat(["page_changed", "network_idle"].filter((k) => args[k] === true));
    if (!wants.length) throw new ToolError("wait_for needs at least one condition: text, text_gone, selector, url, page_changed or network_idle.");
    const started = Date.now();
    const before = args.page_changed ? await evalWithin<string>(page, CHANGE_JS, 2000) : undefined;
    const navBefore = tab.navSeq;
    let quietSince = 0;
    const lower = (s: string) => s.toLowerCase();
    for (;;) {
      let hit = "";
      if (args.url && urlMatches(page.url(), args.url)) hit = `URL matches ${JSON.stringify(args.url)}: ${maskUrl(page.url())}`;
      if (!hit && (args.text || args.text_gone)) {
        const body = lower((await evalWithin<string>(page, `document.body ? document.body.innerText : ""`, 2000)) ?? "");
        if (args.text && body.includes(lower(args.text))) hit = `text ${JSON.stringify(args.text)} is on the page`;
        else if (args.text_gone && !body.includes(lower(args.text_gone))) hit = `text ${JSON.stringify(args.text_gone)} is gone`;
      }
      if (!hit && args.selector) {
        const visible = await page.locator(args.selector).first().isVisible().catch((e: any) => {
          if (/selector|parse|unexpected token/i.test(String(e?.message))) throw new ToolError(`Invalid selector ${JSON.stringify(args.selector)}.`);
          return false;
        });
        if (visible) hit = `selector ${JSON.stringify(args.selector)} is visible`;
      }
      if (!hit && args.page_changed) {
        if (tab.navSeq !== navBefore) hit = `the page changed (navigated to ${maskUrl(page.url())})`;
        else {
          const now = await evalWithin<string>(page, CHANGE_JS, 2000);
          if (now !== undefined && before !== undefined && now !== before) hit = "the page changed";
        }
      }
      if (!hit && args.network_idle) {
        if (tab.inflight === 0) {
          if (!quietSince) quietSince = Date.now();
          if (Date.now() - quietSince >= 500) hit = "the network has been idle for 500 ms";
        } else quietSince = 0;
      }
      if (hit) return text(`${hit} (after ${((Date.now() - started) / 1000).toFixed(1)} s).`);
      if (Date.now() - started >= timeout) {
        return fail(`Timed out after ${timeout / 1000} s waiting for ${wants.join(" / ")}. The tab is at ${maskUrl(page.url())}.`);
      }
      await sleep(100);
    }
  }), (args) => (Math.min(120, Math.max(0.1, args.timeout_s ?? 10)) + 10) * 1000);

tool("handle_dialog", async (call, args) => {
  // No queue: this must be callable while another call on the tab is in flight.
  const tab = await call.daemon.tabs.resolve(call.session, args.tabId);
  if (args.clear) {
    tab.dialogOnce = null;
    tab.dialogRule = null;
    return text(`Tab ${tab.id}: dialog answers cleared; dialogs are dismissed by default again.`);
  }
  if (typeof args.accept !== "boolean") throw new ToolError("handle_dialog needs accept: true / false (or clear: true).");
  const answer = { accept: args.accept, promptText: typeof args.prompt_text === "string" ? args.prompt_text : undefined };
  const how = `${answer.accept ? "accepted" : "dismissed"}${answer.promptText !== undefined ? ` with text ${JSON.stringify(answer.promptText)}` : ""}`;
  if (args.standing) {
    tab.dialogRule = answer;
    return text(`Tab ${tab.id}: every alert / confirm / prompt will be ${how} until handle_dialog(clear=true).`);
  }
  tab.dialogOnce = answer;
  return text(`Tab ${tab.id}: the next alert / confirm / prompt will be ${how}.`);
});
