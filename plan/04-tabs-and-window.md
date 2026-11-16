# 04 — Tabs and window

Claude in Chrome works inside the user's own window, so switching tabs moves what the
user is looking at. Here the agent has its own window per profile, and one rule wins
over everything else in this file: the agent's window never takes OS keyboard focus.

## The tab list

Each session sees one flat list of its own tabs across all profiles (D3). Tab ids are
short and stable for the daemon's lifetime: `1`, `2`, `3`, never reused.

```
tabs_context()
  tabs (this session):
    1  golove      Google Cloud console   https://console.cloud.google.com/…   ← active
    2  golove      Inbox                  https://mail.google.com/…
    3  u-projects  Merge requests         https://gitlab.u.app/…
  profiles: default (running), golove (running), u-projects (running), rozetka-test
```

- Every page tool acts on the session's active tab unless given `tabId`. The active
  tab is the one the session last created or targeted; agents working in parallel in
  one session pass `tabId` on every call.
- Pages a site opens itself (popups, `target=_blank`, OAuth windows) belong to the
  session whose tab opened them, and are reported in the reply of that action.
- A tab closed by the user disappears from the list; if it was active, the reply of the
  next call says so instead of silently switching.
- Tabs the user opens by hand in the agent's window belong to no session;
  `tabs_context` lists them, and a session adopts one by passing its id as `tabId`.
- Closing the last tab of a window would close the window, and the next tab would need
  a new toplevel. The last tab is parked instead: emptied to `about:blank`, owned by
  nobody, and handed to whoever opens the next tab in that profile.

## Opening tabs

One window per profile; new tabs open beside the active one, inside it. Juggler's
`Browser.newPage` always opens a new window (a focus risk each time), so tabs are
opened with `window.open(..., "noopener")` from the isolated world, as the reference
does (`openTabBeside`). `tabs_create` into a profile with no window yet opens its first
window. R4 checks that `window.open` from the isolated world gives a tab, not a window.

## Focus rules

1. Headed by default; the `--headless` server flag covers the other case.
2. Launch without `-foreground`. Playwright adds it to headed Firefox and it raises the
   window; the reference measured 5.4 s of stolen focus, 0 after dropping it.
3. Tabs open inside the profile's window, never through `Browser.newPage` (above).
4. The daemon never activates a window (the one exception is rule 5, where it is
   measured to be harmless).
5. Follow the agent: a tool that targets a tab other than the one the daemon last
   showed selects it in its window, so the user sees the tab the agent is on. R4
   measured this on Wayland: selecting a tab neither focuses nor raises the window.
   It is the one place `page.bringToFront()` is called, and only on Wayland; elsewhere
   the agent works in background tabs and the user switches tabs by hand. A tab the
   user selected by hand stays selected until the agent moves to another tab.
6. Pages cannot steal focus on Wayland without an xdg-activation token.

## Compositor

Depending on the compositor, a new toplevel may get focus. R4 measures what happens
with no window rule and finds Camoufox's app-id; the project README then documents an
optional user-side rule for compositors that need it (niri: `open-focused false` on the
Camoufox app-id). The project does not depend on it.

## Unfocused windows and rendering

The normal state of the agent's window is unfocused, often on another workspace. On
Wayland a hidden window gets no frame callbacks, and Firefox throttles occluded windows
and background tabs: screenshots, `requestAnimationFrame`, timers and humanized moves
may stall. R9 measures it. Candidate fixes: prefs that disable background / occlusion
throttling, or rendering screenshots without the compositor.

## Viewport

`no_viewport` in headed mode: the page follows the window size as the user resizes it.
The fingerprint's screen is drawn by the launcher's own rule, bounded by the largest
display, and kept coherent with the window by the launcher (`clampScreenToDisplay`,
`clampWindowDimensions`); we add nothing on top.
