# How camoufox-agent works

A short description of what the project is and how it is put together.

| File | Topic |
|---|---|
| [architecture.md](architecture.md) | MCP server, daemon, browsers; lifecycle; source layout |
| [profiles.md](profiles.md) | What a profile is, where it lives, `find_session`, filling one from outside |
| [tools.md](tools.md) | The tools, refs, action replies, screenshots, security |
| [development.md](development.md) | Building, testing, releasing |

## In one paragraph

`camoufox-agent` is an MCP server. Each agent session runs its own copy, which is a
thin client of one background daemon per user. The daemon owns the browsers: one
Camoufox process per profile, driven through `playwright-core` and the official
`camoufox` launcher. A profile is a persistent Firefox profile directory with a fixed
device fingerprint, so logins survive restarts and a site sees the same device every
time. Tools are named and shaped like Claude in Chrome's, with groups on top for
network bodies, browserless HTTP, waiting, storage and anti-bot diagnostics.

## What it deliberately does not do

- Drive your own Firefox. It is a separate browser with its own profiles.
- Solve CAPTCHAs. Challenge pages are detected and handed to the user.
- Write anything back into your Firefox profile.
