# 05 — Tools

The core mirrors Claude in Chrome's tool set: same names (without the `_mcp` suffix),
same shapes where they make sense (D8). The model already knows that interface, and the
claude-in-chrome skill rules carry over almost unchanged. Groups of tools from the
reference sit on top. It is one fixed set: no flags turn groups on or off (D9).

Claude Code defers MCP tool schemas and loads them through ToolSearch, so the number
of tools costs little context until a tool is used. The real costs of a large set are
the agent choosing between near-duplicates, and code to maintain; both guided what was
left out.

Common arguments:

- Every page tool takes `tabId`; ids come from `tabs_context` (04-tabs-and-window.md).
- Clicks, typing, key presses and `form_input` take `action_summary` (a few words on
  what the action does), as in Chrome, so the user reads intent in the transcript.
- Output masks secrets unless `reveal_values=true` (07-security.md).

Every click / key reply says what the page did, including tabs, dialogs and downloads
it triggered (06-page-interaction.md).

## Core — Claude in Chrome parity

| Tool | Chrome equivalent | Notes |
|---|---|---|
| `tabs_context` | `tabs_context_mcp` | This session's tabs across profiles (id, profile, title, url, active) and profiles on disk, running / stopped; `createIfEmpty` |
| `tabs_create` | `tabs_create_mcp` | `url?`, `profile?` — launches the profile if needed; on a new name says it created one and lists existing names (02) |
| `tabs_close` | `tabs_close_mcp` | |
| `navigate` | `navigate` | `url`, or `"back"` / `"forward"` / `"reload"` |
| `read_page` | `read_page` | `filter: interactive \| all`, `ref_id` for a subtree, `max_chars`, `offset` / `limit` paging; refs in 06 |
| `find` | `find` | By text, label, placeholder, role; returns every match with refs. Chrome's is natural-language, ours is literal (see Gaps) |
| `form_input` | `form_input` | `ref`, `value` (string / boolean for checkboxes / option for selects) |
| `computer` | `computer` | `left_click` `right_click` `double_click` `triple_click` (coordinate **or** ref, `modifiers`), `type` (pastes; `per_key: true` types key by key, 06; an optional `ref` is clicked first), `key` (+`repeat`), `scroll`, `scroll_to`, `left_click_drag`, `hover`, `screenshot` (+`scale`), `zoom`, `wait`. Coordinates are in pixels of the last screenshot (06) |
| `get_page_text` | `get_page_text` | |
| `javascript_tool` | `javascript_tool` | `world: main` (default, like Chrome) `\| isolated`. The value of the last expression is returned, promises awaited. The main world needs `main_world_eval: true` at launch and the `mw:` prefix; it cannot return handles. Output is not masked (07) |
| `read_console_messages` | `read_console_messages` | `pattern`, `level`, `clear`; capture on from launch |
| `read_network_requests` | `read_network_requests` | `pattern`, `since`; capture on from launch |
| `browser_batch` | `browser_batch` | Sequential, stops at the first error; every step is validated against its tool's schema before anything runs |
| `file_upload` | `file_upload` | `ref`, `paths[]` (path limits in 07) |
| `resize_window` | `resize_window` | Window size; the fingerprint's screen stays larger (04) |

## Profiles (not in Chrome)

| Tool | Notes |
|---|---|
| `find_session` | `site` → which profiles hold cookies / storage for it, likely-auth cookie names, expiry (02) |
| `close_browser` | `profile?`; without it, the browsers this session has tabs in (03) |

`navigate` and `tabs_create` also add a one-line hint when another profile holds a
session for the target site (02-profiles.md).

## Group `network`

| Tool | Notes |
|---|---|
| `get_network_request` | Headers + text bodies of one captured request by id |
| `wait_for_network` | Wait for a request or response matching a pattern; returns it |
| `block_requests` | Block by resource type / URL pattern (images, fonts, trackers); `off` to stop |
| `export_har` | HAR 1.2 file, mode 0600 |
| `export_curl` | One request as a `curl` command |

## Group `http`

| Tool | Notes |
|---|---|
| `http_request` | HTTP with Firefox's TLS fingerprint (`impit`), sending the profile's cookies for that URL (origin-scoped, 07) |
| `fetch_markdown` | URL → clean markdown, no browser; `use_browser` for JS pages |
| `extract_table` | HTML table on the page → JSON rows |

## Group `wait`

| Tool | Notes |
|---|---|
| `wait_for` | Text appears / text gone / selector / URL / "page changed" / network idle; first match wins; timeout is an error |
| `handle_dialog` | Answer for the next alert / confirm / prompt, or a standing rule (06) |

## Group `storage`

| Tool | Notes |
|---|---|
| `cookies` | List / set / delete |
| `web_storage` | localStorage / sessionStorage get / set / clear |

## Group `antibot`

| Tool | Notes |
|---|---|
| `detect_anti_bot` | Is this a challenge page, which vendor; the agent hands over to the user (07, skill) |
| `fingerprint_audit` | What a page sees, and contradictions in it |

Human-looking input is not a tool group; it is how every action is performed
(06-page-interaction.md).

## Left out

| Reference feature | Why not |
|---|---|
| Turnstile click helpers | The reference's own numbers: a Playwright click fails full-page challenges 0/3; the user solves challenges in the visible window |
| `humanize_*` tools, `mouse_drift`, `session_warmup` | Covered by Camoufox's built-in `humanize`; warmup is folklore |
| `extract_structured`, `detect_content_pattern` | The agent reads snapshots / network JSON directly |
| `storage_state` save/load, cookie import/export | Profiles persist on their own; outside import goes through the profile directory (02) |
| IndexedDB tools, storage diff | Niche; add on demand |
| Assertions, `workflow_run`, compound tools | `browser_batch` covers multi-step calls |
| ChatGPT automation, `performance_timeline`, `page_stats` | Out of scope |
| GIF recording | The window is visible; screenshots cover reports. Possible later |

## Gaps vs Claude in Chrome

- Its own browser, not the user's: sessions are the ones made in the agent's profiles
  (or copied in from outside), and the agent cannot see the user's own tabs.
- `find` is literal, not natural-language. Chrome's runs a model over the page; a
  literal match plus `read_page` covers most uses.
- No GIF recording (Left out).
- No `upload_image` (putting a screenshot into a page); `file_upload` of a saved
  screenshot path covers most uses.
