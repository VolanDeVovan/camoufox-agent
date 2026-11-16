# camoufox-agent

An MCP server that gives coding agents a browser: [Camoufox](https://github.com/daijro/camoufox)
(anti-detect Firefox) with tools shaped like Claude in Chrome's.

This project was vibe-coded with Claude Code from the spec in [`plan/`](plan/README.md).
The reference it borrows from is [mcp-camoufox](https://github.com/RobithYusuf/mcp-camoufox).

## Why

The goal was an MCP as convenient as Claude in Chrome, but one that does not get
caught by CAPTCHAs and anti-bot checks the way an automated Chrome does.

Two things are central:

- **Profiles.** A profile is an identity: one device fingerprint and one set of
  logins, kept on disk as a plain Firefox profile directory. The agent creates and
  manages profiles itself, and `find_session(site)` tells it which profile is already
  logged in somewhere.
- **Importing sessions from Firefox.** [`examples/firefox-import/`](examples/firefox-import/)
  copies a Firefox container (cookies, and optionally localStorage / IndexedDB) into
  a profile, so the agent can use sessions you already have.

Possible next step: converting cookies and sessions from Chrome and other browsers.

## What you get

- Tabs, page snapshots with refs, clicks and typing, screenshots, console, network,
  JavaScript: the Claude in Chrome tool set, plus network bodies, browserless HTTP
  with the profile's cookies, and anti-bot diagnostics (31 tools,
  [`plan/05-tools.md`](plan/05-tools.md)).
- A visible window per profile that does not take your keyboard focus.
- One daemon per user holds the browsers, so parallel agent sessions share a profile.
- Every click reports what the page did; secrets are masked in tool output.
- Challenge pages are detected and handed to you. Nothing solves CAPTCHAs.

## Install

It is not published to npm yet, so build it from a clone. Needs Node >= 22.15 and pnpm.

```
git clone https://github.com/VolanDeVovan/camoufox-agent
cd camoufox-agent
pnpm install
pnpm build
claude mcp add camoufox -- node "$PWD/dist/mcp/server.js"
```

With Nix: `nix build`, then register `./result/bin/camoufox-agent`.

The first tool call that needs a browser downloads Camoufox (about 1.3 GB, once).
The server tells the agent how to use it; there is no skill to install.

```
camoufox-agent [--default-profile NAME] [--profiles-dir DIR] [--headless]
```

Profiles live in `~/.local/share/camoufox-agent/profiles/<name>/`.

## The window and focus

On niri a new window gets focus for a moment when a browser starts; the daemon hands
it straight back. This rule prevents it altogether:

```kdl
window-rule {
    match app-id="^camoufox$"
    open-focused false
}
```

## Development

```
pnpm test
```

Tests run a real headless Camoufox against local pages. The design, the decisions and
the research behind them are in [`plan/`](plan/README.md).

## License

MIT. Parts of the navigation, masking and markdown code are adapted from
[mcp-camoufox](https://github.com/RobithYusuf/mcp-camoufox) (MIT).
