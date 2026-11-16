# Example: import a Firefox container into a profile

Not part of the package: no CLI contract, no support promise. Copy it, adapt it, run it
from your own scripts. The only interface camoufox-agent offers for outside data is the
profile directory itself, which anything may write to while that profile's browser is
not running ([docs/profiles.md](../../docs/profiles.md)); this script is one worked
example of using it.

```
# which containers does the Firefox profile have?
node import.mjs --firefox-profile ~/.mozilla/firefox/xxxx.default --list

# copy the "Work" container's cookies into the agent's "work" profile
node import.mjs --firefox-profile ~/.mozilla/firefox/xxxx.default \
                --container Work \
                --target ~/.local/share/camoufox-agent/profiles/work
```

| Option | Meaning |
|---|---|
| `--container NAME\|ID\|none` | Which jar to copy; `none` is everything outside containers (default) |
| `--target DIR` | The camoufox-agent profile directory to fill |
| `--storage` | Also copy localStorage |
| `--idb` | Also copy IndexedDB and the Cache API (implies `--storage`; can be large) |
| `--domains a.com,b.org` | Only these sites and their subdomains |
| `--session-days N` | Lifetime given to cookies that had no expiry (default 30) |
| `--dry-run` | Count what would be copied, write nothing |

Before the first import, let the agent open the target profile once
(`tabs_create(profile="work")`) and close it (`close_browser(profile="work")`): the
cookie database then has the schema of the browser that will read it. The script
refuses to run while the target's browser is running.

## What it does

- Cookies: rows of `cookies.sqlite` whose origin attributes name the container, copied
  by column name with `userContextId` removed and `partitionKey` kept.
- Cookies without an expiry, which live only in Firefox's session store
  (`sessionstore-backups/recovery.jsonlz4`): written as ordinary cookies with a limited
  lifetime.
- Fingerprint-bound cookies (`cf_clearance`, `__cf_bm`, `_px*`, `datadome`, ...) are
  skipped: on another device they are useless at best.
- With `--storage` / `--idb`: the origin directories `storage/default/<origin>^userContextId=N`
  are copied to `storage/default/<origin>`, `.metadata-v2` is rewritten for the default
  context, the `origin` recorded inside each localStorage and IndexedDB database is
  rewritten too (they refuse to open under another origin), and `storage.sqlite` is
  removed so that QuotaManager rebuilds its origin list. An origin the target already
  has data for is left alone.
- Site permissions: rows of `permissions.sqlite`.

Never copied: history, bookmarks, saved passwords, extensions, prefs, the HTTP cache.
Nothing is written to the Firefox profile, and no cookie value is printed.

The Firefox you copy from may be running: its databases are read through a snapshot.
Storage directories are copied as they are, so an origin being written at that moment
may come out inconsistent, and data from the last few seconds may be missing.

## What was verified

- Moving a container's cookies (persistent and session), localStorage and IndexedDB
  into the default context works: Camoufox reads all of them back.
- Firefox 160 and Camoufox 158 use the same schema versions for cookies (17),
  localStorage (80) and IndexedDB (416), so nothing is reset on the way.
- Whether a session survives the move to another device fingerprint depends on the
  site. With a Google account, Gmail opened signed in; the Cloud console asked to
  verify the sign-in with a passkey. Expect sensitive services to ask for one
  re-verification in the profile's window.

For Chrome and other Chromium browsers, see [`chrome-import`](../chrome-import/).
