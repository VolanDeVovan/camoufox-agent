// The ref engine: read_page / find list what an agent can act on, each with a ref
//. Refs live in a registry inside the isolated world and are
// resolved by a custom selector engine, so nothing is written into the DOM and the
// page's scripts cannot see it. The idea is the reference's (helpers.ts: REF_ENGINE_JS,
// snapshotPage); the walker is ours.
import type { Frame, Locator } from "playwright-core";
import { evalWithin } from "./navigation.js";
import { maskUrl } from "./redact.js";
import { ToolError } from "./state.js";
import type { Tab } from "./tabs.js";

const REGISTRY_JS = `(function () {
  var k = Symbol.for("camoufox-agent.refs");
  return globalThis[k] || (globalThis[k] = { byRef: new Map(), byEl: new WeakMap() });
})()`;

const ENGINE_JS = `(() => {
  function get(ref) {
    var reg = globalThis[Symbol.for("camoufox-agent.refs")];
    var w = reg && reg.byRef.get(ref);
    var el = w && w.deref();
    return el && el.isConnected ? el : null;
  }
  return {
    query: function (root, ref) { return get(ref); },
    queryAll: function (root, ref) { var el = get(ref); return el ? [el] : []; },
  };
})()`;

let engine: Promise<void> | null = null;
/** Registers the `cfaref=` selector engine. Must happen before a browser context is created. */
export function refEngineReady(): Promise<void> {
  if (!engine) {
    engine = import("playwright-core")
      .then(({ selectors }) => selectors.register("cfaref", ENGINE_JS))
      .catch((e: any) => {
        if (/already registered|has been already/i.test(String(e?.message || e))) return;
        engine = null;
        throw e;
      });
  }
  return engine;
}

export interface SnapItem {
  kind: "el" | "text" | "frame";
  ref?: string;
  role: string;
  name: string;
  level?: number;
  value?: string;
  secret?: boolean;
  checked?: boolean | "mixed";
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  required?: boolean;
  href?: string;
  inputType?: string;
  placeholder?: string;
  /** For kind "frame": a ref of the iframe element itself, to find its frame by. */
  frameRef?: string;
  options?: string[];
}

interface WalkResult {
  items: SnapItem[];
  next: number;
  frames: number;
  capped: boolean;
  rootMissing?: boolean;
}

/** The secret-field test every tool shares. `function (el) -> boolean` */
export const IS_SECRET_FN = `function (el) {
  if (!el || !el.getAttribute) return false;
  var type = (el.getAttribute("type") || "").toLowerCase();
  if (type === "password") return true;
  var ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (/password|one-time-code|cc-number|cc-csc/.test(ac)) return true;
  var hint = ((el.getAttribute("name") || "") + " " + (el.id || "")).toLowerCase();
  return /passw|secret|token|otp|cvv|cvc|card.?number|api.?key|ssn/.test(hint);
}`;

/**
 * The walker, run in the page's isolated world. One pass in document order through
 * the DOM, open shadow roots included.
 *   mode "interactive": interactive elements and headings
 *   mode "all":         plus visible text
 *   mode "find":        everything that matches `query` (and `role`), each with a ref
 */
