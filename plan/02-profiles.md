# 02 — Profiles

The main flow needs nothing set up: the agent uses the browser the way it would use
Claude in Chrome, in the `default` profile, and logs in where it needs to. Logins stay
in the profile for next time.

## What a profile is

- An identity: one device (fingerprint) and one set of logins, like a Firefox
  container or a Chrome profile. Not a task, not a project.
- Fully the agent's: it creates profiles, logs in and out, whatever the task needs.
- How a profile got its contents (the agent logged in, the user logged in by hand in
  the visible window, the user's own import script filled it) does not matter and is
  not tracked. There is no metadata file: the name is the description.
- Technically: one persistent Camoufox profile directory, run by one browser process
  (D2; process handling in 03-lifecycle.md).

## Names, creation, removal

- `profile` is an optional tool argument; without it the server uses
  `--default-profile NAME` (default: `default`).
- A profile that does not exist is created empty on first use, `default` and named
  ones alike. Creation is announced (see "What the agent sees").
- Names match `[a-z0-9][a-z0-9-]*`, since they become directory names.
- `temp` is reserved: a fresh throwaway profile, deleted on close. It exists for the
  rare clean-session check and is not part of the normal flow.
- No delete tool: removing a profile is the user's call (`rm -rf` the directory).

## On disk

A profile is a plain Firefox profile directory plus one file of ours. The directory
name is the profile name.

```
$XDG_DATA_HOME/camoufox-agent/profiles/<name>/     (~/.local/share/... by default)
  mcp-identity.json   the fixed fingerprint
  ...                 everything else is Firefox's own: cookies.sqlite, storage/, ...
```

- `--profiles-dir` overrides the root.
- `mcp-identity.json`: the fingerprint is drawn on the profile's first launch and
  stored here, so a profile is the same device every time. What is stored is the
  launcher's own input (an fpgen fingerprint); the launcher derives fonts, voices, GPU
  parameters and noise seeds from it deterministically, so two launches of a profile
  produce the same Camoufox config.
- `temp` lives in the system temp directory, not under the root.
- Anything may write into a profile while its browser is not running (Firefox's
  `parent.lock` tells). That is the whole interface for filling profiles from outside;
  the server neither knows nor cares who did it. A worked example:
  10-example-firefox-import.md.

## Rules for the agent

These go into the skill (08-packaging.md).

1. Use `default` unless there is a reason not to.
2. Before logging in somewhere, call `find_session(site)`. A hit is a candidate, not a
   verdict: open the tab in that profile and check the page before acting.
3. A new profile only for another identity: a second account on a site where one is
   already logged in, or when the user asks. Name it after the identity
   (`github-bot`, `rozetka-test`), never after the task.
4. An expired session is renewed by logging in again in the same profile, not in a
   new one.
5. Two profiles with a session for the same site: pick by name, or ask the user.

## What the agent sees

### `tabs_context`

Lists every profile on disk, running or stopped, next to the session's flat tab list
(04-tabs-and-window.md), so all identities are visible without another call.

### `tabs_create(url, profile)` on a new name

Creates the profile and says so, with the existing names, so a typo does not silently
fork an identity:

```
Created new profile "defualt". Existing: default, golove, rozetka-test.
```

### `find_session(site)`

`site` is a domain or a bare name. Matching is on the registrable domain (eTLD+1), so
`cloudflare` matches `cloudflare.com` and its hosts but not `cloudflareinsights.com`;
the reply shows which hosts matched. It gives evidence, not a "logged in" verdict:

```
cloudflare.com:
  golove
    dash.cloudflare.com   9 cookies, auth-looking: vses2, CF_Authorization; latest expiry in 23 d
                          localStorage yes, IndexedDB no
  default
    cloudflare.com        2 cookies, none auth-looking
  nothing in: work, rozetka-test
```

### Hint in `navigate` / `tabs_create`

Rule 2 relies on the agent remembering. As a safety net, when the target domain has no
cookies in the current profile and another profile has auth-looking ones, the reply
gets one extra line:

```
Note: golove has cookies for dash.cloudflare.com (CF_Authorization, vses2) —
tabs_create(url, profile="golove") to use that session.
```

The server never switches profiles by itself.

## How `find_session` is computed

- Running profile (in this or another session): `context.cookies()` from the daemon's
  live browser; a running profile is never read from disk.
- Stopped profile: its `cookies.sqlite` read with SQLite read-only — immutable mode
  normally, plain `mode=ro` when a `-wal` file is left over (after a crash, immutable
  mode would ignore recent writes). Results are cached by file mtime, so the hint costs
  next to nothing.
- localStorage / IndexedDB presence comes from the origin directories under
  `storage/default/`.
- Excluded: partitioned cookies (`originAttributes` with `partitionKey`, e.g.
  `challenges.cloudflare.com` inside other sites) and non-default `userContextId`.
  Without this, every profile that ever passed a Cloudflare challenge would "have"
  Cloudflare.
- Anti-bot cookies (`cf_clearance`, `__cf_bm`, `_cfuvid`, `_px*`, `datadome`, ...)
  never count as auth-looking.
- "Auth-looking" is a hint from cookie names (`session`, `sid`, `auth`, `token`,
  `jwt`, `login`, ...). `__Secure-` / `__Host-` prefixes and HttpOnly+Secure do not
  count on their own, since plenty of non-auth cookies have them. Names are always
  shown so the agent judges; values never are.
- Expired cookies are ignored; a site whose cookies all expired reads
  "session expired 3 d ago".
- Apps that keep their token in localStorage show "storage yes, cookies none"; the
  agent decides.

R12 checks the crashed-profile and live-profile cases.
