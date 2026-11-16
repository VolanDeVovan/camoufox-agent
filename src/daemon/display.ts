// The real displays of this machine, for a headed launch. A window can
// be as large as the largest display, while the screen in the fingerprint is fixed: a
// window larger than its own screen is impossible on a real machine, and any page can
// compare the two. So a profile's screen is at least as large as the largest display.
import { execFileSync } from "node:child_process";

export interface Size {
  width: number;
  height: number;
}

function json(command: string, args: string[]): any {
  try {
    return JSON.parse(execFileSync(command, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

/** Wayland compositors without xrandr: each has its own way to list outputs, in logical (CSS) pixels. */
function compositorOutputs(): Size[] {
  const out: Size[] = [];
  const add = (w: unknown, h: unknown) => {
    const width = Math.round(Number(w)), height = Math.round(Number(h));
    if (width > 0 && height > 0) out.push({ width, height });
  };
  if (process.env.NIRI_SOCKET) {
    const o = json("niri", ["msg", "-j", "outputs"]);
    for (const v of Object.values(o || {}) as any[]) if (v?.logical) add(v.logical.width, v.logical.height);
  }
  if (!out.length && process.env.SWAYSOCK) {
    for (const v of (json("swaymsg", ["-t", "get_outputs", "-r"]) || []) as any[]) if (v?.active && v.rect) add(v.rect.width, v.rect.height);
  }
  if (!out.length && process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    for (const v of (json("hyprctl", ["monitors", "-j"]) || []) as any[]) {
      const turned = v?.transform % 2 === 1;
      const w = v.width / (v.scale || 1), h = v.height / (v.scale || 1);
      add(turned ? h : w, turned ? w : h);
    }
  }
  if (!out.length && process.env.WAYLAND_DISPLAY) {
    for (const v of (json("wlr-randr", ["--json"]) || []) as any[]) {
      const mode = (v?.modes || []).find((m: any) => m.current);
      if (!v?.enabled || !mode) continue;
      const turned = /90|270/.test(String(v.transform || ""));
      const w = mode.width / (v.scale || 1), h = mode.height / (v.scale || 1);
      add(turned ? h : w, turned ? w : h);
    }
  }
  return out;
}

/** The roomiest display in CSS pixels, or null when it cannot be probed. */
export async function largestDisplay(): Promise<Size | null> {
  try {
    // The launcher's own probe: xrandr on Linux, AppKit on macOS, PowerShell on Windows.
    const { largestDisplay: probe } = await import("camoufox/dist/display.js" as string);
    const d = probe();
    if (d?.width > 0 && d?.height > 0) return { width: d.width, height: d.height };
  } catch {}
  const outputs = compositorOutputs();
  if (!outputs.length) return null;
  return outputs.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
}

/** Does a screen of this size hold a display (or window) of that size? */
export const holds = (screen: Size, inner: Size) => screen.width >= inner.width && screen.height >= inner.height;

const COMMON: Size[] = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
  { width: 5120, height: 2880 },
];

/** The smallest common screen that holds `inner`, or `inner` itself when none does. */
export function screenFor(inner: Size): Size {
  return COMMON.find((s) => holds(s, inner)) || inner;
}

/** Set the screen of an fpgen fingerprint in place, keeping its taskbar gaps. */
export function setScreen(fingerprint: Record<string, any>, size: Size): void {
  const sc = fingerprint.screen || (fingerprint.screen = {});
  const gapW = Math.max(0, (sc.width || 0) - (sc.availWidth || sc.width || 0));
  const gapH = Math.max(0, (sc.height || 0) - (sc.availHeight || sc.height || 0));
  sc.width = size.width;
  sc.height = size.height;
  sc.availWidth = size.width - gapW;
  sc.availHeight = size.height - gapH;
}
