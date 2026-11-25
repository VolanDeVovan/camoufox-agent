# Profiles

A profile is an identity: one device (fingerprint) and one set of logins, like a
Firefox container. It is not a task or a project.

```
$XDG_DATA_HOME/camoufox-agent/profiles/<name>/     (~/.local/share/... by default)
  mcp-identity.json   the fingerprint, drawn on the first launch
  ...                 everything else is Firefox's own: cookies.sqlite, storage/, ...
```

- The agent uses `default` (or `--default-profile`) unless it needs another identity.
- A name that does not exist is created on first use, and the reply says so and lists
  the existing names, so a typo does not silently fork an identity.
- Names match `[a-z0-9][a-z0-9-]*`. `temp` is a throwaway profile, deleted when its browser closes (with its last tab).
- There is no delete tool: removing a profile is `rm -rf` of its directory.
- Session restore is on, so cookies without an expiry survive a browser restart. The tabs
  it would bring back are stripped from the session store before each launch: a
  relaunched browser starts with one blank tab, not with the tabs it had.

## The rules the agent is given

1. Use `default` unless there is a reason not to.
2. Before logging in somewhere, call `find_session(site)`.
3. A new profile only for another identity, named after the identity.
4. An expired session is renewed by logging in again in the same profile.
5. Two profiles with a session for the same site: pick by name, or ask the user.

## find_session

`find_session(site)` shows which profiles hold cookies or storage for a site: the
hosts, the names of auth-looking cookies and their expiry. It is evidence, not a
"logged in" verdict, and it never shows a value.

- Matching is on the registrable domain: `github` matches `github.com` and its hosts.
- A running profile is read through its live browser; a stopped one from
  `cookies.sqlite` and the session store on disk, without writing to the profile.
- Partitioned cookies, container cookies, anti-bot cookies (`cf_clearance`, ...) and
  analytics cookies do not count.
- `navigate` and `tabs_create` add one line when another profile already holds a
  session for the site. The server never switches profiles by itself.

## Filling a profile from outside

Anything may write into a profile while its browser is not running. That is the whole
interface for bringing in sessions you already have.

[`examples/firefox-import/`](../examples/firefox-import/) is a worked example: it
copies one Firefox container (cookies, session cookies, permissions, optionally
localStorage and IndexedDB) into a profile. What makes the move work:

- origin attributes: `userContextId` is removed, `partitionKey` is kept;
- origin directories are copied to the name without the container suffix and their
  `.metadata-v2` is rewritten;
- the `origin` recorded inside each localStorage and IndexedDB database is rewritten
  too, or the browser refuses to open them;
- cookies bound to the device fingerprint are skipped.

Whether a site accepts the moved session depends on the site: with a Google account,
Gmail opened signed in while the Cloud console asked to verify the sign-in.

[`examples/chrome-import/`](../examples/chrome-import/) does the same for a Chromium
browser profile (Chrome, Chromium, Brave, Edge, Vivaldi, Opera): cookies and,
optionally, localStorage:

- cookie values are decrypted with the browser's key, read from the Secret Service
  (over D-Bus, without libsecret), KWallet or the macOS Keychain; a wrong key is
  detected by the SHA-256 of the host that Chromium puts in front of each value;
- times move from microseconds since 1601 to Firefox's units, SameSite "unspecified"
  becomes Firefox's 256, a CHIPS `top_frame_site_key` becomes a `partitionKey`;
- localStorage is read from Chromium's LevelDB and written as Firefox origin
  directories (`.metadata-v2`, `ls/data.sqlite`, `ls/usage`), from scratch;
- Windows is not supported: Chrome's app-bound encryption only opens in Chrome.

Chromium's IndexedDB is not imported.
