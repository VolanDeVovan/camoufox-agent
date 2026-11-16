# 06 — Window and focus

Claude in Chrome works inside the user's own window, so switching tabs moves what
the user is looking at. Here the agent has its own window per profile; the only rule
is that it must never take OS keyboard focus.

## Rules

1. Headed by default. `--headless` server flag for the other case.
2. Launch without `-foreground`: Playwright adds it to headed Firefox, and it raises
   the window (the reference measured 5.4 s of stolen focus → 0 after dropping it).
3. The server never calls `page.bringToFront()` or anything that activates the window
   at OS level. Selecting a tab inside the window (follow-the-agent, 04) must use a
   path that does not raise the window — to verify (08-research.md R4).
4. Compositor side (niri, in the nixos flake): window rule `open-focused false` for
   the Camoufox app-id, so a new window opens unfocused. App-id to be read on first
   launch (R4).
5. Pages cannot steal focus on Wayland without an xdg-activation token.

## Viewport

`no_viewport` in headed mode: the page follows the window size as the user resizes
it, and the fingerprint's screen is at least as large as the largest display, so a
resized window never exceeds its claimed screen (reference: `src/display.ts`).
