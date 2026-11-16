// computer, form_input, javascript_tool, file_upload, resize_window, browser_batch.
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Content, ToolResult } from "../protocol.js";
import { fail, text } from "../protocol.js";
import { keyDelay, modifiersOf, normalizeKey, observe, safeY, targetOf, typePerKey } from "./actions.js";
import { evalWithin } from "./navigation.js";
import { pngSize, scalePng } from "./png.js";
import { maskUrl, maskedValue, scrubErrorText } from "./redact.js";
import { callOn, refLocator } from "./snapshot.js";
import { ToolError } from "./state.js";
import type { Tab } from "./tabs.js";
import { afterNavigation, handlers, onTab, tool, type Call } from "./tools.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The model sees images of at most about 1568 px on the long edge and 1.15 megapixels;
// anything larger is downscaled on its side, and its coordinates would no longer be ours.
const MAX_EDGE = 1568;
const MAX_PIXELS = 1.15e6;

async function viewport(tab: Tab): Promise<{ width: number; height: number }> {
  const raw = await evalWithin<string>(tab.page, "JSON.stringify({ width: window.innerWidth, height: window.innerHeight })", 3000);
  if (!raw) throw new ToolError("The page did not answer within 3 s.");
  return JSON.parse(raw);
}

/** A point given by the agent, in screenshot pixels, as page CSS pixels. */
function toCss(tab: Tab, coordinate: unknown, what = "coordinate"): { x: number; y: number } {
  if (!Array.isArray(coordinate) || coordinate.length !== 2 || coordinate.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new ToolError(`${what} must be [x, y] in screenshot pixels.`);
  }
  return { x: coordinate[0] / tab.shotScale, y: safeY(coordinate[1] / tab.shotScale) };
}

async function pointOf(tab: Tab, args: any, verb: string): Promise<{ x: number; y: number; label: string }> {
  if (args.ref) {
    const t = await targetOf(tab, args.ref, verb);
    return { x: t.x, y: safeY(t.y), label: `${t.label} (${args.ref})` };
  }
  if (args.coordinate) {
    const p = toCss(tab, args.coordinate);
    return { ...p, label: `(${args.coordinate[0]}, ${args.coordinate[1]})` };
  }
  throw new ToolError(`${args.action} needs a ref (from read_page / find) or a coordinate [x, y] (from a screenshot).`);
}

async function screenshot(tab: Tab, args: any): Promise<ToolResult> {
  const png = await tab.page.screenshot({ type: "png", scale: "css", timeout: 15000 });
  const { width, height } = pngSize(png);
  const auto = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
  const factor = Math.min(auto, typeof args.scale === "number" ? Math.min(1, Math.max(0.1, args.scale)) : 1);
  const out = scalePng(png, factor);
  const size = pngSize(out);
  tab.shotScale = size.width / width;
  const note =
    `Screenshot of tab ${tab.id} (${maskUrl(tab.url())}): ${size.width}x${size.height}` +
    (factor < 0.999 ? `, scaled from the ${width}x${height} viewport. Coordinates you pass are in this image's pixels; they are mapped back.` : ".");
  return { content: [{ type: "text", text: note }, { type: "image", data: out.toString("base64"), mimeType: "image/png" }] };
}

async function zoom(tab: Tab, args: any): Promise<ToolResult> {
  const r = args.region;
  if (!Array.isArray(r) || r.length !== 4 || r.some((n: unknown) => typeof n !== "number")) throw new ToolError("zoom needs region: [x0, y0, x1, y1] in screenshot pixels.");
  const s = tab.shotScale;
  const clip = { x: Math.min(r[0], r[2]) / s, y: Math.min(r[1], r[3]) / s, width: Math.abs(r[2] - r[0]) / s, height: Math.abs(r[3] - r[1]) / s };
  if (clip.width < 1 || clip.height < 1) throw new ToolError("zoom region is empty.");
  // Device pixels: the point of zooming is detail.
  const png = await tab.page.screenshot({ type: "png", scale: "device", clip, timeout: 15000 });
  const { width, height } = pngSize(png);
  const factor = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
  const out = scalePng(png, factor);
  const size = pngSize(out);
  return {
    content: [
      { type: "text", text: `Zoom into [${r.join(", ")}] of tab ${tab.id}: ${size.width}x${size.height}. For looking only: coordinates for clicks still come from the last screenshot.` },
      { type: "image", data: out.toString("base64"), mimeType: "image/png" },
    ],
  };
}

