---
description: Add (or remove) the claude-code-feedback widget in the current project's web app so the user can leave in-page feedback. Use when the user asks to install, add, set up, wire in, or remove the feedback widget.
---

# Install the feedback widget

Wire the feedback widget into this project's web app so it loads during local
development. The widget is served by the bridge; all you add to the app is one
script tag:

```html
<script src="http://localhost:7878/widget.js"></script>
```

`7878` is only the *default* port. If another claude-feedback bridge (e.g. a second
Claude Code session in a different project) is already holding it, this session's
bridge lands on a different port instead — a script tag hardcoded to 7878 would then
silently talk to that *other* session, not this one. **Never assume the port:** call
the `get_bridge_url` MCP tool first and use the `widgetUrl` it returns for the script
tag.

## To install

1. **Call `get_bridge_url`** to get this session's actual bridge URL. Use that URL
   verbatim in the script tag below — do not hardcode `7878`.
2. **Find the app's HTML entry / root template.** Common cases:
   - **Vite, Create React App, or a plain static site:** the root `index.html` —
     insert the tag just before `</body>`.
   - **Next.js (app router):** `app/layout.tsx` — add a `<script>` inside `<body>`.
   - **Next.js (pages router):** `pages/_document.tsx` — add inside `<body>`.
   - **Nuxt, SvelteKit, Angular, Astro, etc.:** the equivalent root document or
     `index.html`.
   Search the repo for the entry file if it isn't obvious.
3. **Insert the tag so it loads on every page, guarded to development only** so it
   never ships to production. Use whatever the framework offers, for example:
   - Vite: keep it in the dev `index.html`, or gate with `import.meta.env.DEV`.
   - Next.js: render it only when `process.env.NODE_ENV !== "production"`.
   - Plain static dev site: add the tag directly and note it must be removed before
     deploying.
4. **Leave a marker comment** like `<!-- claude-code-feedback dev widget -->` so the
   tag is easy to find and remove later.
5. **Tell the user** what you changed, that it's dev-only, and to restart or reload
   their dev server so the widget loads. Mention that feedback starts either from
   the floating button or with **Alt+Shift+F** — the shortcut freezes the page
   before the overlay appears, so hover-only UI (menus, tooltips) can be captured.
   The shortcut is rebindable with `data-hotkey="ctrl+shift+k"` on the script tag.

## To remove

If the user asks to remove or uninstall the widget, find the script tag and its
marker comment and delete them.

$ARGUMENTS