function walkerJs(opts: {
  prefix: string;
  start: number;
  mode: "interactive" | "all" | "find";
  rootRef?: string;
  query?: string;
  role?: string;
  reveal: boolean;
  cap: number;
}): string {
  return `(function (opts) {
  var reg = ${REGISTRY_JS};
  var isSecret = ${IS_SECRET_FN};
  var win = window, doc = document;
  var next = opts.start, items = [], frames = 0, capped = false;
  var q = (opts.query || "").toLowerCase(), wantRole = (opts.role || "").toLowerCase();

  function clean(t) { return String(t == null ? "" : t).replace(/\\s+/g, " ").trim(); }
  function cut(t, n) { t = clean(t); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
  function refOf(el) {
    var r = reg.byEl.get(el);
    if (r && reg.byRef.get(r) && reg.byRef.get(r).deref() === el) return r;
    r = opts.prefix + "e" + (next++);
    reg.byEl.set(el, r);
    reg.byRef.set(r, new WeakRef(el));
    return r;
  }
  function visible(el) {
    try { if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: false })) return false; } catch (e) {}
    var r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }
  var ROLES = { button: 1, link: 1, textbox: 1, searchbox: 1, checkbox: 1, radio: 1, combobox: 1, listbox: 1, option: 1, tab: 1, menuitem: 1,
    menuitemcheckbox: 1, menuitemradio: 1, switch: 1, slider: 1, spinbutton: 1, treeitem: 1, gridcell: 0 };
  function roleOf(el) {
    var tag = el.tagName, role = (el.getAttribute("role") || "").toLowerCase();
    if (role && ROLES[role]) return role;
    if (tag === "A") return el.hasAttribute("href") ? "link" : "";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "INPUT") {
      var t = (el.getAttribute("type") || "").toLowerCase();
      if (t === "hidden") return "";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      if (t === "file") return "file";
      if (t === "range") return "slider";
      return t === "search" ? "searchbox" : "textbox";
    }
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return "combobox";
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "textbox";
    if (tag === "LABEL") {
      // A label standing in for a control no click can reach (hidden or 1px) is the thing to click.
      var c = el.control;
      if (c && !visible(c)) return c.type === "checkbox" ? "checkbox" : c.type === "radio" ? "radio" : "button";
      return "";
    }
    if (el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1" && tag !== "BODY" && tag !== "IFRAME")) return "clickable";
    return "";
  }
  function labelFor(el) {
    var parts = [];
    var by = el.getAttribute("aria-labelledby");
    var home = el.getRootNode();
    if (by) by.split(/\\s+/).forEach(function (id) { var t = id && home.getElementById && home.getElementById(id); if (t) parts.push(clean(t.innerText || t.textContent)); });
    if (parts.length) return parts.join(" ");
    var ls = el.labels;
    for (var i = 0; ls && i < ls.length; i++) {
      var label = ls[i], out = "";
      if (!label.contains(el)) out = clean(label.innerText || label.textContent);
      else { var w = doc.createTreeWalker(label, 4); for (var n = w.nextNode(); n; n = w.nextNode()) if (!el.contains(n)) out += " " + n.nodeValue; out = clean(out); }
      if (out) parts.push(out);
    }
    return parts.join(" ");
  }
  function nameOf(el, role) {
    var aria = el.getAttribute("aria-label");
    if (aria && clean(aria)) return clean(aria);
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      var l = labelFor(el);
      if (l) return l;
      var t = (el.getAttribute("type") || "").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset") return clean(el.value) || t;
      return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || "");
    }
    var by = labelFor(el);
    if (by) return by;
    if (role === "textbox") return clean(el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || el.getAttribute("title") || "");
    var text = clean(el.innerText || el.textContent);
    if (text) return text;
    var img = el.querySelector && el.querySelector("img[alt], svg[aria-label], [title]");
    if (img) return clean(img.getAttribute("alt") || img.getAttribute("aria-label") || img.getAttribute("title"));
    return clean(el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || "");
  }
  function describe(el, role) {
    var item = { kind: "el", role: role, name: cut(nameOf(el, role), 100) };
    var tag = el.tagName, secret = false;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || role === "textbox") {
      secret = isSecret(el);
      if (secret) item.secret = true;
    }
    if (role === "textbox" || role === "searchbox" || role === "slider" || role === "spinbutton") {
      var v = tag === "INPUT" || tag === "TEXTAREA" ? el.value : (el.isContentEditable ? el.innerText : "");
      if (v) item.value = secret && !opts.reveal ? "••• (" + String(v).length + " chars)" : cut(v, 100);
      var it = (el.getAttribute("type") || "").toLowerCase();
      if (it && it !== "text" && it !== "search") item.inputType = it;
      var ph = el.getAttribute("placeholder");
      if (ph && clean(ph) !== item.name) item.placeholder = cut(ph, 60);
    } else if (role === "combobox" && tag === "SELECT") {
      var o = el.selectedOptions && el.selectedOptions[0];
      if (o) item.value = secret && !opts.reveal ? "••• (masked)" : cut(o.text, 80);
      var os = [];
      for (var i = 0; i < el.options.length && i < 30; i++) os.push(cut(el.options[i].text, 40));
      if (!secret || opts.reveal) { item.options = os; if (el.options.length > 30) item.options.push("… " + (el.options.length - 30) + " more"); }
    } else if (role === "checkbox" || role === "radio" || role === "switch" || role === "menuitemcheckbox" || role === "menuitemradio") {
      var c = tag === "LABEL" ? el.control : el;
      var ac = el.getAttribute("aria-checked");
      item.checked = ac === "mixed" ? "mixed" : ac ? ac === "true" : !!(c && c.checked);
    } else if (role === "link") {
      var href = el.getAttribute("href") || "";
      if (href && !/^javascript:/i.test(href)) item.href = cut(el.href || href, 200);
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
    var ex = el.getAttribute("aria-expanded");
    if (ex) item.expanded = ex === "true";
    if (el.getAttribute("aria-selected") === "true") item.selected = true;
    if (el.required || el.getAttribute("aria-required") === "true") item.required = true;
    return item;
  }
  function matches(item) {
    if (wantRole && item.role !== wantRole) return false;
    if (!q) return true;
    var hay = [item.name, item.value && !item.secret ? item.value : "", item.placeholder, item.href].join(" ").toLowerCase();
    return hay.indexOf(q) >= 0;
  }
  function push(item, el) {
    if (items.length >= opts.cap) { capped = true; return; }
    if (opts.mode === "find") { if (!matches(item)) return; item.ref = refOf(el); }
    else if (item.kind === "el" && item.role !== "heading") item.ref = refOf(el);
    items.push(item);
  }
  function directText(el) {
    var out = "";
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) out += n.nodeValue + " ";
    return clean(out);
  }
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, OPTION: 1, OPTGROUP: 1 };
  function walk(el, inside) {
    if (capped) return;
    var tag = el.tagName;
    if (SKIP[tag]) return;
    var here = inside;
    if (tag === "IFRAME" || tag === "FRAME") {
      if (visible(el)) {
        frames++;
        items.push({ kind: "frame", role: "iframe", name: opts.mode !== "find" ? cut(el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("src") || "", 80) : "", frameRef: refOf(el) });
      } else frames++;
      return;
    }
    // inside: "" nothing, "h" a heading (its links are still listed), "i" an interactive element.
    var hm = /^H([1-6])$/.exec(tag), role = "";
    if (!inside && (hm || el.getAttribute("role") === "heading")) {
      if (visible(el)) {
        var h = { kind: "el", role: "heading", name: cut(el.innerText || el.textContent, 120), level: hm ? Number(hm[1]) : Number(el.getAttribute("aria-level")) || 2 };
        if (h.name) push(h, el);
      }
      here = "h";
    } else if ((role = roleOf(el))) {
      if (visible(el)) { push(describe(el, role), el); here = role === "clickable" ? inside : "i"; }
      else if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") here = "i";
    } else if (tag === "IMG" && opts.mode !== "interactive" && !inside) {
      var alt = clean(el.getAttribute("alt"));
      if (alt && visible(el)) push({ kind: "el", role: "image", name: cut(alt, 100) }, el);
    }
    if (here === "i") return;
    // A label's text is already the name of its control.
    if (!here && tag === "LABEL" && el.control) here = "h";
    if (!here && opts.mode !== "interactive" && tag !== "IMG") {
      var t = directText(el);
      if (t && t.length > 1 && visible(el)) push({ kind: "text", role: "text", name: cut(t, 300) }, el);
    }
    if (el.shadowRoot) for (var s = el.shadowRoot.firstElementChild; s; s = s.nextElementSibling) walk(s, here);
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) walk(c, here);
  }
  var root = doc.documentElement;
  if (opts.rootRef) {
    var w = reg.byRef.get(opts.rootRef), r = w && w.deref();
    if (!r || !r.isConnected) return { items: [], next: next, frames: 0, capped: false, rootMissing: true };
    root = r;
  }
  if (root) walk(root, "");
  return { items: items, next: next, frames: frames, capped: capped };
})(${JSON.stringify(opts)})`;
}