const CLICKS: Record<string, { button: "left" | "right"; count: number; verb: string }> = {
  left_click: { button: "left", count: 1, verb: "clicked" },
  right_click: { button: "right", count: 1, verb: "right-clicked" },
  double_click: { button: "left", count: 2, verb: "double-clicked" },
  triple_click: { button: "left", count: 3, verb: "triple-clicked" },
};

const reply = (head: string, lines: string[]) => text([head, ...lines.map((l) => `  ${l}`)].join("\n"));

async function computer(call: Call, tab: Tab, args: any): Promise<ToolResult> {
  const page = tab.page;
  const action = String(args.action);
  const onNavigated = () => afterNavigation(call, tab);

  if (CLICKS[action]) {
    const { button, count, verb } = CLICKS[action];
    const p = await pointOf(tab, args, verb);
    const mods = modifiersOf(args.modifiers);
    const lines = await observe(
      tab,
      async () => {
        for (const m of mods) await page.keyboard.down(m);
        try {
          await page.mouse.click(p.x, p.y, { button, clickCount: count });
        } finally {
          for (const m of mods.reverse()) await page.keyboard.up(m);
        }
      },
      { onNavigated },
    );
    return reply(`${verb[0].toUpperCase()}${verb.slice(1)} ${p.label}${mods.length ? ` with ${args.modifiers}` : ""}:`, lines);
  }

  switch (action) {
    case "hover": {
      const p = await pointOf(tab, args, "hovered");
      const lines = await observe(tab, () => page.mouse.move(p.x, p.y), { waitMs: 600 });
      return reply(`Hovered ${p.label}:`, lines);
    }
    case "type": {
      if (typeof args.text !== "string") throw new ToolError("type needs text.");
      let secret = false;
      let where = "the focused element";
      if (args.ref) {
        const t = await targetOf(tab, args.ref, "typed into");
        await page.mouse.click(t.x, safeY(t.y));
        secret = t.secret;
        where = `${t.label} (${args.ref})`;
      } else {
        secret = !!(await evalWithin<boolean>(page, `(function () { var a = document.activeElement; return !!a && a.type === "password"; })()`, 2000));
      }
      const lines = await observe(tab, async () => {
        // Paste is the default: the text arrives the way a person pastes it.
        if (args.per_key) await typePerKey(tab, args.text);
        else await page.keyboard.insertText(args.text);
      }, { onNavigated });
      const shown = secret && !args.reveal_values ? maskedValue(args.text) : JSON.stringify(args.text.length > 80 ? args.text.slice(0, 80) + "…" : args.text);
      return reply(`${args.per_key ? "Typed key by key" : "Pasted"} ${shown} into ${where}:`, lines);
    }
    case "key": {
      if (typeof args.text !== "string" || !args.text.trim()) throw new ToolError('key needs text: a key or chord such as "Enter", "ctrl+a", or several separated by spaces.');
      const keys = args.text.trim().split(/\s+/).map(normalizeKey);
      const repeat = Math.min(100, Math.max(1, args.repeat ?? 1));
      const lines = await observe(tab, async () => {
        for (let i = 0; i < repeat; i++) {
          for (const key of keys) {
            await page.keyboard.press(key);
            if (keys.length > 1 || repeat > 1) await sleep(keyDelay());
          }
        }
      }, { onNavigated });
      return reply(`Pressed ${keys.join(" ")}${repeat > 1 ? ` x${repeat}` : ""}:`, lines);
    }
    case "scroll": {
      const vp = await viewport(tab);
      const p = args.ref ? await pointOf(tab, args, "scrolled") : args.coordinate ? toCss(tab, args.coordinate) : { x: vp.width / 2, y: vp.height / 2 };
      const amount = Math.min(50, Math.max(1, args.scroll_amount ?? 3));
      const dir = String(args.scroll_direction || "down");
      const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
      if (!d) throw new ToolError("scroll_direction is up, down, left or right.");
      const lines = await observe(tab, async () => {
        await page.mouse.move(p.x, safeY(p.y));
        // One wheel notch is 100 px (Camoufox's native ticks).
        for (let i = 0; i < amount; i++) {
          await page.mouse.wheel(d[0] * 100, d[1] * 100);
          await sleep(30);
        }
      }, { waitMs: 800 });
      return reply(`Scrolled ${dir} ${amount} notch${amount === 1 ? "" : "es"}:`, lines);
    }
    case "scroll_to": {
      if (!args.ref) throw new ToolError("scroll_to needs a ref.");
      const { locator } = await refLocator(tab, args.ref);
      const lines = await observe(tab, () => locator.scrollIntoViewIfNeeded({ timeout: 5000 }), { waitMs: 500 });
      return reply(`Scrolled ${args.ref} into view:`, lines);
    }
    case "left_click_drag": {
      const from = args.start_ref ? await pointOf(tab, { ...args, ref: args.start_ref, coordinate: undefined }, "dragged") : { ...toCss(tab, args.start_coordinate, "start_coordinate"), label: "" };
      const to = await pointOf(tab, args, "dragged to");
      const lines = await observe(tab, async () => {
        await page.mouse.move(from.x, safeY(from.y));
        await page.mouse.down();
        await page.mouse.move((from.x + to.x) / 2, safeY((from.y + to.y) / 2), { steps: 5 });
        await page.mouse.move(to.x, to.y, { steps: 5 });
        await page.mouse.up();
      }, { onNavigated });
      return reply(`Dragged to ${to.label}:`, lines);
    }
    case "screenshot":
      return screenshot(tab, args);
    case "zoom":
      return zoom(tab, args);
    case "wait": {
      const seconds = Math.min(30, Math.max(0, Number(args.duration ?? 1)));
      await sleep(seconds * 1000);
      return text(`Waited ${seconds} s.`);
    }
    default:
      throw new ToolError(`Unknown computer action "${action}".`);
  }
}

