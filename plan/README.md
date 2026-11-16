# camoufox-agent — spec

A browser for Claude Code agents: an MCP server that drives Camoufox (anti-detect
Firefox) through `playwright-core` + the official `camoufox` npm launcher, with tools shaped like Claude in
Chrome's and persistent profiles the agent manages itself. A per-user daemon owns
every browser, so parallel Claude sessions can share a profile.

## Goals

- Agent browsing on par with Claude in Chrome: tabs, snapshot with refs, clicks and
  input, console, network, JS, screenshots.
- Works on its own: the agent creates and keeps its own profiles, no setup needed.
- Profiles are plain directories, so anyone can fill one from outside. An example
  importer for Firefox containers ships in `examples/`, not in the package.
- A visible window that never takes keyboard focus from the user.
- Core tools named and shaped like Claude in Chrome's, plus groups taken from the
  reference (network, browserless HTTP, waits, storage, anti-bot diagnostics).

## Non-goals

- Driving the user's live Firefox (that would be a WebExtension + native host project).
- CAPTCHA solving, site-specific automations.
- Writing anything back into the user's Firefox profile.

## Reading order

| File | Topic |
|---|---|
| [01-architecture.md](01-architecture.md) | Chain from Claude to the page, the daemon, processes, source layout, stack |
| [02-profiles.md](02-profiles.md) | What a profile is, on-disk contract, rules for the agent, `find_session` |
| [03-lifecycle.md](03-lifecycle.md) | Lazy launch, launch configuration, several profiles and sessions, session cookies, shutdown and crashes |
| [04-tabs-and-window.md](04-tabs-and-window.md) | Per-session tab list, opening tabs, focus rules, rendering while unfocused, viewport |
| [05-tools.md](05-tools.md) | Every MCP tool; what was left out; gaps vs Claude in Chrome |
| [06-page-interaction.md](06-page-interaction.md) | `read_page` refs, action replies, human-looking input, Camoufox quirks, dialogs, downloads, deadlines |
| [07-security.md](07-security.md) | Untrusted page content, cookie scoping, uploads, secret masking |
| [08-packaging.md](08-packaging.md) | Node package (pnpm), browser download, Nix as an optional dev/install path, agent instructions |
| [09-research.md](09-research.md) | Questions only a prototype answers, in order |
| [10-example-firefox-import.md](10-example-firefox-import.md) | Example, not shipped: copying a Firefox container into a profile |
| [11-testing.md](11-testing.md) | What is worth testing and how; no tests for the sake of tests |

"The reference" throughout is `reference/mcp-camoufox`.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Own MCP server in TypeScript on the official `camoufox` npm launcher + `playwright-core`, not a fork of the reference | The reference is ~6k lines for 135 tools with a single-profile model; we want Chrome-shaped tools and many persistent profiles |
| D2 | One profile = one persistent Camoufox profile directory = one browser process | Logins, IndexedDB and cache persist as Firefox keeps them; Juggler's extra contexts are ephemeral |
| D3 | A session sees one flat list of its own tabs across all profiles | Feels like containers in one Firefox; the process split is an implementation detail |
| D4 | Lazy launch, no `launch` tool | Launch options are fixed per profile (server config); the profile is an argument of `tabs_create`; the first download reports progress from any tool |
| D5 | No session importer in the package: profile directories are the interface; a Firefox importer ships as an example | Importing the user's sessions is the installer's business and setup-specific |
| D6 | One daemon per user holds every browser; each session's MCP server is a thin client and sees only its own tabs | Firefox lets one process open a profile; parallel sessions must share `default` |
| D7 | Headed by default; the window never takes OS focus; the visible tab follows the agent only if that cannot take focus (R4) | The user watches and can take over without losing the keyboard; focus wins |
| D8 | Core tools copy Claude in Chrome's names and shapes (`computer` with actions, `read_page`, `form_input`, `navigate("back")`, ...) | The model knows that interface; skill rules carry over |
| D9 | Groups on top: network, http, wait, storage, antibot — one fixed set, no flags | Network bodies and HTTP with the profile's cookies and Firefox TLS are where we beat Chrome; deferred tool loading keeps the count cheap |
| D10 | Human-looking input is the default for every action, no humanize tools: Camoufox `humanize` (0.5 s cap) for the cursor, its native paste for text, our randomized per-key delays for key-by-key typing | Camoufox covers cursor, paste, trusted events and wheel; only key rhythm is ours |
| D11 | Secrets masked in output by default | Profiles hold real sessions |
| D12 | Any profile is created on first use; the agent owns all profiles; how a profile was filled is not tracked | The main flow is Chrome-like use of `default` with no setup |
| D13 | New profile only for another identity | Keeps profiles few and meaningful |
| D14 | `find_session(site)` shows which profile holds a session for a site; `navigate` / `tabs_create` hint when another profile has one; no metadata file, the name is the description | The agent picks the profile by where it is already logged in; a metadata file would go stale |
| D15 | Session restore on, so session cookies survive a restart | Otherwise sites log out on every browser restart |
| D16 | Page content is untrusted; cookies only to their own origin; uploads limited; downloads to a fixed dir | Real sessions + prompt injection |
| D17 | Builds, runs and is developed without Nix; `flake.nix` is an optional dev shell and, later, an extra install output | The owner uses Nix; nobody else has to |
| D18 | Tests only for what matters: behaviour users rely on, past bugs, security; real Camoufox against local pages, no mocks | Tests for the sake of tests cost upkeep and catch nothing |
| D19 | TypeScript on Node, pnpm; the official `camoufox` npm launcher, not the community `camoufox-js` | Playwright, the MCP SDK and the Camoufox launcher are all native there; upstream maintains the launcher |
| D20 | Development goes in small iterations: build a feature, test it, commit it, then the next; no single commit at the end | Each step stays reviewable and revertible; rule lives in `CLAUDE.md` |
