// Actions report what happened (06-page-interaction.md): after a click, a key or a
// form input the daemon watches the page for about a second and says what it did.
// Refusals instead of guesses for disabled, hidden and covered elements.
import type { Locator } from "playwright-core";
import { evalWithin, settle, waitReady } from "./navigation.js";
import { maskUrl } from "./redact.js";
import { IS_SECRET_FN, callOn, refLocator } from "./snapshot.js";
import { ToolError } from "./state.js";
import type { Tab } from "./tabs.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Signature {
  url: string;
  hash: string;
  n: number;
  textLen: number;
  textHash: number;
  form: number;
  focus: string;
  sx: number;
  sy: number;
  title: string;
}

const SIGNATURE_JS = `(function () {
  function h(s) { var x = 5381; for (var i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; return x; }
  var b = document.body, t = b ? (b.innerText || "") : "";
  var form = "", fs = document.querySelectorAll("input, textarea, select");
  for (var i = 0; i < fs.length && i < 2000; i++) { var f = fs[i]; form += (f.type === "checkbox" || f.type === "radio" ? (f.checked ? "1" : "0") : String(f.value || "").length + ":" + h(String(f.value || ""))) + ","; }
  var a = document.activeElement, focus = "";
  if (a && a !== b && a !== document.documentElement) focus = a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") + (a.getAttribute("name") ? "[name=" + a.getAttribute("name") + "]" : "");
  var se = document.scrollingElement || document.documentElement;
  return JSON.stringify({ url: location.href.split("#")[0], hash: location.hash, n: document.getElementsByTagName("*").length, textLen: t.length, textHash: h(t),
    form: h(form), focus: focus, sx: Math.round(se ? se.scrollLeft : 0), sy: Math.round(se ? se.scrollTop : 0), title: document.title });
})()`;

async function signature(tab: Tab): Promise<Signature | null> {
  const raw = await evalWithin<string>(tab.page, SIGNATURE_JS, 1500);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function describeChange(a: Signature, b: Signature): string[] {
  const out: string[] = [];
  if (a.hash !== b.hash) out.push(`URL hash ${a.hash || "(none)"} -> ${b.hash || "(none)"}`);
  if (a.n !== b.n) out.push(`DOM size ${a.n} -> ${b.n} elements`);
  if (a.textHash !== b.textHash) out.push(a.textLen === b.textLen ? "text changed" : `text ${a.textLen} -> ${b.textLen} chars`);
  if (a.form !== b.form) out.push("a field value changed");
  if (a.sx !== b.sx || a.sy !== b.sy) out.push(`scrolled to x=${b.sx}, y=${b.sy}`);
  if (a.title !== b.title) out.push(`title is now ${JSON.stringify(b.title)}`);
  return out;
}

// Focus moving to what was clicked is not the page doing something: it never ends the
// watch early, and is only mentioned.
const sameSig = (a: Signature, b: Signature) => describeChange(a, b).length === 0;
const noHash = (u: string) => u.split("#")[0];

/**
 * Run an action and watch what the page does for about a second. Returns the lines
 * for the reply: navigated / page changed / opened tab / dialog / download / nothing.
 */
export async function observe(tab: Tab, act: () => Promise<void>, opts: { waitMs?: number; onNavigated?: () => Promise<string[]> } = {}): Promise<string[]> {
  const waitMs = opts.waitMs ?? 1000;
  const page = tab.page;
  const mark = tab.eventSeq;
  const nav0 = tab.navSeq;
  const url0 = noHash(page.url());
  const before = await signature(tab);
  tab.profile.lastAction = { page, at: Date.now() };
  await act();
  tab.profile.lastAction = { page, at: Date.now() };

  const lines: string[] = [];
  let latest: Signature | null = null;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (page.isClosed()) {
      lines.push("the tab closed");
      break;
    }
    const navSeen = tab.navSeq;
    const now = await signature(tab); // null while a navigation is in flight
    if (navSeen !== nav0) {
      // A change of the hash alone is the same document: report it as a page change.
      const hashOnly = !!now && !!before && now.url === before.url && noHash(page.url()) === url0 && now.hash !== before.hash;
      if (!hashOnly) {
        await waitReady(page, 10000);
        await settle(tab, 1500);
        const title = await tab.title();
        lines.push(`navigated to ${maskUrl(page.url())}${title ? ` (${title})` : ""}`);
        if (opts.onNavigated) lines.push(...(await opts.onNavigated()));
        break;
      }
    }
    if (before && now && !sameSig(before, now)) {
      // Let the change finish: report the state once two looks agree.
      let last = now;
      for (const until = Date.now() + 600; Date.now() < until && tab.navSeq === navSeen; ) {
        await sleep(100);
        const again = await signature(tab);
        if (!again || sameSig(last, again)) break;
        last = again;
      }
      if (tab.navSeq !== navSeen) continue; // it turned into a navigation
      const focus = last.focus !== before.focus && last.focus ? `; focus is on ${last.focus}` : "";
      lines.push(`page changed (${describeChange(before, last).join("; ")}${focus})`);
      break;
    }
    if (now) latest = now;
    if (Date.now() >= deadline) break;
    await sleep(50);
  }

  // Tabs, dialogs and downloads the action triggered.
  const events = tab.events.filter((e) => e.seq > mark);
  for (const e of events) {
    if (e.done) await Promise.race([e.done, sleep(8000)]);
    lines.unshift(e.text);
  }
  if (!lines.length) {
    const focus = before && latest && latest.focus !== before.focus ? (latest.focus ? ` (focus moved to ${latest.focus})` : " (focus left the field)") : "";
    lines.push(`nothing happened within ${Math.round(waitMs / 100) / 10} s${focus}`);
  }
  return lines;
}