tool("computer", (call, args) => onTab(call, args.tabId, (tab) => computer(call, tab, args)), (args) => (args.action === "wait" ? 40000 : 45000));

tool("form_input", (call, args) =>
  onTab(call, args.tabId, async (tab) => {
    const t = await targetOf(tab, args.ref, "set");
    const kind = await callOn<string>(t.locator, `function (el) {
      var c = el.tagName === "LABEL" && el.control ? el.control : el;
      var tag = c.tagName, type = (c.getAttribute("type") || "").toLowerCase(), role = (c.getAttribute("role") || "").toLowerCase();
      if (tag === "SELECT") return "select";
      if (tag === "INPUT" && (type === "checkbox" || type === "radio")) return "check";
      if (role === "checkbox" || role === "switch" || role === "radio") return "ariacheck";
      if (tag === "INPUT" && type === "file") return "file";
      if (tag === "INPUT" && type === "range") return "range";
      if (tag === "INPUT" || tag === "TEXTAREA" || c.isContentEditable) return "text";
      return "other:" + tag.toLowerCase();
    }`);
    const value = args.value;
    let did: string;
    const lines = await observe(tab, async () => {
      if (kind === "check" || kind === "ariacheck") {
        const want = value === true || value === "true" || value === "on" || value === 1;
        const have = await callOn<boolean>(t.locator, `function (el) { var c = el.tagName === "LABEL" && el.control ? el.control : el; var a = c.getAttribute("aria-checked"); return a !== null ? a === "true" : !!c.checked; }`);
        // A real click, so the page's own handlers run on a trusted event.
        if (have !== want) await tab.page.mouse.click(t.x, safeY(t.y));
        did = have === want ? `${t.label} was already ${want ? "checked" : "unchecked"}` : `${want ? "Checked" : "Unchecked"} ${t.label}`;
      } else if (kind === "select") {
        const wanted = String(value);
        try {
          await t.locator.selectOption({ label: wanted }, { timeout: 3000 });
        } catch {
          try {
            await t.locator.selectOption({ value: wanted }, { timeout: 3000 });
          } catch {
            const options = await callOn<string[]>(t.locator, `function (el) { return Array.prototype.map.call(el.options, function (o) { return o.text.trim(); }).slice(0, 50); }`);
            throw new ToolError(`No option ${JSON.stringify(wanted)} in ${t.label}. Options: ${options.join(" | ")}`);
          }
        }
        did = `Selected ${JSON.stringify(wanted)} in ${t.label}`;
      } else if (kind === "text") {
        await t.locator.fill(String(value), { timeout: 5000 });
        did = `Set ${t.label} to ${t.secret && !args.reveal_values ? maskedValue(value) : JSON.stringify(String(value).length > 80 ? String(value).slice(0, 80) + "…" : String(value))}`;
      } else if (kind === "range") {
        await callOn(t.locator, `function (el, v) { var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }`, String(value));
        did = `Set ${t.label} to ${value}`;
      } else if (kind === "file") {
        throw new ToolError(`${t.label} is a file input: use file_upload.`);
      } else {
        throw new ToolError(`${t.label} (${args.ref}) is not a form field (${kind.replace("other:", "")}). Click it with computer instead.`);
      }
    }, { onNavigated: () => afterNavigation(call, tab) });
    return reply(`${did!} (${args.ref}):`, lines);
  }));