const MAX_ITEMS = 4000;
const MAX_FRAMES = 12;

export interface Snapshot {
  lines: string[];
  note: string[];
}

function formatItem(item: SnapItem, indent: string, reveal: boolean): string {
  if (item.kind === "text") return `${indent}text ${JSON.stringify(item.name)}${item.ref ? " " + item.ref : ""}`;
  if (item.role === "heading") return `${indent}heading ${JSON.stringify(item.name)} [h${item.level}]${item.ref ? " " + item.ref : ""}`;
  let line = `${indent}${item.role} ${JSON.stringify(item.name)}`;
  if (item.ref) line += ` ${item.ref}`;
  const flags: string[] = [];
  if (item.secret) flags.push("secret");
  if (item.inputType && item.inputType !== "password") flags.push(`type=${item.inputType}`);
  if (item.value !== undefined) flags.push(`value=${JSON.stringify(item.value)}`);
  if (item.placeholder) flags.push(`placeholder=${JSON.stringify(item.placeholder)}`);
  if (item.checked !== undefined) flags.push(item.checked === "mixed" ? "mixed" : item.checked ? "checked" : "unchecked");
  if (item.selected) flags.push("selected");
  if (item.expanded !== undefined) flags.push(item.expanded ? "expanded" : "collapsed");
  if (item.required) flags.push("required");
  if (item.disabled) flags.push("disabled");
  if (item.options) flags.push(`options: ${item.options.join(" | ")}`);
  if (flags.length) line += ` (${flags.join(", ")})`;
  if (item.href) line += ` -> ${reveal ? item.href : maskUrl(item.href)}`;
  return line;
}

