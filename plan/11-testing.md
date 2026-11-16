# 11 — Testing

**No tests for the sake of tests.** A test earns its place by guarding something that
matters: behaviour the agent or the user relies on, a bug that already happened, or a
security property. No tests that restate the implementation, check formatting for its
own sake, cover trivial getters, or exist to raise a coverage number. Before adding a
test, name what breaks for a user if it fails; if nothing does, do not add it.

## What is worth testing

| Area | Why it matters | Kind |
|---|---|---|
| Daemon lifecycle: one daemon under a start race, idle exit, no orphan Camoufox on any exit path, relaunch after a browser crash | Orphans and double launches are the failures the reference spent releases on (03) | Integration |
| Tabs across sessions: each session sees only its tabs; two sessions in one profile; a closed tab is reported, not silently switched | Core of the daemon model (04) | Integration |
| Action replies: navigated / changed / opened tab / dialog / download / nothing; refusals for disabled, hidden, covered elements | What separates this from raw Playwright (06) | Integration, local fixture pages |
| Camoufox quirks: navigation after the 5th page, back/forward, wheel, y in [0,1) | Each one silently broke the reference (06) | Integration, regression |
| `find_session`: live vs on-disk read, partitioned and anti-bot cookies excluded, eTLD+1 matching, leftover `-wal` | Wrong answers send the agent to the wrong profile (02) | Unit (fixture `cookies.sqlite`) + integration |
| Security: cookies never cross origin on redirects, upload path limits, profile name validation, secrets masked in every tool that can show them | Real sessions are at stake (07) | Unit + integration |
| MCP surface: the server starts over stdio, lists its tools, a navigate + read_page round trip works | The package actually works as installed | Smoke |

Not automated: focus and compositor behaviour (04) and rendering of a hidden window
depend on the desktop; they are checked by hand from a short checklist when that code
changes.

## How

- Integration tests run a real Camoufox against pages served by a local HTTP server
  in the test suite. No external sites: results must not depend on the network or on
  a site's anti-bot mood.
- No mocking of Playwright or Camoufox: a mocked browser tests the mock.
- Every bug fixed gets a regression test that failed before the fix.
- A flaky test is a bug in the code or the test, fixed, never retried or skipped.
- `pnpm test` runs everything that needs no display (headless); headed checks are
  separate. It runs the same with or without Nix (08).
