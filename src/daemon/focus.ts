// Giving keyboard focus back (04, Compositor). Nothing we do activates a window, but a
// compositor may focus any new toplevel: niri does, unless the user has an
// `open-focused false` rule. Where the compositor can be asked, the window that had
// focus before a launch gets it back the moment the new window takes it.
import { execFile } from "node:child_process";

function niri(args: string[]): Promise<any> {
  return new Promise((resolve) => {
    execFile("niri", ["msg", "-j", ...args], { timeout: 1500, encoding: "utf8" }, (err, out) => {
      if (err) return resolve(null);
      try {
        resolve(out.trim() ? JSON.parse(out) : true);
      } catch {
        resolve(true);
      }
    });
  });
}

/**
 * Call before something that opens toplevels, and call the returned function when it
 * is done. Until then (and for a moment after), any new window of ours that takes
 * focus loses it again to the window that had it. A launch may show more than one
 * window (the launcher probes the GPU with one of its own). Resolves to how many times
 * focus was handed back.
 */
export async function guardFocus(headless: boolean): Promise<() => Promise<number>> {
  if (headless || !process.env.NIRI_SOCKET) return async () => 0;
  const before = await niri(["focused-window"]);
  // Nothing was focused: there is nobody to give focus back to.
  if (!before || typeof before !== "object" || before.id === undefined) return async () => 0;
  const known = new Set<number>(((await niri(["windows"])) || []).map((w: any) => w.id));
  let stopAt = Infinity;
  let handedBack = 0;
  const watching = (async () => {
    while (Date.now() < stopAt) {
      const now = await niri(["focused-window"]);
      // Only a window that did not exist before, and only ours.
      if (now && typeof now === "object" && !known.has(now.id) && /camoufox/i.test(String(now.app_id || ""))) {
        await niri(["action", "focus-window", "--id", String(before.id)]);
        handedBack++;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  return async () => {
    stopAt = Date.now() + 1500;
    await watching;
    return handedBack;
  };
}
