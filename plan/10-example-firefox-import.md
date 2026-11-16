# 10 — Example: importing a Firefox container

Copying the user's own browser sessions into a profile is left to whoever installs the
harness (D5). The only interface is the profile directory (02-profiles.md, On disk).
The repo ships one worked example, `examples/firefox-import/`, that copies a Firefox
container (or the no-container jar) into a profile. It is not published with the
package, has no CLI contract and no support promise: copy it, adapt it, run it from
your own scripts.

This file lists what the example has to deal with.

Chromium browsers would need a different importer: cookies are encrypted with a key
from the system keyring, and localStorage / IndexedDB are LevelDB that Firefox cannot
read, so only cookies (and localStorage through the page API) could move.

## What is copied

Container N's data is everything stored with origin attributes `^userContextId=N`.
"No container" is userContextId 0 (no suffix).

| Store | Source | Method |
|---|---|---|
| Cookies (persistent) | `cookies.sqlite`, rows by `originAttributes` | Row copy via SQL, `userContextId` stripped, `partitionKey` kept |
| Session cookies, sessionStorage | `sessionstore-backups/recovery.jsonlz4` | Decode mozlz4, take the container's entries |
| localStorage | `storage/default/<origin>^userContextId=N/ls/` | File copy into `storage/default/<origin>/` |
| IndexedDB | `storage/default/<origin>^userContextId=N/idb/` | File copy |
| Cache API, service workers | `storage/default/<origin>^userContextId=N/cache/`, `serviceworker.txt` | File copy (v2?) |
| Site permissions | `permissions.sqlite` | Row copy |

Skipped: HTTP cache (`~/.cache/mozilla`), history, bookmarks, passwords (`logins.json`
/ `key4.db`), extensions, prefs. Cookies bound to the fingerprint are dropped:
`cf_clearance`, `__cf_bm`, `_cfuvid` (list to grow).

Source size here: `storage/` is 2.2 GB over ~1080 origins for all containers. A
per-container copy is smaller but not tiny, so copying only cookies + localStorage is a
sensible default.

## Reading a live profile

The user's Firefox is usually running. SQLite files are read with the backup API
(a consistent snapshot including the WAL), never copied raw. Storage directories are
copied as they are; an origin being written during the copy may come out
inconsistent. Known risk, accepted for v1.

## Container → default context

Data in the agent's profile has to live under userContextId 0, because Playwright's
persistent context browses in the default context. Renaming directories is not enough:
each origin directory has a `.metadata-v2` file, and QuotaManager keeps
`storage.sqlite`; both record the origin with its attributes. R1 tests the rewrite.

## Firefox versions

The user's Firefox is 160, Camoufox is 158: storage written by a newer Firefox, read by
an older one. Firefox may reset a store whose schema is newer than it knows. R2 tests
it. Fallback: row-level copy of cookies and localStorage only, which we fully control.
