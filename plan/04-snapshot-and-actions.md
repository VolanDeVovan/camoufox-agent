# 04 — Snapshot and actions

## read_page

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
- Output capped with paging (`offset`/`limit`) and an explicit "truncated" line.

Refs live in a registry inside Juggler's isolated world, registered as a custom
Playwright selector engine (`selectors.register(...)`), so nothing is written into
the DOM and the page's scripts cannot see it. Reference implementation:
`reference/mcp-camoufox/src/helpers.ts` (`REF_ENGINE_JS`, `refLocator`, `snapshotPage`).

A ref belongs to one `read_page` of one tab. A stale ref is an error that says
"call read_page again", never a guess.

## Actions report what happened

The main thing that separates a usable server from raw Playwright. After a `computer` click or key and
after `form_input`, the server watches for about a second and answers with one of:

- navigated to URL (title)
- page changed (what: DOM size, text, URL hash)
- opened tab N
- opened dialog "…" and how it was answered
- nothing happened within 1 s

Refusals instead of guesses:

- disabled or hidden element → refused, nothing fired
- element covered by another → names the covering element
- several matches for a text lookup → lists them, does not pick one

## Follow the agent

Any tool that targets a tab other than the visible one selects it in its window
(the window itself never gets OS focus, see 06). The user sees the tab the agent is on.
