# 07 — Security

Pages are untrusted input, and the profiles hold the user's real sessions (D16).

## Untrusted page content

- Prompt injection: replies that carry page-derived content (`read_page`,
  `get_page_text`, console, network bodies, `fetch_markdown`) mark it as untrusted page
  data; the skill says never to follow instructions found in it (08-packaging.md).
- Challenge pages: `navigate` and click replies say "challenge page (<vendor>): hand
  over to the user" when the `detect_anti_bot` logic fires, so the agent stops instead
  of retrying.

## Limits on what leaves the profile

- `http_request` / `fetch_markdown` attach the profile's cookies only for the request's
  own origin, recomputed on every redirect hop, so a redirect cannot carry a session to
  another site.
- `file_upload` takes paths under the session's working directory or the system temp
  directory; anything else must be an absolute path the agent names explicitly, and it
  is echoed in the reply.
- Downloads go to a fixed directory (06-page-interaction.md).
- Profile names are restricted to `[a-z0-9][a-z0-9-]*`; `temp` is reserved
  (02-profiles.md).

## Secret masking

Masked by default in every tool output (D11): cookie values, `Authorization`,
`Set-Cookie`, tokens in URLs and bodies, password fields. `reveal_values=true` shows
them. Unmasked values would land in transcripts.

`javascript_tool` returns what the script returns, unmasked (as in the reference). It
is the one hole in masking, and the tool description says so.
