# 08 — Research before building

Questions only a prototype answers. Each blocks part of the design.

| # | Question | Blocks | How to test |
|---|---|---|---|
| R1 | Can container storage be moved to the default context? Rename `^userContextId=N` dirs + rewrite `.metadata-v2` + drop `storage.sqlite` so QuotaManager rebuilds it — does Firefox accept it? Alternative: keep the userContextId and make Playwright browse in it | 05 sync of localStorage/IndexedDB | Copy one origin (e.g. a site with IndexedDB login state) both ways, launch Camoufox, read `localStorage` / `indexedDB.databases()` |
| R2 | Does Camoufox 158 read storage and cookies written by Firefox 160, or reset them? | 05 | Same experiment; watch for reset (empty store, recreated files) |
| R3 | Is `playwright-core` <1.63 OK with Node 22 and current MCP SDK; does camoufox-js work from nix without its download step? | 07 | Minimal launch script |
| R4 | Camoufox window app-id on niri; does selecting a tab (follow-the-agent) raise or focus the window? | 06 | Headed launch, `niri msg windows`, select tabs while typing elsewhere |
| R5 | Firefox DevTools (F12) usable in Camoufox headed window? | User-facing debugging | Press F12 |
| R6 | Do Google sessions survive the move to a different fingerprint, or does Google sign the profile out? | Value of the whole sync for Workspace accounts | Sync golove, open Gmail and Cloud console |
| R7 | Can two profiles run side by side without the camoufox-js launcher clashing (temp dirs, ports)? | 02 multi-profile | Launch two persistent contexts in one process |

Order: R3 → R1/R2 (one experiment) → R6 → R4/R5/R7.
