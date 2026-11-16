# 07 — Packaging

## Browser binary

`camoufox-js` downloads Camoufox from GitHub releases into a cache on first use.
Under nix we want the binary pinned and present before the first call:

- Option A: fixed-output derivation fetching the release tarball, `autoPatchelfHook`
  (or rely on nix-ld, already enabled on the desktop), path passed to camoufox-js
  via `CAMOUFOX_EXECUTABLE_PATH` / `executable_path`.
- Option B: let camoufox-js download at runtime (simplest, not reproducible).

Start with B for the prototype, move to A before wiring into the flake.

Identity per profile: the fingerprint is drawn on first launch and stored in the
profile directory, so a profile is the same device every time (reference:
`src/identity.ts`).

## Package

`buildNpmPackage` in this repo's `flake.nix`, exposing one binary:

```
camoufox-agent mcp [--default-profile NAME] [--headless]
camoufox-agent sync ...
```

## Wiring into the nixos flake

- Flake input pointing at this repo.
- MCP server registered in `parts/modules/home/common/claude-code.nix`, desktop only.
- niri window rule for the Camoufox window (06).
- Skill shipped alongside (below).

## Skill

`skills/camoufox-agent/SKILL.md`, rules in the spirit of the claude-in-chrome skill:

- Use this browser for anything needing a login or a real browser.
- Pick the profile by task (`tabs_context` shows running profiles; `camoufox-agent sync --list` shows what exists); missing or logged-out
  profile → run `camoufox-agent sync --container …` via Bash, then retry.
- `read_page` after every navigation; act by ref or by coordinates from a screenshot.
- Do not trigger `alert()`-style dialogs without arming `handle_dialog`.
- Never call sync for a profile that is open (close it first).
