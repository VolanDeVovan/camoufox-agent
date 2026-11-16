// Daemon lifecycle: one daemon under a start race, idle exit, no orphan Camoufox on any
// exit path, relaunch after a browser crash. Orphans and double launches are the
// failures the reference spent releases on (03-lifecycle.md).
import { afterAll, expect, test } from "vitest";
import { browsersOn, cleanupTemps, daemonPids, fixture, sleep, startSession, tempDir, waitFor } from "./helpers.js";

afterAll(cleanupTemps);

test("two sessions racing to start the daemon end with one daemon and one browser", async () => {
  const dir = tempDir();
  const site = await fixture({ "/": "<title>Race</title>hi" });
  const [a, b] = await Promise.all([startSession({ profilesDir: dir }), startSession({ profilesDir: dir })]);
  try {
    const [ra, rb] = await Promise.all([a.call("navigate", { url: site.base + "/" }), b.call("navigate", { url: site.base + "/" })]);
    expect(ra.isError).toBe(false);
    expect(rb.isError).toBe(false);
    expect(daemonPids(dir)).toHaveLength(1);
    // Both sessions share the one browser of "default" (parent process only).
    const parents = browsersOn(dir).length;
    expect(parents).toBe(1);
  } finally {
    await a.close();
    await b.close();
    await site.close();
  }
  // Last client gone + idle timeout: the daemon closes all browsers and exits.
  expect(await waitFor(() => daemonPids(dir).length === 0, 15000)).toBe(true);
  expect(browsersOn(dir)).toHaveLength(0);
});

test("SIGTERM closes the browsers and removes the socket", async () => {
  const dir = tempDir();
  const s = await startSession({ profilesDir: dir, env: { CAMOUFOX_AGENT_IDLE_MS: "600000" } });
  try {
    await s.call("tabs_create", {});
    expect(browsersOn(dir).length).toBe(1);
    const [pid] = daemonPids(dir);
    process.kill(pid, "SIGTERM");
    expect(await waitFor(() => daemonPids(dir).length === 0, 20000)).toBe(true);
    expect(await waitFor(() => browsersOn(dir).length === 0, 5000)).toBe(true);
  } finally {
    await s.close();
  }
});

test("a killed daemon leaves no orphan browser, and the next call starts a new one", async () => {
  const dir = tempDir();
  const s = await startSession({ profilesDir: dir });
  try {
    await s.call("tabs_create", {});
    const [pid] = daemonPids(dir);
    process.kill(pid, "SIGKILL");
    expect(await waitFor(() => browsersOn(dir).length === 0, 15000)).toBe(true);
    await sleep(200);
    const again = await s.call("tabs_context", { createIfEmpty: true });
    expect(again.isError).toBe(false);
    expect(daemonPids(dir)).toHaveLength(1);
    expect(daemonPids(dir)[0]).not.toBe(pid);
  } finally {
    await s.close();
  }
});

test("a browser that dies is reported and relaunched on next use", async () => {
  const dir = tempDir();
  const site = await fixture({ "/": "<title>Alive</title>ok" });
  const s = await startSession({ profilesDir: dir });
  try {
    await s.call("navigate", { url: site.base + "/" });
    const [browser] = browsersOn(dir);
    process.kill(browser, "SIGKILL");
    await waitFor(() => browsersOn(dir).length === 0, 10000);
    await sleep(300);
    // The reply names what happened instead of silently switching...
    const first = await s.call("navigate", { url: site.base + "/" });
    expect(first.isError).toBe(true);
    expect(first.text).toMatch(/exited|crashed/);
    // ...and the next use relaunches the profile.
    const second = await s.call("navigate", { url: site.base + "/" });
    expect(second.isError).toBe(false);
    expect(second.text).toContain("Alive");
    expect(browsersOn(dir).length).toBe(1);
  } finally {
    await s.close();
    await site.close();
  }
});

test("a session that arrives while the daemon is shutting down gets a new daemon, not a dead call", async () => {
  const dir = tempDir();
  const first = await startSession({ profilesDir: dir, env: { CAMOUFOX_AGENT_IDLE_MS: "600000" } });
  const second = await startSession({ profilesDir: dir, env: { CAMOUFOX_AGENT_IDLE_MS: "1500" } });
  try {
    await first.call("tabs_create", {});
    const [pid] = daemonPids(dir);
    // The daemon starts closing its browser (which takes a moment); a new session calls right then.
    process.kill(pid, "SIGTERM");
    await sleep(50);
    const r = await second.call("tabs_context", { createIfEmpty: true });
    expect(r.isError, r.text).toBe(false);
    expect(daemonPids(dir).filter((p) => p !== pid)).toHaveLength(1);
    expect(browsersOn(dir)).toHaveLength(1);
  } finally {
    await first.close();
    await second.close();
  }
});