export interface Target {
  locator: Locator;
  x: number;
  y: number;
  label: string;
  secret: boolean;
}

const INSPECT_FN = `function (el) {
  function desc(e) {
    if (!e || !e.tagName) return "something";
    var t = (e.innerText || e.getAttribute("aria-label") || e.getAttribute("alt") || "").replace(/\\s+/g, " ").trim().slice(0, 40);
    return "<" + e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\\s+/).slice(0, 2).join(".") : "") + ">" + (t ? ' "' + t + '"' : "");
  }
  function deepHit(x, y) {
    var hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) { var inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
    return hit;
  }
  function within(target, hit) {
    for (var n = hit; n; n = n.parentNode || n.host) if (n === target) return true;
    return false;
  }
  var r = el.getBoundingClientRect();
  var shown = r.width > 0 && r.height > 0;
  try { if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) shown = false; } catch (e) {}
  var disabled = !!el.disabled || el.getAttribute("aria-disabled") === "true" || !!(el.closest && el.closest("fieldset[disabled]") && /^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(el.tagName));
  var x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1), y = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
  var inView = r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  var covered = null;
  if (shown && inView) {
    var hit = deepHit(x, y);
    var ok = !hit || within(el, hit) || within(hit, el)
      || (hit.tagName === "LABEL" && hit.control === el) || (el.tagName === "LABEL" && el.control && within(el.control, hit))
      || (hit.closest && hit.closest("label") && hit.closest("label").control === el);
    if (!ok) covered = desc(hit);
  }
  return { shown: shown, inView: inView, disabled: disabled, covered: covered, desc: desc(el), fx: x - r.left, fy: y - r.top, w: r.width, h: r.height };
}`;

/**
 * Resolve a ref to a point to act on, refusing what a person could not click:
 * disabled or hidden -> refused, nothing fired; covered -> names the covering element.
 */
