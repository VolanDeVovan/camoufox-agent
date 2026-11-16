# 06 — Page interaction

## `read_page` and refs

A short list of what an agent can act on, each with a ref:

```
heading "Sign in" [h1]
textbox "Email" e3
textbox "Password" e4 (secret)
button "Next" e5
link "Forgot password?" e6
```

- Interactive elements and headings only, not the full accessibility tree (Playwright
  MCP's full tree is ~10x the tokens on long pages).
- Labels resolved from `<label for>`, wrapping labels, `aria-labelledby`.
- Visible iframes included with prefixed refs (`f1e3`); open shadow roots included.
- Output capped with paging (`offset` / `limit`) and an explicit "truncated" line.

Refs live in a registry inside Juggler's isolated world, registered as a custom
Playwright selector engine (`selectors.register(...)`), so nothing is written into the
DOM and the page's scripts cannot see it. Reference implementation:
`reference/mcp-camoufox/src/helpers.ts` (`REF_ENGINE_JS`, `refLocator`, `snapshotPage`).

A ref belongs to one `read_page` of one tab. A stale ref is an error that says
"call read_page again", never a guess.

## Actions report what happened

This is what separates a usable server from raw Playwright. After a `computer` click or
key and after `form_input`, the server watches for about a second and answers with one
of:

- navigated to URL (title)
- page changed (what: DOM size, text, URL hash)
- opened tab N
- opened dialog "…" and how it was answered (Dialogs, below)
- nothing happened within 1 s

The reply also names a download the action started (Downloads, below) and a challenge
page it landed on (07-security.md).

Refusals instead of guesses:

- disabled or hidden element → refused, nothing fired
- element covered by another → names the covering element
- several matches for a text lookup → lists them, does not pick one

## Human-looking input

Human-looking input is not a set of tools; it is how every action is performed (D10).
Almost all of it is Camoufox's own behaviour that we enable or configure (its README,
"Hiding automation" and "Automation"). The only code of ours is randomized per-key
delays for key-by-key typing: Camoufox has no built-in typing rhythm, and its
`humanize` covers the cursor only.

| Input | What Camoufox provides | How we use it |
|---|---|---|
| Cursor | `humanize`: trajectories replayed from 2356 recordings of real people; moves coalesced per frame at 125 Hz like a real mouse | Always on; per-move cap lowered to 0.5 s (default 1.5 s) |
| Text into a field (`form_input`, `computer type` on a plain field) | `fill` / `insert_text` paste the text the way a person does: paste shortcut + Firefox's own paste, no system clipboard | Paste is the default |
| Typing key by key (OTP boxes, autocomplete, sites that watch keydown) | Trusted key events through Juggler, with a fixed delay | **Our code:** randomized per-key delays (Gaussian around ~80 ms, as the reference's `humanize_type`) |
| Selects, date / colour inputs, file inputs | Trusted events (`trusted-automation-events` patch) | Used as is |
| Wheel | Notches with native ticks, 100 px each (`wheel-native-ticks` patch) | Used by `computer scroll` (fallback under Camoufox quirks) |
| Drag | `drag` events at the source on each motion, as GTK does | Used as is |

`computer type` pastes by default and takes `per_key: true` for key-by-key typing.

## Camoufox quirks

Found by the reference, each one cost it a release. R11 re-checks them on the pinned
build.

- After the fifth page in a context Camoufox stops firing `load` /
  `domcontentloaded`. Navigation waits for `commit`, then polls `document.readyState`.
- `camoufox.cfg` sets `browser.sessionhistory.max_entries = 0`, which disables
  back / forward. The launch sets it to 50.
- Camoufox sometimes never commits a navigation. On timeout, ask the document where it
  is first; re-issue `goto` only if it is idle. A second `goto` while one is in flight
  breaks both.
- Wheel: the reference found `mouse.wheel()` doing nothing, but Camoufox's README now
  lists native wheel notches (`wheel-native-ticks` patch). `computer scroll` uses the
  wheel; if R11 shows it still does nothing, it falls back to scrolling the container
  under the coordinate from the isolated world.
- A pointer move to y in [0, 1) is never answered by Juggler and wedges the tab: all
  pointer moves clamp y to >= 1.

## Dialogs

Every alert / confirm / prompt must be answered, or the page hangs. Without an armed
answer (`handle_dialog`), the default is dismiss, and the reply of the action that
caused it says so, with the dialog's text.

## Downloads

`acceptDownloads` is on. Files go to `$XDG_DOWNLOAD_DIR/camoufox-agent/` (fallback
`~/Downloads/camoufox-agent/`), not Playwright's temp folder, which is deleted with the
context. The reply of the action that started a download says
"downloaded <name> (<size>) to <path>".

## Deadlines

Every tool has a timeout. A wedged page answers "did not finish within N s" instead of
hanging the agent.
