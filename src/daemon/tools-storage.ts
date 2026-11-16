// find_session, and the `storage` group: cookies, web_storage (05-tools.md).
import { fail, text } from "../protocol.js";
import { evalWithin } from "./navigation.js";
import { isSecretName, maskBody, maskUrl, maskedValue, untrusted } from "./redact.js";
import { crossProfileHint, findSession } from "./sessions.js";
import { ToolError } from "./state.js";
import { navigationHooks, onTab, tool, withTab } from "./tools.js";

tool("find_session", async (call, args) => {
  const site = String(args.site ?? "").trim();
  if (!site) return fail("find_session needs site: a domain (github.com) or a bare name (github).");
  return text(await findSession(call.daemon, site));
});

navigationHooks.push(async (call, tab) => {
  const hint = await crossProfileHint(call.daemon, tab.profile.name, tab.url());
  if (!hint) return null;
  const key = `${tab.profile.name}|${hint.domain}`;
  if (call.session.hinted.has(key)) return null;
  call.session.hinted.add(key);
  return hint.line;
});

function when(expires: number): string {
  if (expires === -1 || expires === undefined) return "session";
  const left = expires - Date.now() / 1000;
  if (left <= 0) return "expired";
  if (left < 3600) return `${Math.round(left / 60)} min`;
  if (left < 2 * 86400) return `${Math.round(left / 3600)} h`;
  return `${Math.round(left / 86400)} d`;
}

