# camoufox-agent

A browser for coding agents: an MCP server that drives
[Camoufox](https://github.com/daijro/camoufox) (anti-detect Firefox) with tools shaped
like Claude in Chrome's, persistent profiles the agent manages itself, and a per-user
daemon so parallel agent sessions share a profile.

- Tabs, page snapshots with refs, clicks and input, console, network, JavaScript,
  screenshots: on par with Claude in Chrome.
- Works on its own: the agent creates and keeps its profiles; logins persist.
- A visible window per profile that never takes your keyboard focus.
- Every click reports what the page did; disabled, hidden and covered elements are
  refused instead of clicked blindly.
- Network bodies, browserless HTTP with the profile's cookies and Firefox's TLS
  fingerprint, anti-bot diagnostics.
- Secrets masked in tool output by default; page content marked as untrusted.

The design is specified in [`plan/`](plan/README.md).

## Install

Needs Node >= 22.15.

```
claude mcp add camoufox -- npx -y camoufox-agent
```

or install it (`pnpm add -g camoufox-agent`) and register the `camoufox-agent` binary.
The first tool call that needs a browser downloads Camoufox (about 1.3 GB, once) into
the launcher's cache; tools answer with the progress until it is ready.

```
camoufox-agent [--default-profile NAME] [--profiles-dir DIR] [--headless]
```

| Flag | Meaning |
|---|---|
| `--default-profile NAME` | Profile used when a tool call names none (default `default`) |
| `--profiles-dir DIR` | Where profiles live (default `$XDG_DATA_HOME/camoufox-agent/profiles`) |
| `--headless` | No window |

`CAMOUFOX_EXECUTABLE_PATH` points at a Camoufox binary of your own instead of the
downloaded one.

With Nix, `nix build` (or the flake's `packages.default` in your own flake) gives the
same binary with the browser pinned in the store, so nothing is downloaded at run
time. Nix is optional; nothing else needs it.

That is the whole setup. The server tells the agent how to use the browser itself
(MCP server instructions plus tool descriptions); there is no skill to install.

## How it runs

```
Claude Code session ── MCP (stdio) ──> camoufox-agent ──┐
Claude Code session ── MCP (stdio) ──> camoufox-agent ──┤ unix socket
                                                        v
                                             camoufox-agentd (one per user)
                                                        │
                                   one Camoufox process per running profile
```

The MCP server is a thin client. The daemon is started by the first tool call that
needs it, holds every browser, and exits ten minutes after its last client left.
Each session sees only its own tabs; two sessions can work in the same profile at
once and share its logins. No browser is ever left behind: they are closed on every
exit path of the daemon.

## Profiles

A profile is an identity: one device (fingerprint) and one set of logins. It is a
plain Firefox profile directory plus one file, `mcp-identity.json`, the device drawn
on its first launch:

```
~/.local/share/camoufox-agent/profiles/<name>/
```

- The agent uses `default` unless it needs another identity, and creates profiles on
  first use (`tabs_create(url, profile="github-bot")`).
- `find_session(site)` shows which profile already holds a session for a site.
- There is no delete tool: removing a profile is `rm -rf` of its directory.
- Anything may write into a profile while its browser is not running. That is the
  whole interface for filling a profile from outside, for example with sessions from
  your own Firefox: see [`examples/firefox-import/`](examples/firefox-import/).
- You can also just log in by hand in the agent's window.

## The window

Browsers are headed by default so you can watch and take over. The window is opened
without focus and the agent never activates it; on Wayland the tab the agent works on
is shown in the window (selecting a tab there neither focuses nor raises it).

A compositor may still focus a new toplevel when it appears, and niri does. On niri
the daemon hands focus straight back, but a keystroke can land in the new window in
between; this rule prevents it altogether (the app-id is `camoufox`):

```kdl
window-rule {
    match app-id="^camoufox$"
    open-focused false
}
```

Rendering keeps going while the window is hidden or on another workspace. F12 opens
Firefox DevTools in a window of their own.

## Tools

| Group | Tools |
|---|---|
| Core (as in Claude in Chrome) | `tabs_context` `tabs_create` `tabs_close` `navigate` `read_page` `find` `form_input` `computer` `get_page_text` `javascript_tool` `read_console_messages` `read_network_requests` `browser_batch` `file_upload` `resize_window` |
| Profiles | `find_session` `close_browser` |
| Network | `get_network_request` `wait_for_network` `block_requests` `export_har` `export_curl` |
| HTTP | `http_request` `fetch_markdown` `extract_table` |
| Wait | `wait_for` `handle_dialog` |
| Storage | `cookies` `web_storage` |
| Anti-bot | `detect_anti_bot` `fingerprint_audit` |

Details: [`plan/05-tools.md`](plan/05-tools.md). Differences from Claude in Chrome: it
is the agent's own browser, not yours; `find` is a literal text match; there is no GIF
recording. Challenge pages are detected and handed to you; nothing solves CAPTCHAs.

## Development

```
pnpm install
pnpm build
pnpm test
```

Nothing depends on Nix; `nix develop` is one convenient shell with Node and pnpm.
Tests run a real headless Camoufox against pages from a local HTTP server
([`plan/11-testing.md`](plan/11-testing.md)). Focus and window behaviour depend on the
desktop and are checked by hand with `node research/headed-check.mjs` (add `keep` to
leave the window open for a minute, e.g. to try F12).

The daemon logs to `$XDG_RUNTIME_DIR/camoufox-agent-<version>.sock.log`; the log is
removed on a clean exit.

## License

MIT. Parts of the navigation, masking and markdown code are adapted from
[mcp-camoufox](https://github.com/RobithYusuf/mcp-camoufox) (MIT).
