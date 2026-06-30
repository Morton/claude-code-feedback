# Example app

A tiny, dependency-free **stand-in for your local dev site** — used to test the
feedback loop end to end. It runs on its own port (`3000`) and pulls the widget
in from the bridge (`7878`), so it exercises the realistic **cross-origin** path,
not the same-origin shortcut that the bundled `public/demo.html` uses.

"Orbit" is a fake team dashboard with a handful of **deliberate UI issues** to
leave feedback on:

| Page | Planted issue |
|---|---|
| `/` | Subtitle text has near-invisible contrast |
| `/` | The "Requests this month" stat card clips its number (fixed narrow width) |
| `/` | "Refresh data" / "Simulate error" buttons are crammed together |
| `/settings.html` | The Email input is far wider than the others — ragged form |
| `/settings.html` | "Save" and "Cancel" sit flush with no gap |

"Simulate error" on the dashboard logs a console error and fires a failing
request, so you can confirm **diagnostics** show up alongside the feedback.

## Run it

```bash
pnpm run build      # from the repo root, builds public/widget.js
pnpm run example    # serves this app on http://localhost:3000
```

The bridge (which serves `widget.js` on `:7878`) is normally spawned by Claude
Code via MCP — start a `claude` session in the repo first. The static server
auto-injects `<script src="http://localhost:7878/widget.js">` into each page, so
there's nothing to edit. Override ports with `EXAMPLE_PORT` / `CLAUDE_FEEDBACK_PORT`.

Then open <http://localhost:3000>, click the 💬 button, draw a box over one of
the issues above, and tell Claude: *"Check my web feedback and apply it."*
