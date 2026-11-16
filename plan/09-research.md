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
