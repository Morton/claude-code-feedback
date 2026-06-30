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

## MCP tools

| Tool | Purpose |
|---|---|
| `list_feedback` | Pending items: message, URL, selector, diagnostics |
| `get_feedback(id)` | One item in full, screenshot returned as an **image** |
| `resolve_feedback(id)` | Mark handled (drops from the list) |
| `clear_feedback` | Discard everything |

## Verifying the loop

```bash
node test/loop.mjs   # spawns the bridge over MCP, posts feedback, reads it back via the tools
```

## Status & roadmap

Prototype — proves the end-to-end loop. Natural next steps:

- **Browser extension** so it injects on any `localhost` site with zero project changes (vs. the `<script>` tag).
- **Element → source mapping**: capture the source `file:line` for the marked element (React JSX-source / Vite plugin) so Claude jumps straight to the component.
- **Persistence** of the queue + screenshots to disk (currently in-memory per bridge process).
- Package as a **Claude Code plugin** (bundled MCP server + a `/feedback` skill) for one-step install across projects.
