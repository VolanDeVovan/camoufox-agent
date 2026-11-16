# CLAUDE.md

camoufox-agent: an MCP server that gives coding agents a Camoufox browser. The design
spec is `plan/` (start at `plan/README.md`); `reference/` holds a cloned reference
implementation (gitignored, read-only).

## Working rules

- **Commit iteratively.** One feature or fix at a time: build it, test it, commit
  it, then start the next. Never pile up a day of work into one commit at the end.
  Each commit builds and passes `pnpm test`.
- **Keep the spec true.** A change that alters the design updates `plan/` in the same
  commit.
- **Tests only where they matter** (`plan/11-testing.md`): behaviour users rely on,
  past bugs, security. No tests for the sake of tests.
- **No Nix dependency** (`plan/08-packaging.md`): everything works with plain Node
  >= 22.15 and pnpm. `nix develop` is one convenient dev shell, not a requirement.
- Code comments and commit messages in English.

## Commands

```
pnpm install
pnpm build
pnpm test
```
