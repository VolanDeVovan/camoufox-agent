// HTML -> readable markdown without a DOM, for fetch_markdown.
// Adapted from the reference (reference/mcp-camoufox/src/tools/http.ts: htmlToMarkdown).

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
    rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", middot: "·", bull: "•", copy: "©", reg: "®",
    trade: "™", laquo: "«", raquo: "»", deg: "°", euro: "€", pound: "£",
  };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return named[e.toLowerCase()] ?? m;
  });
}

function sliceMain(html: string): string {
  const m = html.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (m && m[2].length > 400) return m[2];
  const b = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return b ? b[1] : html;
}

const strip = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export function htmlToMarkdown(html: string, baseUrl = ""): string {
  if (!html) return "";
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? decodeEntities(strip(tm[1])) : "";
  let s = sliceMain(html);
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, t) => `\n\n\`\`\`\n${decodeEntities(t.replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n\n`);
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, l, t) => `\n\n${"#".repeat(Number(l))} ${strip(t)}\n\n`);
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs, t) => {
    const label = strip(t);
    if (!label) return " ";
    const h = String(attrs).match(/href=["']([^"']+)["']/i);
    if (!h) return label;
    let abs = h[1];
    try {
      abs = new URL(decodeEntities(h[1]), baseUrl || undefined).toString();
    } catch {}
    return abs.startsWith("http") ? `[${label}](${abs})` : label;
  });
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `\n- ${strip(t)}`);
  s = s.replace(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi, (_m, a) => `![${a}] `);
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, t) => `**${strip(t)}**`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, t) => `\`${t.replace(/<[^>]+>/g, "").trim()}\``);
  s = s.replace(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi, (_m, t) => ` ${strip(t)} |`);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|tr|ul|ol|table|blockquote|h[1-6])>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  const lines = s.split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim());
  let out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (title && !out.startsWith("# ")) out = `# ${title}\n\n${out}`;
  return out;
}
