# 01 — Architecture

## The chain

```
Claude Code
  │  MCP: JSON-RPC over stdio. Claude Code starts the server with the session
  │  and kills it on exit, whether or not the session ever uses a browser.
  v
camoufox-agent mcp            (Node process, one per Claude session)
  │  ProfileManager: profile name → running browser (or none)
  │  TabRegistry:    flat list of tabs across browsers, the active tab
  │  camoufox-js:    binary path, fingerprint (CAMOU_CONFIG), prefs
  │  playwright-core: firefox.launchPersistentContext(profileDir, ...)
  v
Camoufox process per profile  (Firefox 158 + Camoufox patches)
  │  Juggler over a pipe — Firefox's automation protocol, runs in an
  │  isolated world the page cannot see
  v
tabs / pages
```

Separately, with no link to the server at runtime:

```
camoufox-agent sync [--container X] [--profile NAME]   (CLI, one-shot)
  reads the user's Firefox profile (read-only) → writes profiles/NAME/
```

## Processes

| Process | Lifetime | Owner |
|---|---|---|
| MCP server | Claude Code session | Claude Code |
| Camoufox, one per profile | First tool call that needs that profile → `close`, server exit, or crash | MCP server |
| sync | One command | User or agent via Bash |

Two Claude sessions run two servers. They must not open the same profile at once:
Firefox's profile lock (`parent.lock`) refuses the second. See 02-lifecycle.md.

## Modules

```
src/
  mcp/
    server.ts        MCP wiring, tool registration
    tools/*.ts       one file per tool group (03-tools.md)
  browser/
    profiles.ts      ProfileManager: lazy launch, close, crash handling
    tabs.ts          TabRegistry: ids, active tab, follow-the-agent
    launch.ts        camoufox-js options, fixed identity per profile
    snapshot.ts      ref engine (04-snapshot-and-actions.md)
    actions.ts       click/fill/press + "what happened" detection
    capture.ts       console, network, page errors
  sync/
    cli.ts           argument parsing, scenarios
    firefox.ts       read the source profile: containers.json, cookies, storage
    write.ts         build the target profile
  paths.ts           XDG paths shared by both halves (the only shared code)
```

`sync/` and `browser/` never import each other. `paths.ts` is the contract:
a profile is a directory under `$XDG_DATA_HOME/camoufox-agent/profiles/<name>/`.

## Stack

- TypeScript on Node 22.
- `playwright-core` pinned below 1.63 (Camoufox's ceiling; the reference pins <1.61).
- `camoufox-js` for launch options and fingerprints.
- `@modelcontextprotocol/sdk`, `zod`.
- SQLite for sync: `node:sqlite` (Node 22.5+) to avoid a native addon.
- No `impit` / browserless HTTP in v1.
