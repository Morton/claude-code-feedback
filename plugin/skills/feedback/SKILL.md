---
description: Check the in-page feedback the user left on their local web app and apply it. Use when the user says to check/apply web feedback, review pending UI comments, or after they mention leaving feedback on the page.
---

# Apply web feedback

The `web-feedback` MCP server collects visual feedback the user leaves on their
running web app: a message, the CSS selector of the marked element, the page URL,
an annotated screenshot, and recent console/network errors.

Apply it like this:

1. Call `list_feedback` to see pending items. If it's empty, tell the user there's
   nothing pending and stop.
2. For each item, call `get_feedback(id)` — it returns the annotated **screenshot as
   an image**, plus the selector and diagnostics. Look at the screenshot to
   understand what the user marked.
3. Find the relevant code (use the selector, page URL, and element tag as hints) and
   make the change the feedback asks for.
4. Call `resolve_feedback(id)` once addressed, so it drops from the list.

Work through every pending item unless the user scoped it to a specific one, then
briefly summarize what you changed per item.

If the user passed extra instructions, honor them: $ARGUMENTS
