# 03 — Tools

The core mirrors Claude in Chrome's tool set: same names (without the `_mcp`
suffix), same shapes where they make sense. The model already knows that interface,
and the claude-in-chrome skill rules carry over almost unchanged. Modules from the
reference (`reference/mcp-camoufox`) sit on top, each switchable by a server flag,
all on by default.

Claude Code defers MCP tool schemas and loads them through ToolSearch, so the number
of tools costs little context until a tool is used. The real costs of a large set are
the agent choosing between near-duplicates and code to maintain; both guide the cuts.

Every page tool takes `tabId`; tab ids come from `tabs_context` (02-lifecycle.md).
Clicks, typing, key presses and `form_input` take `action_summary` (a few words on
what the action does), as in Chrome, so the user reads intent in the transcript.

## Core — Claude in Chrome parity

| Tool | Chrome equivalent | Notes |
|---|---|---|
| `tabs_context` | `tabs_context_mcp` | Flat list across profiles: id, profile, title, url, active; `createIfEmpty` |
| `tabs_create` | `tabs_create_mcp` | `url?`, `profile?` — launches the profile if needed |
| `tabs_close` | `tabs_close_mcp` | |
| `navigate` | `navigate` | `url`, or `"back"` / `"forward"` / `"reload"` |
| `read_page` | `read_page` | `filter: interactive \| all`, `ref_id` for a subtree, `max_chars`; refs from 04 |
| `find` | `find` | By text, label, placeholder, role; returns every match with refs. Chrome's is natural-language; ours is literal (see "Gaps") |
| `form_input` | `form_input` | `ref`, `value` (string / boolean for checkboxes / option for selects) |
| `computer` | `computer` | `left_click` `right_click` `double_click` `triple_click` (coordinate **or** ref), `type`, `key` (+`repeat`), `scroll`, `scroll_to`, `left_click_drag`, `hover`, `screenshot` (+`scale`), `zoom`, `wait` |
| `get_page_text` | `get_page_text` | |
| `javascript_tool` | `javascript_tool` | `world: main \| isolated` (Camoufox runs Playwright code isolated by default) |
| `read_console_messages` | `read_console_messages` | `pattern`, `level`, `clear`; capture on from launch |
| `read_network_requests` | `read_network_requests` | `pattern`, `since`; capture on from launch |
| `browser_batch` | `browser_batch` | Sequential, stops at first error |
| `file_upload` | `file_upload` | `ref`, `paths[]` |
| `resize_window` | `resize_window` | Window size; fingerprint screen stays larger (06) |

Plus, not in Chrome:

| Tool | Notes |
|---|---|
| `close_browser` | `profile?`; all when omitted |

Every click / key reply says what the page did (04-snapshot-and-actions.md).

## Module `network`

| Tool | Notes |
|---|---|
| `get_network_request` | Headers + text bodies of one captured request by id |
| `wait_for_network` | Wait for a request or response matching a pattern; returns it |
| `block_requests` | Block by resource type / URL pattern (images, fonts, trackers); `off` to stop |
| `export_har` | HAR 1.2 file, mode 0600 |
| `export_curl` | One request as a `curl` command |

## Module `http`

| Tool | Notes |
|---|---|
| `http_request` | HTTP with Firefox's TLS fingerprint (`impit`), sending the profile's cookies for that URL |
| `fetch_markdown` | URL → clean markdown, no browser; `use_browser` for JS pages |
| `extract_table` | HTML table on the page → JSON rows |

## Module `wait`

| Tool | Notes |
|---|---|
| `wait_for` | Text / selector / URL / "page changed" / network idle; first match wins; timeout is an error |
| `handle_dialog` | Answer for the next alert/confirm/prompt, or a standing rule |

## Module `storage`

| Tool | Notes |
|---|---|
| `cookies` | List / set / delete |
| `web_storage` | localStorage / sessionStorage get / set / clear |

## Module `antibot`

| Tool | Notes |
|---|---|
| `detect_anti_bot` | Is this a challenge page, which vendor; the skill tells the agent to hand over to the user |
| `fingerprint_audit` | What a page sees, and contradictions in it |

Humanized cursor movement is not a tool: Camoufox's `humanize` launch option
(Cursory, trajectories from 2356 real recordings, implemented in Juggler) is always
on, with a per-move time cap, so every `computer` mouse action moves like a person.
`form_input` / `type` use Camoufox's human-like paste and typing.

## Secrets

Masked by default in every tool output: cookie values, `Authorization`, `Set-Cookie`,
tokens in URLs and bodies, password fields. `reveal_values=true` shows them.
The profiles hold the user's real sessions; unmasked values would land in transcripts.

## Left out (with reason)

| Reference feature | Why not |
|---|---|
| Turnstile click helpers | The reference's own numbers: a Playwright click fails full-page challenges 0/3; the user solves challenges in the visible window |
| `os_click_xy` (real OS cursor) | Linux path is X11/xdotool; niri is Wayland. A uinput variant is possible later |
| `humanize_*` tools, `mouse_drift`, `session_warmup` | Covered by Camoufox's built-in `humanize`; warmup is folklore |
| `extract_structured`, `detect_content_pattern` | The agent reads snapshots / network JSON directly |
| `storage_state` save/load, cookie import/export | Sync owns profile contents (05) |
| IndexedDB tools, storage diff | Niche; add on demand |
| Assertions, `workflow_run`, compound tools | `browser_batch` covers multi-step calls |
| ChatGPT automation, `performance_timeline`, `page_stats` | Out of scope |
| GIF recording | The window is visible; screenshots cover reports. Possible later |

## Gaps vs Claude in Chrome

- Works on synced copies of sessions, not the live browser; the agent cannot see the
  user's own tabs.
- `find` is literal, not natural-language. Chrome's runs a model over the page; a
  literal match plus `read_page` covers most uses.
- No GIF recording.