function prefixOf(tab: Tab, frame: Frame): string {
  let prefix = tab.framePrefixes.get(frame);
  if (!prefix) {
    prefix = `f${++tab.frameSeq}`;
    tab.framePrefixes.set(frame, prefix);
    tab.frames.set(prefix, frame);
  }
  return prefix;
}

async function walkFrame(
  tab: Tab,
  frame: Frame,
  prefix: string,
  opts: { mode: "interactive" | "all" | "find"; rootRef?: string; query?: string; role?: string; reveal: boolean },
  indent: string,
  out: Snapshot,
  budget: { frames: number },
): Promise<void> {
  let result: WalkResult | undefined;
  if (prefix && !opts.rootRef) {
    // A frame that is still loading would read as empty: give it a moment.
    for (const deadline = Date.now() + 1500; Date.now() < deadline; ) {
      const state = await frame.evaluate("location.href === 'about:blank' && !document.body?.childElementCount ? 'loading' : document.readyState").catch(() => "loading");
      if (state !== "loading") break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    result = (await Promise.race([
      frame.evaluate(walkerJs({ ...opts, prefix, start: tab.refSeq, cap: MAX_ITEMS })),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000)),
    ])) as WalkResult;
  } catch (e: any) {
    out.note.push(`${prefix ? `frame ${prefix}` : "page"} could not be read (${String(e?.message || e).split("\n")[0]})`);
    return;
  }
  if (result.rootMissing) throw new ToolError(`Ref ${opts.rootRef} is stale or unknown: call read_page again.`);
  tab.refSeq = Math.max(tab.refSeq, result.next);
  if (result.capped) out.note.push(`more than ${MAX_ITEMS} elements${prefix ? ` in frame ${prefix}` : ""}: the rest is not listed; narrow with ref_id or find`);
  for (const item of result.items) {
    if (item.kind !== "frame") {
      out.lines.push(formatItem(item, indent, opts.reveal));
      continue;
    }
    // The frame of exactly this iframe element: positions in two listings would not agree
    // under ref_id, in shadow roots, or inside interactive elements.
    const handle = await frame.locator(`cfaref=${item.frameRef}`).elementHandle({ timeout: 2000 }).catch(() => null);
    const child = handle ? await handle.contentFrame().catch(() => null) : null;
    if (!child || child.isDetached()) continue;
    if (budget.frames >= MAX_FRAMES) {
      if (opts.mode !== "find") out.lines.push(`${indent}iframe ${JSON.stringify(item.name)} (not read: more than ${MAX_FRAMES} frames)`);
      continue;
    }
    budget.frames++;
    const childPrefix = prefixOf(tab, child);
    if (opts.mode !== "find") out.lines.push(`${indent}iframe ${JSON.stringify(item.name)} ${childPrefix}`);
    await walkFrame(tab, child, childPrefix, { ...opts, rootRef: undefined }, opts.mode === "find" ? indent : indent + "  ", out, budget);
  }
}