tool("cookies", (call, args) =>
  withTab(call, args.tabId, async (tab) => {
    const context = tab.profile.context;
    const action = String(args.action || "list");
    if (action === "list") {
      const pageUrl = /^https?:/.test(tab.url()) ? tab.url() : undefined;
      const scope = args.url || (args.domain ? undefined : pageUrl);
      let list = await context.cookies(scope ? [scope] : undefined);
      if (args.domain) {
        const want = String(args.domain).replace(/^\./, "").toLowerCase();
        list = list.filter((c) => {
          const have = c.domain.replace(/^\./, "").toLowerCase();
          return have === want || have.endsWith("." + want);
        });
      }
      if (args.name) list = list.filter((c) => c.name === args.name);
      const where = args.domain ? `domain ${args.domain}` : scope ? maskUrl(scope) : "all sites";
      if (!list.length) return text(`No cookies for ${where} in profile "${tab.profile.name}".`);
      const lines = list.slice(0, 300).map((c) => {
        const flags = [c.httpOnly ? "HttpOnly" : "", c.secure ? "Secure" : "", c.sameSite && c.sameSite !== "None" ? `SameSite=${c.sameSite}` : ""].filter(Boolean).join(" ");
        return `${c.domain}${c.path}  ${c.name}=${args.reveal_values ? c.value : maskedValue(c.value)}  expires: ${when(c.expires)}${flags ? "  " + flags : ""}`;
      });
      return text(untrusted(`${list.length} cookie(s) for ${where} in profile "${tab.profile.name}"`, lines.join("\n")) + (list.length > 300 ? `\n${list.length - 300} more not shown; filter with domain / name.` : ""));
    }
    if (action === "set") {
      if (!args.name || args.value === undefined) throw new ToolError("cookies set needs name and value.");
      const cookie: any = { name: String(args.name), value: String(args.value) };
      if (args.domain) {
        cookie.domain = String(args.domain);
        cookie.path = args.path || "/";
      } else {
        const url = args.url || tab.url();
        if (!/^https?:/.test(url)) throw new ToolError("cookies set needs url or domain (the tab is not on a web page).");
        cookie.url = url;
      }
      if (args.expires_in_s) cookie.expires = Math.floor(Date.now() / 1000) + Number(args.expires_in_s);
      if (args.http_only !== undefined) cookie.httpOnly = !!args.http_only;
      if (args.secure !== undefined) cookie.secure = !!args.secure;
      if (args.same_site) cookie.sameSite = args.same_site;
      await context.addCookies([cookie]);
      return text(`Set cookie ${cookie.name} for ${cookie.domain || cookie.url} in profile "${tab.profile.name}"${cookie.expires ? "" : " (a session cookie)"}.`);
    }
    if (action === "delete") {
      if (!args.name && !args.domain) throw new ToolError("cookies delete needs name and / or domain: deleting every cookie of a profile is not offered.");
      const before = (await context.cookies()).length;
      const filter: any = {};
      if (args.name) filter.name = String(args.name);
      if (args.domain) filter.domain = new RegExp(`(^|\\.)${String(args.domain).replace(/^\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      else if (/^https?:/.test(tab.url())) filter.domain = new RegExp(`(^|\\.)${new URL(tab.url()).hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      await context.clearCookies(filter);
      const after = (await context.cookies()).length;
      return text(`Deleted ${before - after} cookie(s) in profile "${tab.profile.name}".`);
    }
    throw new ToolError(`Unknown cookies action "${action}" (list, set, delete).`);
  }));

tool("web_storage", (call, args) =>
  onTab(call, args.tabId, async (tab) => {
    const kind = args.kind === "session" ? "sessionStorage" : "localStorage";
    const action = String(args.action || "get");
    const origin = (() => {
      try {
        return new URL(tab.url()).origin;
      } catch {
        return tab.url();
      }
    })();
    const run = async (body: string): Promise<any> => {
      const raw = await evalWithin<string>(tab.page, `(function () { try { var s = window.${kind}; ${body} } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); } })()`, 5000);
      if (raw === undefined) throw new ToolError("The page did not answer within 5 s.");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.error) throw new ToolError(`${kind} is not available on ${origin}: ${parsed.error}`);
      return parsed;
    };
    const shown = (key: string, value: string) => {
      if (args.reveal_values) return value;
      if (isSecretName(key)) return maskedValue(value);
      // A value is often a JSON blob with the token inside ({"accessToken": ...}).
      const masked = maskBody(value);
      return masked.length > 2000 ? masked.slice(0, 2000) + `… (${value.length} chars)` : masked;
    };
    if (action === "get") {
      if (args.key !== undefined) {
        const r = await run(`return JSON.stringify({ value: s.getItem(${JSON.stringify(String(args.key))}) });`);
        if (r.value === null) return text(`${kind} of ${origin} has no key ${JSON.stringify(args.key)}.`);
        return text(untrusted(`${kind}[${JSON.stringify(args.key)}] of ${origin}`, shown(String(args.key), r.value)));
      }
      const r = await run(`var out = []; for (var i = 0; i < s.length; i++) { var k = s.key(i); out.push([k, s.getItem(k)]); } return JSON.stringify({ items: out });`);
      if (!r.items.length) return text(`${kind} of ${origin} is empty.`);
      const lines = (r.items as [string, string][]).map(([k, v]) => {
        const val = shown(k, v);
        return `${k} = ${val.length > 200 ? val.slice(0, 200) + `… (${v.length} chars)` : val}`;
      });
      return text(untrusted(`${kind} of ${origin}: ${r.items.length} key(s)`, lines.join("\n")));
    }
    if (action === "set") {
      if (args.key === undefined || args.value === undefined) throw new ToolError("web_storage set needs key and value.");
      await run(`s.setItem(${JSON.stringify(String(args.key))}, ${JSON.stringify(String(args.value))}); return "{}";`);
      return text(`Set ${kind}[${JSON.stringify(args.key)}] on ${origin}.`);
    }
    if (action === "remove") {
      if (args.key === undefined) throw new ToolError("web_storage remove needs key.");
      await run(`s.removeItem(${JSON.stringify(String(args.key))}); return "{}";`);
      return text(`Removed ${kind}[${JSON.stringify(args.key)}] on ${origin}.`);
    }
    if (action === "clear") {
      const r = await run(`var n = s.length; s.clear(); return JSON.stringify({ n: n });`);
      return text(`Cleared ${kind} of ${origin} (${r.n} key(s)).`);
    }
    throw new ToolError(`Unknown web_storage action "${action}" (get, set, remove, clear).`);
  }));
