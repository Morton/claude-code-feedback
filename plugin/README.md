# web-feedback plugin

Packages [claude-code-feedback](https://github.com/Morton/claude-code-feedback) as a
Claude Code plugin so any session can use it in two commands — no clone, no build, no
`.mcp.json` path editing. This directory ships the prebuilt bridge, so a marketplace
install is fully self-contained.

## Install

```
/plugin marketplace add Morton/claude-code-feedback
/plugin install web-feedback@claude-code-feedback
```

This registers the `web-feedback` MCP server (bridge) and a `/web-feedback:feedback`
skill. The bridge opens `http://localhost:7878` to host the widget and receive
feedback — or the next free port if another bridge (e.g. a second session in a
different project) already holds it; call the `get_bridge_url` tool to confirm the
actual port. (Pin a specific port with `CLAUDE_FEEDBACK_PORT`.)

## Inject the widget

The widget has to load on your running dev site. The easiest way is to let Claude
wire it in — run the bundled skill:

```
/web-feedback:inject
```

Claude looks up this session's actual bridge URL (`get_bridge_url`) before wiring
anything in, then locates your app's entry template and adds a dev-only `<script>`
tag (and removes it on request). If you'd rather not touch your source, use the
**bookmarklet** instead — drag it to your bookmarks bar once, then click it on any
`localhost` page:

```
javascript:(()=>{const s=document.createElement('script');s.src='http://localhost:7878/widget.js';document.body.appendChild(s);})()
```

The tag it adds normally looks like this:

```html
<script src="http://localhost:7878/widget.js"></script>
```

`7878` is only the default port — if you're running more than one Claude Code
session at once, the bookmarklet (or a tag you write by hand) needs the real port
for *that* session's bridge. Ask the session for it (`get_bridge_url`) rather than
assuming `7878`.

## Use it

Leave a comment on the page (the button — or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> —
→ draw a box → type → Send), then in your session run:

```
/web-feedback:feedback
```

Claude lists the feedback, views each annotated screenshot, applies the change, and
marks it resolved. It'll also fire automatically when the skill's description matches
(e.g. "apply my web feedback").

## Push mode (channels)

The bridge is also a Claude Code [channel](https://code.claude.com/docs/en/channels):
launch with `--channels` and feedback is **pushed** into the session the moment you hit
Send — no polling. Channels are a research preview, so a third-party plugin isn't on the
allowlist yet; use the development flag:

```bash
claude --dangerously-load-development-channels plugin:web-feedback@claude-code-feedback
```

## What's inside

```
plugin/
├── .claude-plugin/plugin.json   # manifest
├── .mcp.json                    # runs dist/bridge.js via ${CLAUDE_PLUGIN_ROOT}
├── skills/feedback/SKILL.md     # /web-feedback:feedback — apply pending feedback
├── skills/inject/SKILL.md       # /web-feedback:inject — add/remove the widget in your app
├── dist/bridge.js               # prebuilt bridge (MCP server + HTTP intake)
└── public/                      # prebuilt widget.js + demo.html the bridge serves
```

The prebuilt artifacts are regenerated from the repo root with `pnpm run build:plugin`.
