# 09 — Research before building

Questions only a prototype answers. Each blocks part of the design. Listed in the
order to run them; there is no R10.

| # | Question | Blocks | How to test |
|---|---|---|---|
| R3 | Does the official `camoufox` npm launcher (exact pin) + `playwright-core` <1.63 on Node >= 22.15 launch its downloaded Camoufox here (NixOS runs it via nix-ld)? Do 1.61 / 1.62 launch (the reference stopped at <1.61 over an `isMobile` schema rejection)? | Everything | Minimal launch script in `nix develop` |
| R4 | Camoufox app-id; does a new window take focus with no compositor rule; does selecting a tab (follow-the-agent) raise or focus the window; does `window.open` from the isolated world open a tab, not a window? | 04 focus rules, opening tabs | Headed launch, `niri msg windows`, type elsewhere while tabs are opened and selected |
| R9 | Unfocused / other-workspace window: do screenshots, rAF, timers and humanized moves stall; which prefs fix it? | 04 rendering; every tool on a hidden window | Scripted session with the window on another workspace |
| R11 | On the pinned build: `load` events after the 5th page, `sessionhistory.max_entries`, `mouse.wheel` (README says fixed, reference says broken), y in [0,1) hang | 06 Camoufox quirks | One small script per quirk |
| R7 | Two profiles side by side in one daemon (temp dirs, ports, launcher state); two sessions with tabs in one profile | 01 daemon, 03 several profiles | Two persistent contexts, two clients |
| R12 | `find_session` on a stopped profile whose browser crashed (leftover `-wal`); reading a running profile through the live context | 02 `find_session` | Kill a browser, scan; scan while running |
| R8 | Does session restore keep session cookies under Juggler, and can restored tabs be closed cleanly at launch? | 03 session cookies, 02 `find_session` | Log in with session cookies, close, reopen |
| R5 | Firefox DevTools (F12) usable in the headed window? | User-facing debugging | Press F12 |
| R1 | Can container storage be moved to the default context? Rename `^userContextId=N` dirs + rewrite `.metadata-v2` + drop `storage.sqlite` so QuotaManager rebuilds it — does Firefox accept it? | 10 example importer only | Copy one origin with IndexedDB login state, launch, read `localStorage` / `indexedDB.databases()` |
| R2 | Does Camoufox 158 read storage and cookies written by Firefox 160, or reset them? | 10 example importer only | Same experiment |
| R6 | Do Google sessions survive the move to a different fingerprint? | Usefulness of the example importer | Import a container, open Gmail and Cloud console |

Order: R3 → R4 + R9 → R11 → R7 + R12 → R8 → R5 → R1 / R2 / R6 (only the example
importer depends on the last three).

## Results

Measured on NixOS (nix-ld), niri, Node 25.9, `camoufox` 0.5.9 (browser
158.0.1-beta.41), `playwright-core` 1.62.1. Scripts: `research/`.

| # | Answer |
|---|---|
| R3 | Launches. `launchOptions()` from the pinned launcher + `firefox.launchPersistentContext` on playwright-core 1.62.1 works headless and headed, ~1.8 s. No `isMobile` rejection on 1.62. Without `os`, the launcher draws any OS; we pass the host's. |
| R4 | App-id is `camoufox`. `ignoreDefaultArgs: ["-foreground"]` drops Playwright's flag; the window then opens without focus on niri with no rule. `window.open("about:blank", "_blank", "noopener,noreferrer")` from the isolated world opens a tab in the same window (no new toplevel). `page.bringToFront()` selects the tab without focusing or raising the window on Wayland, so follow-the-agent stays, on Wayland only. Caveat: measured while the monitors were in DPMS-off (a lock overlay held keyboard focus), so "a new toplevel never takes focus" is confirmed only for that state; the README documents the optional niri rule. New finding: a tab opened that way dies when navigated to a `data:` URL; http(s) and about: are fine. |
| R9 | On a hidden workspace or with the screen off: screenshots (~35 ms), timers and humanized mouse moves work; background tabs report `visibilityState: visible`. Only `requestAnimationFrame` stalls (1–2 fps). `widget.wayland.vsync.enabled = false` together with the background-timer prefs brings rAF back to 60 fps in every state; the launch sets them. |
| R11 | All four reference quirks are fixed on this build: `load` fires after the 5th page (8 more pages tested), back / forward works even with the stock `max_entries`, `mouse.wheel` scrolls, a pointer move to y = 0.5 is answered. The defensive code stays where it is cheap (commit + `readyState` poll, y clamp, `max_entries = 50`); the wheel fallback is not built. |
| R8 | With `browser.startup.page = 3` and the sessionstore prefs, a cookie without expiry survives close + relaunch; without them it is gone. Under Juggler no restored tab shows up at launch (one `about:blank`); the launch still closes any extra page. |
| R7, R12 | Answered by the integration tests (two profiles in one daemon, two sessions in one profile, `find_session` live and after a crash). |
| R5 | Not automated; F12 is a manual check. |
| R1, R2, R6 | Only the example importer depends on them; see `examples/firefox-import/README.md`. |
