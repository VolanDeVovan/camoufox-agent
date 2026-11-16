// read_page, find, get_page_text (05-tools.md; refs in 06-page-interaction.md).
import { fail, text } from "../protocol.js";
import { maskUrl, untrusted } from "./redact.js";
import { pageText, snapshot } from "./snapshot.js";
import { onTab, tool } from "./tools.js";

function page(lines: string[], offset: number, limit: number, maxChars: number): { shown: string[]; from: number; to: number; cut: boolean } {
  const from = Math.max(0, Math.min(offset, lines.length));
  const shown: string[] = [];
  let chars = 0;
  let to = from;
  for (; to < lines.length && shown.length < limit; to++) {
    if (chars + lines[to].length + 1 > maxChars && shown.length) break;
    shown.push(lines[to]);
    chars += lines[to].length + 1;
  }
  return { shown, from, to, cut: to < lines.length };
}

tool("read_page", (call, args) =>
  onTab(call, args.tabId, async (tab) => {
    const mode = args.filter === "all" ? "all" : "interactive";
    const snap = await snapshot(tab, { mode, rootRef: args.ref_id, reveal: !!args.reveal_values });
    const { shown, from, to, cut } = page(snap.lines, args.offset ?? 0, args.limit ?? 100000, args.max_chars ?? 25000);
    const head = `${tab.url() ? maskUrl(tab.url()) : "about:blank"} - ${JSON.stringify(await tab.title())} (tab ${tab.id}${args.ref_id ? `, under ${args.ref_id}` : ""}, ${mode})`;
    const body = shown.length ? shown.join("\n") : snap.lines.length ? "(nothing in this range)" : mode === "interactive" ? "(no interactive elements or headings; filter=\"all\" also lists text)" : "(the page is empty)";
    const tail: string[] = [];
    if (cut || from > 0) tail.push(`truncated: showing lines ${from + 1}-${to} of ${snap.lines.length}${cut ? `; read_page with offset=${to} continues` : ""}`);
    for (const n of snap.note) tail.push(`note: ${n}`);
    return text(untrusted(head, body) + (tail.length ? "\n" + tail.join("\n") : ""));
  }));

tool("find", (call, args) =>
  onTab(call, args.tabId, async (tab) => {
    const query = String(args.query ?? "").trim();
    if (!query && !args.role) return fail("find needs a query (text, label or placeholder to look for) or a role.");
    const snap = await snapshot(tab, { mode: "find", query, role: args.role, reveal: !!args.reveal_values });
    const what = [query ? JSON.stringify(query) : "", args.role ? `role ${args.role}` : ""].filter(Boolean).join(", ");
    if (!snap.lines.length) {
      return text(`No visible element matches ${what} on ${maskUrl(tab.url())}. The match is literal (a case-insensitive substring of the name, text, label, placeholder, value or link target); try a shorter query or read_page.`);
    }
    const limit = args.limit ?? 50;
    const shown = snap.lines.slice(0, limit);
    const tail = snap.lines.length > limit ? `\n${snap.lines.length - limit} more matches not shown; narrow the query or raise limit.` : "";
    return text(untrusted(`${snap.lines.length} match${snap.lines.length === 1 ? "" : "es"} for ${what} in tab ${tab.id}`, shown.join("\n")) + tail);
  }));

tool("get_page_text", (call, args) =>
  onTab(call, args.tabId, async (tab) => {
    const { title, text: body } = await pageText(tab);
    const max = args.max_chars ?? 30000;
    const offset = Math.max(0, args.offset ?? 0);
    const slice = body.slice(offset, offset + max);
    const more = offset + max < body.length;
    const head = `Text of ${maskUrl(tab.url())} - ${JSON.stringify(title)} (tab ${tab.id})`;
    return text(
      untrusted(head, slice || "(no text)") +
        (more || offset ? `\ntruncated: characters ${offset}-${offset + slice.length} of ${body.length}${more ? `; get_page_text with offset=${offset + slice.length} continues` : ""}` : ""),
    );
  }));
