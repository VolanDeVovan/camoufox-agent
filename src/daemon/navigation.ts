// Navigation that does not rely on Playwright's lifecycle events.
// Adapted from the reference (reference/mcp-camoufox/src/helpers.ts: gotoReady, waitReady).
import type { Page } from "playwright-core";
import { maskUrl } from "./redact.js";
import type { Tab } from "./tabs.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What a person means by a bare address: example.com -> https://, localhost and IPs -> http://. */
export function normalizeUrl(raw: string): string {
  const url = String(raw ?? "").trim();
  if (!url) return url;
  const host = url.match(/^([^/?#]+)/)?.[1] || "";
  const local = /^(localhost|127(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3})(:\d+)?$/i.test(host);
  if (local) return "http://" + url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(host)) return "https://" + url;
  return url;
}

export async function evalWithin<T>(page: Page, expression: string, ms: number): Promise<T | undefined> {
  try {
    return (await Promise.race([
      page.evaluate(expression),
      new Promise((_, reject) => setTimeout(() => reject(new Error("page did not answer")), ms)),
    ])) as T;
  } catch {
    return undefined;
  }
}

/**
 * Wait until the document itself says it is ready. Camoufox builds have stopped
 * delivering `load` / `domcontentloaded` after a few pages; `commit` plus this poll
 * does not depend on them.
 */
export async function waitReady(page: Page, timeout: number, want: "interactive" | "complete" = "interactive"): Promise<boolean> {
  const deadline = Date.now() + timeout;
  const ok = want === "complete" ? ["complete"] : ["interactive", "complete"];
  for (let polls = 0; ; polls++) {
    const state = await evalWithin<string>(page, "document.readyState", 2000);
    if (state && ok.includes(state)) return true;
    if (Date.now() >= deadline || page.isClosed()) return false;
    await sleep(polls < 10 ? 10 : 50);
  }
}

/** Let a just-loaded page go quiet (no requests in flight for a moment), up to capMs. */
export async function settle(tab: Tab, capMs: number, quietMs = 150): Promise<void> {
  const deadline = Date.now() + capMs;
  let quietSince = tab.inflight === 0 ? Date.now() : 0;
  while (Date.now() < deadline) {
    if (tab.inflight === 0) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) return;
    } else quietSince = 0;
    await sleep(25);
  }
}

function sameTarget(landed: string, requested: string): boolean {
  try {
    const a = new URL(landed);
    const b = new URL(requested);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return landed === requested;
  }
}

export async function goto(tab: Tab, rawUrl: string, timeout = 30000): Promise<void> {
  const page = tab.page;
  const url = normalizeUrl(rawUrl);
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: "commit", timeout });
  } catch (err: any) {
    // Camoufox sometimes never settles the commit although the navigation went
    // through. Only a timeout can be that; on one, ask the document where it is.
    // A second goto while one is in flight breaks both, so none is issued here.
    const msg = String(err?.message || err);
    if (!/Timeout\s+\d+ms exceeded/i.test(msg)) throw new Error(cleanNavError(msg, url));
    const raw = await evalWithin<string>(
      page,
      `JSON.stringify({ href: location.href, doc: document.documentURI, state: document.readyState })`,
      3000,
    );
    let arrived = false;
    try {
      const g = JSON.parse(raw || "{}");
      arrived = sameTarget(g.href, url) && !/^about:(neterror|certerror|blocked|httpsonlyerror)/.test(String(g.doc || "")) && g.state !== "loading";
    } catch {}
    if (!arrived) throw new Error(`Navigation to ${maskUrl(url)} did not finish within ${Math.round(timeout / 1000)} s.`);
  }
  await waitReady(page, Math.max(3000, timeout - (Date.now() - started)));
  await settle(tab, 1500);
}

function cleanNavError(msg: string, url: string): string {
  const first = msg.split("\n")[0].replace(/^page\.goto:\s*/, "");
  const code = first.match(/NS_ERROR_[A-Z_]+/)?.[0];
  const known: Record<string, string> = {
    NS_ERROR_UNKNOWN_HOST: "the host name could not be resolved",
    NS_ERROR_CONNECTION_REFUSED: "the connection was refused",
    NS_ERROR_NET_TIMEOUT: "the connection timed out",
    NS_ERROR_PROXY_CONNECTION_REFUSED: "the proxy refused the connection",
    NS_ERROR_UNKNOWN_PROTOCOL: "unknown protocol",
    NS_ERROR_MALFORMED_URI: "malformed URL",
  };
  return `Could not open ${maskUrl(url)}: ${code ? known[code] || code : first.split(url).join(maskUrl(url))}.`;
}

export async function history(tab: Tab, direction: "back" | "forward", timeout = 15000): Promise<boolean> {
  const page = tab.page;
  const seq = tab.navSeq;
  const before = page.url();
  const opts = { waitUntil: "commit" as const, timeout };
  const res = direction === "back" ? await page.goBack(opts) : await page.goForward(opts);
  const changed = () => res !== null || tab.navSeq !== seq || page.url() !== before;
  if (!changed()) await sleep(150);
  if (!changed()) return false;
  await waitReady(page, timeout);
  await settle(tab, 1000);
  return true;
}

export async function reload(tab: Tab, timeout = 30000): Promise<void> {
  await tab.page.reload({ waitUntil: "commit", timeout });
  await waitReady(tab.page, timeout);
  await settle(tab, 1500);
}