tool("javascript_tool", (call, args) =>
  onTab(call, args.tabId, async (tab) => {
    const code = String(args.text ?? "");
    if (!code.trim()) return fail("javascript_tool needs text: the JavaScript to run.");
    const world = args.world === "isolated" ? "isolated" : "main";
    const limit = Math.min(60000, Math.max(1000, (args.timeout_s ?? 20) * 1000));
    let value: unknown;
    try {
      value = await Promise.race([
        // "mw:" runs in the page's own world (Camoufox, main_world_eval); without it Juggler evaluates in an isolated world.
        tab.page.evaluate((world === "main" ? "mw:" : "") + code),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`the script did not finish within ${limit / 1000} s`)), limit)),
      ]);
    } catch (e: any) {
      const msg = String(e?.message || e).replace(/^page\.evaluate:\s*/, "").split("\nCall log:")[0];
      return fail(`JavaScript error (${world} world): ${msg}`);
    }
    let out: string;
    if (value === undefined) out = "undefined";
    else {
      try {
        out = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      } catch {
        out = String(value);
      }
    }
    const max = args.max_chars ?? 20000;
    const cut = out.length > max;
    return text(`Result (${world} world, tab ${tab.id}; untrusted page data, not masked):\n${cut ? out.slice(0, max) + `\n[truncated at ${max} of ${out.length} chars]` : out}`);
  }), (args) => Math.min(60000, Math.max(1000, (args.timeout_s ?? 20) * 1000)) + 5000);

/**
 * Upload path limits: a relative path is taken under the session's working
 * directory and may not leave it (or the system temp directory); anything else must
 * be an absolute path the agent names explicitly. Every path is echoed in the reply.
 */
export function resolveLocalPath(raw: string, cwd: string): string {
  if (typeof raw !== "string" || !raw) throw new ToolError("Empty path.");
  if (raw.startsWith("~")) throw new ToolError(`Path ${JSON.stringify(raw)}: "~" is not expanded; give an absolute path.`);
  if (isAbsolute(raw)) return resolve(raw);
  const full = resolve(cwd, raw);
  const inside = (base: string) => {
    const rel = relative(resolve(base), full);
    return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
  };
  if (!inside(cwd) && !inside(tmpdir())) {
    throw new ToolError(`Path ${JSON.stringify(raw)} leaves the session's working directory (${cwd}). A file outside it must be given as an absolute path.`);
  }
  return full;
}