export async function snapshot(
  tab: Tab,
  opts: { mode: "interactive" | "all" | "find"; rootRef?: string; query?: string; role?: string; reveal: boolean },
): Promise<Snapshot> {
  const out: Snapshot = { lines: [], note: [] };
  let frame = tab.page.mainFrame();
  let prefix = "";
  if (opts.rootRef) {
    const parsed = parseRef(tab, opts.rootRef);
    frame = parsed.frame;
    prefix = parsed.prefix;
  }
  await walkFrame(tab, frame, prefix, opts, "", out, { frames: 0 });
  return out;
}

function parseRef(tab: Tab, ref: string): { frame: Frame; prefix: string; clean: string } {
  const clean = String(ref || "").trim();
  const m = /^(f\d+)?e\d+$/.exec(clean);
  if (!m) throw new ToolError(`"${ref}" is not a ref. Refs look like e12 or f1e12 and come from read_page or find.`);
  if (!m[1]) return { frame: tab.page.mainFrame(), prefix: "", clean };
  const frame = tab.frames.get(m[1]);
  if (!frame || frame.isDetached()) throw new ToolError(`Ref ${clean} is stale: its frame is gone. Call read_page again.`);
  return { frame, prefix: m[1], clean };
}

/** The element a ref names. A stale ref is an error that says so, never a guess. */
export async function refLocator(tab: Tab, ref: string): Promise<{ locator: Locator; frame: Frame }> {
  const { frame, clean } = parseRef(tab, ref);
  const locator = frame.locator(`cfaref=${clean}`);
  let count = 0;
  try {
    count = await locator.count();
  } catch {}
  if (count === 0) throw new ToolError(`Ref ${clean} is stale or unknown (the page changed since it was listed). Call read_page again.`);
  return { locator, frame };
}

export async function pageText(tab: Tab): Promise<{ title: string; text: string }> {
  const raw = await evalWithin<string>(
    tab.page,
    `(function () {
      var root = document.querySelector("main, article, [role=main]");
      var body = document.body;
      var text = body ? body.innerText : "";
      if (root && root.innerText && root.innerText.length > 0.6 * text.length) text = root.innerText;
      return JSON.stringify({ title: document.title, text: text });
    })()`,
    10000,
  );
  if (!raw) throw new ToolError("The page did not answer within 10 s.");
  return JSON.parse(raw);
}

/**
 * Call a function given as source (`function (el, arg) {...}`) on a locator's element,
 * in the isolated world. Playwright only applies real functions to the element; a
 * string would be evaluated as a bare expression.
 */
export function callOn<T = any>(locator: Locator, source: string, arg?: unknown, timeout = 5000): Promise<T> {
  const fn = new Function("el", "arg", `return (${source})(el, arg);`);
  return locator.evaluate(fn as any, arg, { timeout }) as Promise<T>;
}
