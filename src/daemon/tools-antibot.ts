// Group `antibot`: detect_anti_bot, fingerprint_audit.
import { text } from "../protocol.js";
import { AUDIT_JS, challengeLine, contradictions, detect } from "./antibot.js";
import { maskUrl } from "./redact.js";
import { ToolError } from "./state.js";
import { navigationHooks, onTab, tool } from "./tools.js";

// navigate and click replies say "challenge page (<vendor>)" when the same logic fires.
navigationHooks.unshift((_call, tab) => challengeLine(tab));

tool("detect_anti_bot", (call, args) =>
  onTab(call, args.tabId, async (tab) => {
    const f = await detect(tab);
    const lines = [`Tab ${tab.id} at ${maskUrl(tab.url())}:`];
    if (f.challenge) {
      lines.push(`challenge page: yes (${f.challenge})`);
      lines.push("Hand over to the user: they can solve it in the profile's visible window. Do not retry the navigation or try to solve it; when they are done, call read_page.");
    } else lines.push("challenge page: no");
    if (f.present.length) lines.push(`also on the page: ${f.present.join(", ")}`);
    if (f.evidence.length) lines.push(`evidence: ${f.evidence.join("; ")}`);
    return text(lines.join("\n"));
  }));

tool("fingerprint_audit", (call, args) =>
  onTab(call, args.tabId, async (tab) => {
    let raw: string;
    try {
      // The main world: what a page's own scripts see.
      raw = (await Promise.race([
        tab.page.evaluate("mw:" + AUDIT_JS),
        new Promise((_, reject) => setTimeout(() => reject(new Error("the page did not answer within 10 s")), 10000)),
      ])) as string;
    } catch (e: any) {
      throw new ToolError(`fingerprint_audit could not run on this page (${String(e?.message || e).split("\n")[0]}). Open an http(s) page first.`);
    }
    const fp = JSON.parse(raw);
    const pageUrl = tab.url().split("#")[0];
    const doc = [...tab.requests].reverse().find((r) => r.resourceType === "document" && r.url.split("#")[0] === pageUrl);
    const issues = contradictions(fp, doc?.requestHeaders ?? null);
    const lines = [
      `What a page sees in profile "${tab.profile.name}" (tab ${tab.id}):`,
      JSON.stringify(fp, null, 1),
      issues.length ? `contradictions (${issues.length}):\n${issues.map((i) => `  - ${i}`).join("\n")}` : "contradictions: none found",
    ];
    return text(lines.join("\n"));
  }));
