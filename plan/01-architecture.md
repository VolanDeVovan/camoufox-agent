# 01 — Architecture

## The chain

```
Claude Code session A          Claude Code session B
  │ MCP over stdio               │ MCP over stdio
  v                              v
camoufox-agent (MCP server)    camoufox-agent (MCP server)     thin, one per session
  └──────────────┬───────────────┘
                 │ unix socket: $XDG_RUNTIME_DIR/camoufox-agent-<version>.sock
                 v
camoufox-agentd (daemon, one per user)
  │  ProfileManager: profile name → running browser (or none)
  │  TabRegistry:    tabs, which session owns each, each session's active tab
  │  SessionScan:    find_session over running (live) and stopped (sqlite) profiles
  │  camoufox (npm): binary path, fingerprint (CAMOU_CONFIG), prefs
  │  playwright-core: firefox.launchPersistentContext(profileDir, ...)
  v
Camoufox process per profile  (Firefox 158 + Camoufox patches)
  │  Juggler over a pipe — Firefox's automation protocol; Playwright's own
  │  evaluate/selectors run in an isolated world the page cannot see
  v
windows / tabs / pages
```

## Why a daemon

Firefox lets only one process open a profile. Two Claude sessions that both want
`default` would otherwise fail on the profile lock, and parallel agents are the normal
case. So one daemon per user holds every browser, and each session's MCP server is a
client of it. This mirrors Claude in Chrome, where one browser serves several sessions,
each in its own tab group.

## Processes

| Process | Lifetime | Owner |
|---|---|---|
| MCP server | The Claude Code session | Claude Code |
| Daemon | Started by the first MCP server that needs a browser (detached spawn); exits after all clients disconnect and an idle timeout (default 10 min) | Itself |
| Camoufox, one per profile | First use → `close_browser`, daemon exit, or crash | Daemon |

- The MCP server starts no browser and no daemon at startup; the first tool call that
  needs one does (03-lifecycle.md).
- Socket lock: the daemon takes an exclusive lock file next to the socket, so two MCP
  servers racing to start it end with one daemon.
- Protocol: JSON-RPC over the socket, one request per tool call. The MCP server
  forwards each tool call with its session id; the daemon holds no MCP state.
- The socket name carries the package version, so an MCP server never talks to a
  daemon of another version: it asks any such daemon to exit once idle and starts its
  own. Until the old one exits, a profile it still runs answers "in use by another
  process".
- `--profiles-dir` and `--headless` are properties of the browsers a daemon owns, so a
  non-default combination gets its own daemon: the socket name ends in a hash of the
  two. `--default-profile` is per session and travels with it.
- The daemon logs to `<socket>.log`; a clean exit removes the log.

Shutdown and crash handling: 03-lifecycle.md.

## Source layout

```
src/
  mcp/
    server.ts        MCP wiring, tool registration
    client.ts        daemon client: connect, start the daemon, reconnect
    tools/*.ts       tool schemas, forwarded to the daemon (05)
  daemon/
    main.ts          socket server, client sessions, deadlines, idle exit
    install.ts       browser download in the background, progress (08)
    tools*.ts        tool handlers, one file per group (05)
    profiles.ts      ProfileManager: lazy launch, close, crash handling (03)
    tabs.ts          TabRegistry: ids, ownership, active tab per session (04)
    launch.ts        camoufox launcher options, fixed identity per profile, prefs (03)
    snapshot.ts      ref engine (06)
    actions.ts       click/fill/press + "what happened" detection (06)
    navigation.ts    navigate with Camoufox's quirks (06)
    capture.ts       console, network, page errors, downloads
    sessions.ts      find_session + cross-profile hint (02)
    redact.ts        secret masking (07)
  protocol.ts        the wire between MCP server and daemon
  paths.ts           profiles root, socket, downloads (02, 06)
examples/
  firefox-import/    copy a Firefox container into a profile; not part of the package (10)
```

## Stack

- TypeScript on Node, pnpm. Node because Playwright is a Node library (its Python
  binding drives the same Node driver), the MCP SDK is TypeScript-first, Camoufox ships
  an official npm launcher, and the reference to borrow from is TypeScript.
- Node >= 22.15 (Camoufox's floor; also what `node:sqlite` needs unflagged).
- `playwright-core` pinned below 1.63 (Camoufox's ceiling). The reference pins <1.61
  because of an `isMobile` schema rejection; R3 checks 1.61 / 1.62.
- `camoufox`, the official npm launcher from the Camoufox repo (`typescript/`, a port of
  the Python reference launcher), pinned to an exact version (why: 08-packaging.md).
  The reference uses the older community `camoufox-js` (Apify); we do not.
- `@modelcontextprotocol/sdk`, `zod`.
- `node:sqlite` to read stopped profiles' cookies for `find_session`.
- `impit` for `http_request` / `fetch_markdown` (Firefox TLS fingerprint).
