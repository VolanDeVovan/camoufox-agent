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
  a profile; [`examples/chrome-import/`](examples/chrome-import/) copies the cookies of
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

## Bringing your sessions in

The server has no import tool. A profile is a plain directory that anything may write
to while its browser is not running, and the two importers in `examples/` are starting
points for your own scripts, not a fixed workflow. How I use them:

- In my everyday Firefox I keep a container named `camoufox` and sign in there to
  everything the agent may use. That container is the agent's set of logins, and I
  manage it in a browser I already have open.
- A personal Claude Code skill runs a `sync` script before the agent's first browser
  call of a session. It is a three-line wrapper around
  [`examples/firefox-import/import.mjs`](examples/firefox-import/):

  ```bash
  #!/usr/bin/env bash
  exec node ~/.claude/skills/camoufox/import.mjs \
    --firefox-profile ~/.config/mozilla/firefox/default --container camoufox \
    --target ~/.local/share/camoufox-agent/profiles/default --storage "$@"
  ```

- The skill tells the agent never to close the browser for the sync: the browser is
  shared by every agent session. If it is running, the sync is skipped and the profile
  keeps what the last one copied.

Other setups are a few lines of the same kind: import a Chrome profile instead
([`examples/chrome-import/`](examples/chrome-import/)), fill a second profile for a
second account, sync on a timer, or limit an import to a few sites with `--domains`.
The easiest way to get yours is to ask your coding agent to write it, with these
examples and [docs/profiles.md](docs/profiles.md) as its reference.

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