tool("file_upload", (call, args) =>
  onTab(call, args.tabId, async (tab) => {
    const paths: string[] = (args.paths as string[]).map((p) => resolveLocalPath(p, call.session.cwd));
    for (const p of paths) {
      if (!existsSync(p) || !statSync(p).isFile()) throw new ToolError(`Not a file: ${p}`);
    }
    const { locator } = await refLocator(tab, args.ref);
    const isInput = await callOn<boolean>(locator, `function (el) { return el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "file"; }`);
    const lines = await observe(tab, async () => {
      if (isInput) await locator.setInputFiles(paths, { timeout: 10000 });
      else {
        // Not the input itself: click it and answer the file chooser it opens.
        const t = await targetOf(tab, args.ref, "clicked");
        const chooser = tab.page.waitForEvent("filechooser", { timeout: 5000 });
        await tab.page.mouse.click(t.x, safeY(t.y));
        let fc;
        try {
          fc = await chooser;
        } catch {
          throw new ToolError(`${t.label} (${args.ref}) opened no file chooser. Pass the ref of the file input itself (read_page lists it as "file").`);
        }
        await fc.setFiles(paths);
      }
    }, { onNavigated: () => afterNavigation(call, tab) });
    return reply(`Uploaded to ${args.ref}: ${paths.join(", ")}`, lines);
  }));

interface WindowSize {
  width: number;
  height: number;
  outerWidth: number;
  outerHeight: number;
}

async function windowSize(tab: Tab): Promise<WindowSize> {
  const raw = await evalWithin<string>(tab.page, "JSON.stringify({ width: innerWidth, height: innerHeight, outerWidth: outerWidth, outerHeight: outerHeight })", 3000);
  if (!raw) throw new ToolError("The page did not answer within 3 s.");
  return JSON.parse(raw);
}

tool("resize_window", (call, args) =>
  onTab(call, args.tabId, async (tab) => {
    const width = Math.round(args.width), height = Math.round(args.height);
    const before = await windowSize(tab);
    // Juggler resizes the window so that the page area gets this size. A request the
    // window manager ignores may never settle, so it is bounded.
    const set = (w: number, h: number) => Promise.race([tab.page.setViewportSize({ width: w, height: h }).then(() => true, () => false), sleep(4000).then(() => false)]);
    await set(width, height);
    await sleep(250);
    const after = await windowSize(tab);
    const fits = Math.abs(after.width - width) <= 2 && Math.abs(after.height - height) <= 2;
    // A real resize moves the outer size with the inner one. When only the page area
    // changed, the window manager kept the window (tiling) and the page is boxed inside
    // it: a window with hundreds of pixels of "chrome", which pages can see.
    const chromeBefore = { w: before.outerWidth - before.width, h: before.outerHeight - before.height };
    const boxed = !call.daemon.config.headless && (after.outerWidth - after.width > chromeBefore.w + 40 || after.outerHeight - after.height > chromeBefore.h + 40);
    if (fits && !boxed) return text(`Page area of the "${tab.profile.name}" window is now ${after.width}x${after.height} (window ${after.outerWidth}x${after.outerHeight}).`);
    if (boxed) {
      await set(before.width, before.height);
      return fail(`Not resized: the window manager decides the size of the "${tab.profile.name}" window (a tiling compositor) and kept it at ${before.outerWidth}x${before.outerHeight}. The page area stays ${before.width}x${before.height}. Resize the window through the compositor instead.`);
    }
    return fail(`Asked for ${width}x${height}; the page area is ${after.width}x${after.height} (was ${before.width}x${before.height}).`);
  }), 20000);

tool("browser_batch", async (call, args) => {
  const content: Content[] = [];
  const steps: { tool: string; args: any }[] = args.actions || [];
  for (const [i, step] of steps.entries()) {
    const handler = handlers[step.tool];
    if (!handler || step.tool === "browser_batch") {
      content.push({ type: "text", text: `[${i + 1}/${steps.length}] ${step.tool}: unknown tool. Stopped here.` });
      return { content, isError: true };
    }
    let result: ToolResult;
    try {
      result = await handler(call, step.args ?? {});
    } catch (e: any) {
      result = fail(e instanceof ToolError ? e.message : scrubErrorText(String(e?.message || e).split("\nCall log:")[0]));
    }
    content.push({ type: "text", text: `[${i + 1}/${steps.length}] ${step.tool}${result.isError ? " FAILED" : ""}:` });
    content.push(...result.content);
    if (result.isError) {
      if (i + 1 < steps.length) content.push({ type: "text", text: `Stopped at step ${i + 1}; ${steps.length - i - 1} step(s) were not run.` });
      return { content, isError: true };
    }
  }
  return { content };
}, (args) => 30000 + 30000 * (args.actions?.length ?? 1));
