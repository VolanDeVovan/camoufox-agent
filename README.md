# camoufox-agent

An MCP server that gives coding agents a browser: [Camoufox](https://github.com/daijro/camoufox)
(anti-detect Firefox) with tools shaped like Claude in Chrome's.

> [!IMPORTANT]
> This project is vibe-coded: the code was written by Claude Code, with tests but
> without a line-by-line human review.
> It drives a browser that holds your real logged-in sessions. Treat it as an
> experiment, read the code before you trust it, and expect rough edges.

The reference it borrows from is [mcp-camoufox](https://github.com/RobithYusuf/mcp-camoufox).

## Why

The goal was an MCP as convenient as Claude in Chrome, but one that does not get
caught by CAPTCHAs and anti-bot checks the way an automated Chrome does.

Two things are central:

- **Profiles.** A profile is an identity: one device fingerprint and one set of
  logins, kept on disk as a plain Firefox profile directory. The agent creates and
  manages profiles itself, and `find_session(site)` tells it which profile is already
  logged in somewhere.
- **Importing sessions from Firefox and Chrome.** [`examples/firefox-import/`](examples/firefox-import/)
  copies a Firefox container (cookies, and optionally localStorage / IndexedDB) into
  a profile; [`examples/chrome-import/`](examples/chrome-import/) copies the cookies and localStorage of
  a Chrome, Chromium, Brave, Edge, Vivaldi or Opera profile. The agent then uses
  sessions you already have.

## What you get

- Tabs, page snapshots with refs, clicks and typing, screenshots, console, network,
  JavaScript: the Claude in Chrome tool set, plus network bodies, browserless HTTP
  with the profile's cookies, and anti-bot diagnostics (31 tools,
  [docs/tools.md](docs/tools.md)).
- A visible window per profile, so you can watch and take over.
- One daemon per user holds the browsers, so parallel agent sessions share a profile.
- Every click reports what the page did; secrets are masked in tool output.
- Challenge pages are detected and handed to you. Nothing solves CAPTCHAs.

## Install

Needs Node >= 22.15. It is not on npm yet; each release has a prebuilt tarball that
`npx` runs directly:

```
claude mcp add camoufox -- npx -y https://github.com/VolanDeVovan/camoufox-agent/releases/latest/download/camoufox-agent.tgz
```

With Nix: `nix run github:VolanDeVovan/camoufox-agent`.

From a clone: `pnpm install && pnpm build`, then register `node dist/mcp/server.js`.

The first tool call that needs a browser downloads Camoufox (about 1.3 GB, once).
The server tells the agent how to use it; there is no skill to install.

```
camoufox-agent [--default-profile NAME] [--profiles-dir DIR] [--headless]
```

Tabs outlive the agent session that opened them, so you can keep reading a page or
an agent can pick it up again later; a tab nobody has used for an hour is closed
(`CAMOUFOX_AGENT_TAB_IDLE_MS`), and a browser closes with its last tab.

## Bringing your sessions in

A profile is a plain directory, so sessions you already have can be copied into it.
We keep a separate Firefox container with the logins meant for the agent, and copy
it into the agent's profile before each session. [`examples/`](examples/) has
importers for Firefox and Chrome: ask your coding agent to adapt them to your setup.

Profiles live in `~/.local/share/camoufox-agent/profiles/<name>/`.

## Development

```
pnpm test
```

Tests run a real headless Camoufox against local pages. How it works is described in
[`docs/`](docs/README.md).

## License

MIT. Parts of the navigation, masking and markdown code are adapted from
[mcp-camoufox](https://github.com/RobithYusuf/mcp-camoufox) (MIT).
