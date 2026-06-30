# claude-code-feedback

Comment directly on your local web app and feed that feedback into your **Claude Code** session.

Draw a box on the page, type a note — the widget captures a **screenshot**, the **CSS selector** of what you marked, the page URL, and recent **console/network errors**, and hands them to Claude Code over **MCP**. Then you (or a loop) tell Claude to act on them.

```
 ┌─────────────────────────────┐   POST /feedback    ┌──────────────────────────┐   MCP tools    ┌──────────────┐
 │ widget on your dev site     │ ──────────────────▶ │ bridge (local process)   │ ─────────────▶ │ Claude Code  │
 │ (localhost:3000)            │  msg, rect,         │ • HTTP intake :7878      │ list_feedback  │ session      │
 │ screenshot + selector +     │  selector,          │ • in-memory queue        │ get_feedback   │              │
 │ console/network diagnostics │  screenshot, diag   │ • MCP stdio server       │ resolve_…      │              │
 └─────────────────────────────┘                     └──────────────────────────┘                └──────────────┘
```

The capture half is framework-agnostic (vanilla TS + `html2canvas` + `@medv/finder`); the bridge is a single Node process that is **both** an HTTP intake for the widget **and** an MCP stdio server for Claude Code.

## Quick start

```bash
pnpm install
pnpm run build        # builds public/widget.js + dist/bridge.js
```

**1. Register the bridge as an MCP server** in your project's `.mcp.json` (or Claude Code settings):

```json
{
  "mcpServers": {
    "web-feedback": {
      "command": "node",
      "args": ["/absolute/path/to/claude-code-feedback/dist/bridge.js"]
    }
  }
}
```

Claude Code spawns it; it also opens `http://localhost:7878` for the widget. (Override the port with `CLAUDE_FEEDBACK_PORT`.)

**2. Inject the widget** into your dev site — one tag, dev-only:

```html
<script src="http://localhost:7878/widget.js"></script>
```

(Or just open the bundled demo at `http://localhost:7878/demo.html`.)

> **Want a realistic test bed?** `pnpm run example` serves a small fake dashboard
> ("Orbit") on `http://localhost:3000` with deliberate UI issues to comment on —
> it pulls the widget in cross-origin, exactly like a real dev site would. See
> [`example/`](example/).

**3. Use it.** Run `claude` in your project + your dev server. Leave comments on the page, then in the CLI:

> "Check my web feedback and apply it."

Claude calls `list_feedback` / `get_feedback` (it can *see* each screenshot), makes the changes, and calls `resolve_feedback`. For a hands-off loop, run it under `/loop` so it applies comments as they arrive.

## Push vs. pull

By default the loop above is **pull**: Claude polls `list_feedback` (under `/loop`) or
you ask it to. The bridge is also a Claude Code **[channel](https://code.claude.com/docs/en/channels)**,
so it can **push** instead — the moment you hit *Send* in the widget, the item is
injected into your running session and Claude acts on it, no polling.

Start the session with the channel enabled (the server name matches the key in your
`.mcp.json`):

```bash
# Channels are a research preview; a custom one isn't on the allowlist yet, so:
claude --dangerously-load-development-channels server:web-feedback

# Fully hands-off (Claude edits files without per-action prompts) — trusted dirs only:
claude --dangerously-load-development-channels server:web-feedback --dangerously-skip-permissions
```

Each new comment arrives as `<channel source="claude-code-feedback" id="…" selector="…">`
with a nudge to call `get_feedback(id)` (which returns the screenshot), apply it, and
`resolve_feedback(id)`. The push is harmless when you *don't* launch with `--channels`:
Claude Code just drops the notification, and pull mode still works.

> Channels require Claude Code **v2.1.80+** and Anthropic auth (claude.ai or a Console
> API key; not Bedrock/Vertex/Foundry). On Team/Enterprise an admin must enable them.
> Syntax may change while it's in research preview.

## MCP tools

| Tool | Purpose |
|---|---|
| `list_feedback` | Pending items: message, URL, selector, diagnostics |
| `get_feedback(id)` | One item in full, screenshot returned as an **image** |
| `resolve_feedback(id)` | Mark handled (drops from the list) |
| `clear_feedback` | Discard everything |

## Local development & testing

```bash
pnpm install
pnpm run build        # builds public/widget.js + dist/bridge.js
```

**Quick, non-interactive check** — no browser, no Claude session:

```bash
node test/loop.mjs    # spawns the bridge over MCP, posts feedback, reads it back via the tools
```

**Full end-to-end test** against the bundled [`example/`](example/) app ("Orbit", a
fake dashboard with deliberate UI issues to comment on):

1. **Register the bridge** in `.mcp.json` (see [Quick start](#quick-start)) using an
   absolute path to `dist/bridge.js`.
2. **Terminal A — start Claude in this repo:** `claude`. It spawns the bridge as a
   stdio MCP server, which opens the HTTP intake on `:7878`. Run `/mcp` and confirm
   `web-feedback` is **connected** with the four tools. (If you just edited
   `.mcp.json`, restart `claude` so it re-spawns.)
3. **Terminal B — serve the example:** `pnpm run example` → <http://localhost:3000>.
   The static server auto-injects `<script src="http://localhost:7878/widget.js">`,
   so the widget loads cross-origin from the bridge.
4. **Leave feedback:** open the page, click 💬, box one of the planted issues, Send.
5. **Back in Terminal A:** *"Check my web feedback and apply it."* — or run it under
   `/loop` to apply comments as they arrive.

**Gotchas**

- Start the **bridge (via Claude) before** the example, or `widget.js` 404s.
- The feedback queue is **in-memory in the bridge process**. Run only **one `claude`
  session per project** for a given port — a second one spawns a second bridge that
  can't bind `:7878`; it stays connected over MCP but won't receive widget posts
  (it logs a warning). Use `CLAUDE_FEEDBACK_PORT` to run more than one on distinct ports.
- `.mcp.json` holds a machine-specific absolute path, so it's gitignored — create your
  own locally.

## Status & roadmap

Prototype — proves the end-to-end loop. Natural next steps:

- **Browser extension** so it injects on any `localhost` site with zero project changes (vs. the `<script>` tag).
- **Element → source mapping**: capture the source `file:line` for the marked element (React JSX-source / Vite plugin) so Claude jumps straight to the component.
- **Persistence** of the queue + screenshots to disk (currently in-memory per bridge process).
- Package as a **Claude Code plugin** (bundled MCP server + a `/feedback` skill) for one-step install across projects.
