# Tools

| Group | Tools |
|---|---|
| Core (as in Claude in Chrome) | `tabs_context` `tabs_create` `tabs_update` `tabs_close` `navigate` `read_page` `find` `form_input` `computer` `get_page_text` `javascript_tool` `read_console_messages` `read_network_requests` `browser_batch` `file_upload` `resize_window` |
| Profiles | `find_session` `close_browser` |
| Network | `get_network_request` `wait_for_network` `block_requests` `export_har` `export_curl` |
| HTTP | `http_request` `fetch_markdown` `extract_table` |
| Wait | `wait_for` `handle_dialog` |
| Storage | `cookies` `web_storage` |
| Anti-bot | `detect_anti_bot` `fingerprint_audit` |

Every page tool takes an optional `tabId`. An argument a tool does not take is an
error, never silently ignored. Differences from Claude in Chrome: it is the
agent's own browser, `find` is a literal text match, and there is no GIF recording.

`javascript_tool` returns the value of the last expression; a script body with a
top-level `return` is a syntax error as is, so it is run again inside an async function.

## Refs

`read_page` lists interactive elements and headings, each interactive one with a ref:

```
heading "Sign in" [h1]
textbox "Email" e3
textbox "Password" e4 (secret)
button "Next" e5
```

- Visible iframes are included with prefixed refs (`f1e3`); open shadow roots too.
- Refs live in a registry inside the browser's isolated world, so nothing is written
  into the page and its scripts cannot see it.
- An element keeps its ref while it exists. Refs are numbered per tab and never
  reused; a stale ref is an error that says "call read_page again", never a guess.
- `find` gives refs to text and headings as well.

## Actions say what happened

After a click, a key press or `form_input` the daemon watches the page for about a
second and answers with one of: navigated, page changed (and what), opened tab N,
dialog (and how it was answered), download, nothing happened, or could not tell.

Refusals instead of guesses: a disabled, hidden or covered element is not clicked,
and the reply names what covers it.

- Typing pastes by default; `per_key: true` types key by key with human-like delays.
  Cursor movement is humanized by Camoufox itself.
- A dialog is dismissed unless `handle_dialog` armed an answer first.
- Downloads go to `$XDG_DOWNLOAD_DIR/camoufox-agent/`.
- Every tool has a deadline; a wedged page answers "did not finish within N s".

## Screenshots and coordinates

`computer(screenshot)` returns the viewport downscaled to what the model actually
sees. Coordinates the agent passes afterwards are in that image's pixels and are
mapped back to the page.

## Security

- Page content is untrusted: replies carrying it are marked as data, and the server's
  instructions tell the agent never to follow instructions found in it.
- Secrets are masked in tool output by default: cookie values, `Authorization`,
  `Set-Cookie`, tokens in URLs and bodies, password fields. `reveal_values=true` shows
  them. `javascript_tool` returns what the script returns, unmasked.
- `http_request` and `fetch_markdown` send a profile's cookies only to their own
  origin, recomputed on every redirect hop.
- `file_upload` takes relative paths under the session's working directory; a file
  elsewhere needs an absolute path, which the reply echoes.
- On a challenge page `navigate` and click replies say so, and the agent hands over to
  the user.
