# 03 — Browser lifecycle

## Lazy launch

There is no `launch` tool. A tool that needs a page asks for the session's active tab;
if there is none, the default profile is launched (or joined, if another session
already runs it) and a blank tab opened.

```
navigate("https://x")          this session has no tab
  → daemon (started if needed) → ProfileManager.ensure(default)   launch ~2 s, or reuse
  → TabRegistry: tab 1, owned by this session, active
  → navigate
```

`tabs_create(url, profile="golove")` launches `golove` if it is not running.

`ensure()` claims the launch slot synchronously, before any await: tool calls arrive
concurrently, and two launches would otherwise build two contexts on one profile.

Why the reference needs an explicit `browser_launch` and we do not: its options change
per call (headless, fingerprint OS, locale, geoip, window size, temp profile, uBlock),
and its first launch downloads the browser and answers "downloading, 40%, call again".
Our launch options are fixed per profile. The first download still happens
(08-packaging.md): until the browser is ready, any tool answers with the progress.

## Launch configuration

Server config, not tool arguments; the same for every launch.

- Fingerprint: drawn once per profile and stored in it (02-profiles.md). Its OS is the
  host's: Camoufox noises canvas only for a foreign OS, and the reference measured a
  foreign OS as slower to start and ~450 MB heavier.
- uBlock Origin (bundled): on. ~350 MB more memory and slower first navigations on a
  fresh profile, in exchange for fewer trackers and ads in what the agent reads.
- `humanize` with a 0.5 s cap (06-page-interaction.md).
- `main_world_eval: true` (needed by `javascript_tool` in the main world, 05-tools.md).
- `browser.sessionhistory.max_entries = 50` (06-page-interaction.md, Camoufox quirks).
- Session restore prefs (below).
- Headed, without `-foreground`, `no_viewport` (04-tabs-and-window.md).
- `acceptDownloads` on (06-page-interaction.md).

## Several profiles, several sessions

ProfileManager holds `Map<profileName, {context, process, state}>`; each entry is its
own Camoufox process. Memory per profile: ~1.3 GB with uBlock, ~1 GB without (the reference's measurement).

Each Claude session sees and acts on its own tabs only, as in Claude in Chrome's tab
groups (04-tabs-and-window.md). Two sessions can work in the same profile at once: they
share its cookies and logins, each with its own tabs.

R7 checks two profiles side by side and two sessions in one profile.

## Session cookies

Cookies without an expiry die with the browser even in a persistent profile, so a site
logged in a minute ago is logged out after a restart. The launch turns on Firefox
session restore (`browser.startup.page = 3` and related prefs), which keeps them, as a
user's own Firefox does. Restored tabs are closed at launch: sessions own tabs, and
nothing reopens behind their back. R8 verifies this under Juggler.

## Shutdown and crashes

| Event | Behaviour |
|---|---|
| `close_browser(profile)` | Close that browser for everyone; other sessions' tabs in it are reported closed on their next call |
| `close_browser()` | Close the browsers this session has tabs in; browsers other sessions still use stay open |
| MCP server exits | Its tabs are closed; browsers stay for other sessions |
| Last client gone + idle timeout | Daemon closes all browsers and exits |
| Daemon gets SIGTERM / SIGINT | Closes all browsers, removes the socket, exits |
| Browser process dies | Profile marked dead, its tabs dropped; next use relaunches; replies name what happened |
| Profile locked by a process that is not ours | Error: which profile, and that something else holds it |

The daemon never leaves an orphan Camoufox behind: browsers are its children and are
killed on every exit path. The reference needed several releases to get this right;
see `reference/mcp-camoufox/src/lifecycle.ts`.
