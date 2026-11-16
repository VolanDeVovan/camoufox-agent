# camoufox-agent — plan

A browser for Claude Code agents: an MCP server that drives Camoufox (anti-detect
Firefox) with the same feel as Claude in Chrome, plus a separate CLI that seeds
the agent's browser profiles from the user's own Firefox, containers included.

## Goals

- Agent browsing on par with Claude in Chrome: tabs, snapshot with refs, clicks and
  input, console, network, JS, screenshots.
- Logged-in sessions taken from the user's Firefox, per container, with everything
  a site keeps (cookies, localStorage, IndexedDB, ...), not only cookies.
- A visible window that never takes keyboard focus from the user.
- Core tools named and shaped like Claude in Chrome's; extra modules from the reference
  (network, browserless HTTP, waits, storage, anti-bot diagnostics) on top.

## Non-goals

- Driving the user's live Firefox (that would be a WebExtension + native host project).
- CAPTCHA solving, OS-level cursor clicks, site-specific automations.
- Writing anything back into the user's Firefox profile.

## Spec files

| File | Topic |
|---|---|
| [01-architecture.md](01-architecture.md) | The chain from Claude to the page, processes, modules, stack |
| [02-lifecycle.md](02-lifecycle.md) | Lazy launch, several profiles at once, the flat tab list, shutdown |
| [03-tools.md](03-tools.md) | Every MCP tool and what it answers |
| [04-snapshot-and-actions.md](04-snapshot-and-actions.md) | Refs, and replies that say what an action did |
| [05-sync.md](05-sync.md) | The `sync` CLI: Firefox profile → agent profile |
| [06-window-and-focus.md](06-window-and-focus.md) | Headed window without focus stealing |
| [07-packaging.md](07-packaging.md) | Nix package, browser binary, flake wiring, skill |
| [08-research.md](08-research.md) | What only a prototype can answer |

## Decisions so far

| # | Decision | Why |
|---|---|---|
| D1 | Own MCP server on `camoufox-js` + `playwright-core`, not a fork | The reference (`reference/mcp-camoufox`) is ~6k lines for 135 tools with a single-profile model; we want Chrome-shaped tools and profiles per container |
| D2 | One container = one persistent Camoufox profile = one browser process | "Copy everything" means IndexedDB and Cache API, which only a file copy carries; Juggler contexts are ephemeral |
| D3 | The agent sees one flat tab list across all running profiles | Feels like containers in one Firefox; process split is an implementation detail |
| D4 | Lazy launch, no `launch` tool | Our launch has no per-call options (browser comes from nix, fingerprint is fixed); the profile is an argument of `tabs_create` |
| D5 | Sync is a separate CLI the MCP server knows nothing about | Sync is a feature of its own; users write their own scenarios; the server only sees profile directories |
| D6 | Both the user and the agent (via Bash, guided by the skill) may run sync | Agent can recover a missing or stale profile without a round trip to the user |
| D7 | Headed by default; the window never takes OS focus; inside its window the visible tab follows the agent | User watches and can take over, as in Claude in Chrome, without losing the keyboard |
| D8 | Core tools copy Claude in Chrome's names and shapes (`computer` with actions, `read_page`, `form_input`, `navigate("back")`, ...) | The model knows that interface; skill rules carry over |
| D9 | Modules on top: network, http, wait, storage, antibot — flag-switchable, on by default | Network bodies and browserless HTTP with profile cookies are where we beat Chrome; deferred tool loading keeps the count cheap |
| D10 | Camoufox `humanize` always on; no humanize tools | Built into Juggler, applies to every mouse action |
| D11 | Secrets masked in output by default | Profiles hold real sessions |
