# Architecture

```
agent session A                agent session B
  │ MCP over stdio               │ MCP over stdio
  v                              v
camoufox-agent (MCP server)    camoufox-agent (MCP server)    thin, one per session
  └──────────────┬───────────────┘
                 │ unix socket: $XDG_RUNTIME_DIR/camoufox-agent-<version>.sock
                 v
camoufox-agentd (daemon, one per user)
  │  profiles: name -> running browser
  │  tabs: which session owns each, each session's active tab
  v
one Camoufox process per running profile
```

## Why a daemon

Firefox lets one process open a profile. Two agent sessions that both want the
`default` profile would collide on its lock, so one daemon holds every browser and
each session is a client of it. Sessions share a profile's logins; each acts in its own
tabs, and all see the free ones (see below).

## Lifecycle

- Nothing starts with the MCP server. The first tool call that needs the daemon starts
  it as a detached process; two sessions racing end up with one daemon (a lock file
  next to the socket decides).
- A browser is launched on first use of its profile. There is no launch tool.
- The very first launch on a machine downloads Camoufox (about 1.3 GB) in the
  background; tools answer with the progress until it is ready.
- When a session ends, its blank tabs are closed and the others stay open, free: owned
  by no session, like a tab the user opens by hand. What the session set up in them
  (request blocking, dialog answers) is undone and what was captured (console,
  network) is forgotten, again when a session takes the tab: the user may have logged
  in there meanwhile. Scripts a session left in the page itself stay until it reloads. tabs_context lists free tabs; a session takes one by passing
  its tabId. Sessions have no identity that survives a restart, so the agent picks the
  tab by what it shows.
- A tab nobody has used for an hour is closed, whoever owns it; an owner is told on
  its next call. `CAMOUFOX_AGENT_TAB_IDLE_MS` changes the hour. Use is an agent's call
  on the tab or the user's input in it: listeners in the isolated world (invisible to
  the page) note the last trusted pointer, key, wheel or touch event of the top document, and
  the sweep reads it once a minute. Input inside an iframe is not seen. A tab marked
  `keep` (tabs_create / tabs_update) is never closed for being unused; a `label` says
  what a tab is for, and both stay with the tab when its session ends.
- A browser closes with its last tab, whoever closes it (an agent, the idle timer, the
  user), and with no session connected a browser holding nothing but its blank first
  page is closed at once. There is no tool to close a browser: closing tabs is enough,
  and a browser shared by sessions and the user is not one agent's to close.
- The daemon lives while it has a session, a browser or the browser download; with
  none it exits a few seconds later. A newer version asks it to exit once no session is connected: its
  browsers close then, free tabs included, so that the new daemon can open the
  profiles.
- Browsers are closed on every exit path of the daemon, a kill included.
- A browser that dies is reported on the next call and relaunched on the next use.
- A browser being closed is not handed out: a call for its profile waits until its
  process has exited (and let go of the profile), then launches a new one.
- `--profiles-dir` and `--headless` are properties of the browsers, so a non-default
  combination gets its own daemon. The socket name carries the package version, so
  different versions never talk to each other.
- The daemon logs to `<socket>.log`; a clean exit removes the log.

## Tabs and the window

- One window per profile; new tabs open inside it. Tab ids are numbers, stable for the
  daemon's lifetime and never reused.
- A tool that needs a tab when the session has none opens a blank one; the session's
  next tabs_create in that profile takes that tab instead of opening another.
- A new tab is opened from a page (window.open). A page whose main thread is busy is
  given up on after 5 s and another is tried; the tab the busy page opens once it is
  free again is closed.
- A page tool acts on the session's active tab unless it is given `tabId`.
- Tabs a site opens belong to the session whose tab opened them. Tabs the user opens
  by hand belong to nobody until a session adopts one by id.
- A tab that closes behind a session is reported on its next call instead of being
  silently replaced.
- The window is opened without asking for focus and nothing the daemon does activates
  it. On Wayland the tab the agent works on is shown in the window; elsewhere the agent
  works in background tabs. Rendering continues while the window is hidden.
- The fingerprint's screen is kept at least as large as the largest display, so a
  window can never be larger than the screen the page is told about.

## Source layout

```
src/
  mcp/
    server.ts         MCP wiring, flags, the compact tools/list (no "$schema" or
                      +-2^53 integer bounds in the schemas the agent reads)
    client.ts         daemon client: connect, start the daemon, reconnect
    instructions.ts   the rules the server gives the agent on connect
    tools/*.ts        tool schemas
  daemon/
    main.ts           socket server, sessions, deadlines, idle exit
    profiles.ts       launch, close, crash handling
    launch.ts         launch options, the stored fingerprint, prefs
    display.ts        display size probes
    focus.ts          handing focus back after a launch
    install.ts        browser download and its progress
    tabs.ts           tab ids, ownership, opening and closing
    capture.ts        console, network, dialogs, downloads
    snapshot.ts       read_page / find and the ref engine
    actions.ts        what happened after a click; refusals
    navigation.ts     goto, back, forward, reload
    sessions.ts       find_session
    redact.ts         secret masking
    antibot.ts        challenge detection, fingerprint audit
    tools*.ts         tool handlers
  paths.ts            profiles root, socket, downloads
  protocol.ts         the wire between MCP server and daemon
examples/firefox-import/   copy a Firefox container into a profile
examples/chrome-import/    copy a Chromium browser profile's cookies and localStorage
```
