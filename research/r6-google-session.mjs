// R6: does a Google session survive the move to a different fingerprint? Imports the
// google.com cookies of one Firefox container into a throwaway profile, opens Gmail and
// the Cloud console, and reports only where each landed. Nothing is clicked, no page
// content or cookie value is printed, and the throwaway profile is deleted at the end.
//
// Run it yourself: it replays a real session from a new device, which Google may flag
// or answer by signing the session out.
//
//   pnpm build
//   node research/r6-google-session.mjs <firefox-profile-dir> <container>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [source, container] = process.argv.slice(2);
if (!source || !container) {
  console.error("usage: node research/r6-google-session.mjs <firefox-profile-dir> <container>");
  process.exit(1);
}
const profiles = mkdtempSync(join(tmpdir(), "cfa-r6-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/mcp/server.js", "--profiles-dir", profiles, "--headless"],
  env: { ...process.env, CAMOUFOX_AGENT_IDLE_MS: "1000" },
  stderr: "inherit",
});
const client = new Client({ name: "r6", version: "0" });
await client.connect(transport);
const call = async (name, args = {}) =>
  (await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).content
    .filter((x) => x.type === "text")
    .map((x) => x.text)
    .join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // The target profile must have been opened once, so its cookie database exists.
  await call("tabs_create", { profile: "r6" });
  await call("close_browser", { profile: "r6" });
  await sleep(1500);
  const out = execFileSync(
    process.execPath,
    ["examples/firefox-import/import.mjs", "--firefox-profile", source, "--container", container, "--target", join(profiles, "r6"), "--domains", "google.com"],
    { encoding: "utf8" },
  );
  console.log(out.split("\n").filter((l) => /cookies:/.test(l)).join("").trim());
  for (const url of ["https://mail.google.com/mail/u/0/", "https://console.cloud.google.com/"]) {
    await call("tabs_create", { url, profile: "r6" }).catch(() => "");
    await sleep(6000);
    const landed = (await call("javascript_tool", { text: "location.origin + location.pathname", world: "isolated" })).split("\n").pop();
    const signedIn = !/accounts\.google\.com|\/signin|ServiceLogin|workspace\.google\.com|\/intl\//.test(landed);
    const challenge = (await call("detect_anti_bot")).split("\n")[1];
    console.log(`${url} -> ${landed} | ${signedIn ? "SIGNED IN (session accepted)" : "asked to sign in (session not accepted)"} | ${challenge}`);
  }
} finally {
  await call("close_browser", { profile: "r6" }).catch(() => {});
  await client.close();
  await sleep(2000);
  rmSync(profiles, { recursive: true, force: true });
}
