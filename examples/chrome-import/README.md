# Example: import a Chrome profile into a profile

Not part of the package: no CLI contract, no support promise. Copy it, adapt it, run it
from your own scripts. Like [`firefox-import`](../firefox-import/), it only uses the
interface camoufox-agent offers for outside data: the profile directory, which anything
may write to while that profile's browser is not running
([docs/profiles.md](../../docs/profiles.md)).

Works for the Chromium family: Chrome, Chromium, Brave, Edge, Vivaldi, Opera. Linux and
macOS; not Windows (see below). No dependencies beyond Node >= 22.15.

```
# which profiles does Chrome have?
node import.mjs --chrome-profile ~/.config/google-chrome --list

# copy the cookies of Chrome's "Default" profile into the agent's "work" profile
node import.mjs --chrome-profile ~/.config/google-chrome/Default \
                --target ~/.local/share/camoufox-agent/profiles/work
```

| Option | Meaning |
|---|---|
| `--chrome-profile DIR` | A profile directory (`Default`, `Profile 1`, ...); with `--list`, its user data directory |
| `--target DIR` | The camoufox-agent profile directory to fill |
| `--domains a.com,b.org` | Only these sites and their subdomains |
| `--session-days N` | Lifetime given to cookies that had no expiry (default 30) |
| `--keyring-app NAME` | The keyring entry to take the key from, when it is not recognised from the path |
| `--dry-run` | Count what would be copied, write nothing |

Before the first import, let the agent open the target profile once
(`tabs_create(profile="work")`) and close it (`close_browser(profile="work")`): the
cookie database then has the schema of the browser that will read it. The script
refuses to run while the target's browser is running.

## What it does

- Cookies: every row of `Cookies` (or `Network/Cookies`), decrypted and written to
  `cookies.sqlite` with times, flags and SameSite converted. A CHIPS cookie
  (`top_frame_site_key`) gets the matching Firefox `partitionKey`.
- Fingerprint-bound cookies (`cf_clearance`, `__cf_bm`, `_px*`, `datadome`, ...) and
  expired ones are skipped.

Never copied: history, bookmarks, saved passwords, extensions, settings, the HTTP cache.
Nothing is written to the Chrome profile, and no cookie value is printed.

Chrome may be running: the database is read through a copy, and only the last few
seconds of changes can be missing.

## The key

Chromium encrypts cookie values with AES-128-CBC under a key derived (PBKDF2-SHA1,
salt `saltysalt`) from a password:

- **Linux, `v11`**: a random password stored by the browser in the Secret Service
  (GNOME Keyring, KWallet 6, KeePassXC), under `application=chrome` (`chromium`,
  `brave`, ...). The script reads it over D-Bus itself, with no libsecret: a Secret
  Service session only lives as long as the connection that opened it, so chained
  `gdbus` calls cannot do it. A locked keyring brings up its unlock dialog. KWallet 5
  is tried through `kwallet-query`.
- **Linux, `v10`**: the fixed password `peanuts` (`--password-store=basic`, no keyring).
- **macOS**: the `... Safe Storage` item of the login Keychain, through `security`
  (macOS asks for permission).
- Any platform: the password itself in `CHROME_SAFE_STORAGE_PASSWORD` overrides all of
  the above.

Since cookie database version 24 the decrypted value starts with SHA-256 of the
cookie's host, so a wrong key is detected, not written: such cookies are counted as
"could not be decrypted", and if none can be, nothing is written.

Windows is not supported: since Chrome 127 cookies are encrypted with app-bound
encryption (`v20`), which only Chrome's own elevated service can undo.

## What was verified

- Linux, Chrome with GNOME Keyring, cookie database version 24: all 1489 cookies
  decrypted with the host check passing, written into a Camoufox 158 profile (schema
  17). Vercel, Figma and prom.ua opened signed in.
- Not verified: macOS, KWallet, and the browsers other than Chrome; their keyring
  names follow Chromium's naming and may need `--keyring-app`.

As with Firefox, whether a session survives the move to another device fingerprint
depends on the site: expect sensitive services to ask for one re-verification in the
profile's window.
