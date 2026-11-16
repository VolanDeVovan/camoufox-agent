# Development

```
pnpm install
pnpm build
pnpm test
```

Needs Node >= 22.15 and pnpm; nothing depends on Nix. `nix develop` gives a shell with
both, and `nix build` builds the package with the browser pinned in the Nix store.

## Stack

- TypeScript on Node, `@modelcontextprotocol/sdk`, `zod`.
- `playwright-core` and the official `camoufox` npm launcher, both pinned exactly:
  each launcher release is paired with one browser build.
- `node:sqlite` and `tldts` for `find_session`; `impit` for HTTP with Firefox's TLS
  fingerprint.

## Tests

Tests exist where they guard something that matters: behaviour the agent or the user
relies on, a bug that already happened, or a security property.

- Integration tests run a real headless Camoufox against pages from a local HTTP
  server. No external sites, no mocked browser.
- Every bug fixed gets a regression test (`test/regressions.test.ts`).
- `test/security.test.ts` calls every tool on a page that leaks secrets through every
  channel and checks none appears without `reveal_values`.
- A flaky test is a bug in the code or the test; it is fixed, not retried.

Focus, window and rendering behaviour depend on the desktop and are checked by hand
with the scripts in `research/` (they need a Wayland session with niri):
`headed-check.mjs`, `focus-check.mjs`, `r5-devtools.mjs`.

## Releasing

Pushing a tag `v*` runs `.github/workflows/release.yml`, which builds the package and
attaches the tarball to a GitHub release, so it installs with
`npx -y <release URL>/camoufox-agent.tgz`. The package is not on npm yet.

When the `camoufox` launcher is bumped, bump `browserVersion` and its hash in
`flake.nix`; when the lockfile changes, update the `pnpmDeps` hash there.