export async function targetOf(tab: Tab, ref: string, verb = "clicked"): Promise<Target> {
  const { locator } = await refLocator(tab, ref);
  await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  let info: any;
  try {
    info = await callOn(locator, INSPECT_FN);
  } catch (e: any) {
    throw new ToolError(`Ref ${ref} could not be inspected (${String(e?.message || e).split("\n")[0]}). Call read_page again.`);
  }
  if (info.disabled) throw new ToolError(`Not ${verb}: ${info.desc} (${ref}) is disabled. Nothing was fired.`);
  if (!info.shown) throw new ToolError(`Not ${verb}: ${info.desc} (${ref}) is hidden (no size, or display/visibility hides it). Nothing was fired.`);
  if (!info.inView) throw new ToolError(`Not ${verb}: ${info.desc} (${ref}) could not be scrolled into view. Nothing was fired.`);
  if (info.covered) throw new ToolError(`Not ${verb}: ${info.desc} (${ref}) is covered by ${info.covered}. Nothing was fired. Deal with the covering element first (close it, or scroll).`);
  const box = await locator.boundingBox({ timeout: 3000 }).catch(() => null);
  if (!box) throw new ToolError(`Not ${verb}: ${info.desc} (${ref}) has no box on screen. Nothing was fired.`);
  const secret = await callOn<boolean>(locator, IS_SECRET_FN).catch(() => false);
  return { locator, x: box.x + info.fx, y: box.y + info.fy, label: info.desc, secret };
}

/** A pointer move to y in [0, 1) used to wedge the tab; all pointer positions keep y >= 1 (06). */
export const safeY = (y: number) => (y < 1 ? 1 : y);

const KEY_ALIASES: Record<string, string> = {
  ctrl: "Control", control: "Control", cmd: "Meta", command: "Meta", meta: "Meta", super: "Meta", win: "Meta", windows: "Meta",
  alt: "Alt", option: "Alt", opt: "Alt", shift: "Shift",
  enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", space: "Space", spacebar: "Space",
  backspace: "Backspace", delete: "Delete", del: "Delete", insert: "Insert", ins: "Insert", home: "Home", end: "End",
  pageup: "PageUp", pgup: "PageUp", page_up: "PageUp", pagedown: "PageDown", pgdn: "PageDown", page_down: "PageDown",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  plus: "+", minus: "-", capslock: "CapsLock", contextmenu: "ContextMenu", menu: "ContextMenu", printscreen: "PrintScreen",
};

/** "ctrl+shift+k" -> "Control+Shift+K" in Playwright's key syntax. */
export function normalizeKey(combo: string): string {
  const parts = combo === "+" ? ["+"] : combo.split("+").map((p) => p.trim()).filter((p, i, all) => p || i === all.length - 1);
  return parts
    .map((part, i) => {
      if (part === "") return "+";
      const low = part.toLowerCase();
      if (KEY_ALIASES[low]) return KEY_ALIASES[low];
      if (/^f\d{1,2}$/i.test(part)) return part.toUpperCase();
      // With a modifier, a letter is the key itself ("ctrl+a").
      if (part.length === 1) return i > 0 || parts.length > 1 ? (/[a-z]/i.test(part) ? part.toLowerCase() : part) : part;
      return part[0].toUpperCase() + part.slice(1);
    })
    .join("+");
}

export function modifiersOf(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split("+")
    .map((m) => KEY_ALIASES[m.trim().toLowerCase()] || "")
    .filter((m) => ["Control", "Meta", "Alt", "Shift"].includes(m));
}

/** Randomized per-key delay: Gaussian around ~80 ms (06, Human-looking input). The one piece of typing rhythm that is ours. */
export function keyDelay(): number {
  const u = 1 - Math.random(), v = Math.random();
  const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.round(Math.min(260, Math.max(25, 80 + gauss * 30)));
}

export async function typePerKey(tab: Tab, textToType: string): Promise<void> {
  for (const ch of textToType) {
    if (ch === "\n") await tab.page.keyboard.press("Enter");
    else if (ch === "\t") await tab.page.keyboard.press("Tab");
    else await tab.page.keyboard.type(ch);
    await sleep(keyDelay());
  }
}
