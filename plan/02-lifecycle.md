# 02 — Lifecycle

## Lazy launch

There is no `launch` tool. A tool that needs a page asks the TabRegistry for the
active tab; if there is none, the default profile is launched and a blank tab opened.

```
navigate("https://x")          no browser running
  → ProfileManager.ensure(defaultProfile)   launch, ~2 s
  → TabRegistry: tab #1 (default) active
  → navigate
```

`tabs_create(url, profile="golove")` launches `golove` if it is not running.

Why the reference has an explicit `browser_launch`: its options change per call
(headless, fingerprint OS, locale, geoip, window size, temp profile, uBlock), and its
first launch downloads the browser (1.3 GB) and has to answer "downloading, 40%, call
again". We have neither: the binary comes from nix and the launch options are fixed
per profile. What would have been launch options is a server config (env / flags).

### Default profile

Server flag `--default-profile NAME` (default: `default`). If the profile directory
does not exist the tool answers with an error that names the fix:

```
Profile "golove" does not exist. Create it with:
  camoufox-agent sync --container golove
```

The server never creates profiles. An empty throwaway profile is the one exception:
`profile="temp"` launches a fresh temp profile, deleted on close.

## Several profiles at once

ProfileManager holds `Map<profileName, {context, process, state}>`. Each is its own
Camoufox process and window. Memory is roughly 1 GB per profile.

## The flat tab list

Tab ids are short and stable for the server's lifetime: `1`, `2`, `3`, never reused.

```
tabs_context()
  1  golove      Google Cloud console   https://console.cloud.google.com/…   ← active
  2  golove      Inbox                  https://mail.google.com/…
  3  u-projects  Merge requests         https://gitlab.u.app/…
```

- Every page tool acts on the active tab unless given `tabId`.
- Pages a site opens itself (popups, `target=_blank`, OAuth windows) are registered
  automatically and reported in the reply of the action that opened them.
- A tab closed by the user disappears from the list; if it was active, the reply of
  the next call says so instead of silently switching.

## Shutdown and crashes

| Event | Behaviour |
|---|---|
| `close_browser(profile)` | Close that browser; its tabs leave the list |
| `close_browser()` | Close all browsers |
| MCP stdin closes / SIGTERM / SIGINT | Close all browsers, then exit |
| Browser process dies | Mark profile dead, drop its tabs; next use relaunches; reply names what happened |
| Profile locked by another process | Error: which profile, and that another session or a stale browser holds it |

The server must never leave an orphan Camoufox behind: browsers are children of the
server and are killed on every exit path (the reference spent several releases on this,
see `reference/mcp-camoufox/src/lifecycle.ts`).

## Every call answers within a deadline

Each tool has a timeout. A wedged page answers "did not finish within N s" instead of
hanging the agent. The reference notes Camoufox sometimes never commits a navigation;
`navigate` retries once.
