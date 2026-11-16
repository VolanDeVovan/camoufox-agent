# 05 — Sync

A CLI that builds an agent profile from the user's Firefox profile. One-way,
read-only on the source. The MCP server does not know it exists.

## Interface

```
camoufox-agent sync                                  # no container → profile "default"
camoufox-agent sync --container golove               # → profile "golove"
camoufox-agent sync --container golove --profile gw  # → profile "gw"
camoufox-agent sync --source ~/.config/mozilla/firefox/other
camoufox-agent sync --only cookies,localstorage      # narrow what is copied
camoufox-agent sync --list                           # containers in the source, profiles on disk
```

- Container by name (from `containers.json`) or by id.
- Source profile: autodetected from `profiles.ini` (default profile), `--source` overrides.
- Refuses when the target profile is open in a running browser (its `parent.lock`).
- Replaces the target profile's copied data; agent-made changes in those stores are lost.

Scenarios are the user's: a dedicated "camoufox" container in Firefox, one profile
per container, only the default jar — the CLI does not prescribe one.

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

Source size here: `storage/` is 2.2 GB over ~1080 origins for all containers, so
per-container copies are smaller but not tiny; `--only` matters.

## Reading a live profile

The user's Firefox is usually running. SQLite files are read with the backup API
(consistent snapshot including the WAL), never copied raw. Storage directories are
copied as-is; an origin being written during the copy may come out inconsistent.
Known risk, accepted for v1.

## Container → default context

Data in the agent profile has to live under userContextId 0, because Playwright's
persistent context browses in the default context. Renaming directories is not
enough: each origin directory has a `.metadata-v2` file and QuotaManager keeps
`storage.sqlite`, both recording the origin with its attributes. See 08-research.md R1.

## Versions

The user's Firefox is 160, Camoufox is 158: storage written by a newer Firefox read
by an older one. Firefox may reset a store whose schema is newer than it knows. See
08-research.md R2. Fallback: row-level copy for cookies and localStorage only, which
we fully control.
