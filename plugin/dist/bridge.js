import{createRequire}from'module';const require=createRequire(import.meta.url);

// src/bridge.ts
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// src/store.ts
import { randomUUID } from "node:crypto";
var items = [];
function splitDataUrl(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith("data:")) {
    return { base64: null, mime: null };
  }
  const comma = dataUrl.indexOf(",");
  const mime = /data:([^;]+)/.exec(dataUrl.slice(0, comma))?.[1] ?? null;
  return { base64: dataUrl.slice(comma + 1), mime };
}
function addFeedback(input) {
  const { base64, mime } = splitDataUrl(input.screenshotDataUrl);
  const { screenshotDataUrl: _omit, ...rest } = input;
  const item = {
    ...rest,
    id: randomUUID(),
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    status: "open",
    screenshotBase64: base64,
    screenshotMime: mime
  };
  items.push(item);
  return item;
}
function listFeedback(includeResolved = false) {
  return includeResolved ? [...items] : items.filter((i) => i.status !== "resolved");
}
function getFeedback(id) {
  return items.find((i) => i.id === id);
}
function markInProgress(id) {
  const item = items.find((i) => i.id === id);
  if (!item || item.status !== "open") {
    return false;
  }
  item.status = "in_progress";
  return true;
}
function resolveFeedback(id) {
  const item = items.find((i) => i.id === id);
  if (!item) {
    return false;
  }
  item.status = "resolved";
  return true;
}
function clearFeedback() {
  const n = items.length;
  items.length = 0;
  return n;
}

// src/bridge.ts
var PORT = Number(process.env.CLAUDE_FEEDBACK_PORT ?? 7878);
var HOST = "127.0.0.1";
var TOKEN = process.env.CLAUDE_FEEDBACK_TOKEN || null;
var log = (...args) => console.error("[claude-feedback]", ...args);
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Feedback-Token");
}
function isLoopbackHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}
function postAllowed(req) {
  const origin = req.headers.origin;
  if (origin) {
    let allowed = false;
    try {
      allowed = isLoopbackHost(new URL(origin).hostname);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return { ok: false, status: 403, error: "origin not allowed" };
    }
  }
  if (TOKEN && req.headers["x-feedback-token"] !== TOKEN) {
    return { ok: false, status: 401, error: "invalid or missing feedback token" };
  }
  return { ok: true };
}
function readBody(req, limitBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function serveStatic(res, file, type) {
  try {
    const body = await readFile(fileURLToPath(new URL(`../public/${file}`, import.meta.url)));
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}
async function serveWidget(res) {
  try {
    let body = await readFile(
      fileURLToPath(new URL("../public/widget.js", import.meta.url)),
      "utf8"
    );
    if (TOKEN) {
      body = `window.__CLAUDE_FEEDBACK_TOKEN__=${JSON.stringify(TOKEN)};
${body}`;
    }
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}
var httpServer = createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && url.pathname === "/feedback") {
    const gate = postAllowed(req);
    if (!gate.ok) {
      res.writeHead(gate.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: gate.error }));
      return;
    }
    try {
      const item = addFeedback(JSON.parse(await readBody(req)));
      log(`+ feedback ${item.id} on ${item.url} \u2014 "${item.message.slice(0, 60)}"`);
      pushChannelEvent(item);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: item.id }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/feedback") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(listFeedback().map(summary)));
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/feedback/")) {
    const id = decodeURIComponent(url.pathname.slice("/feedback/".length));
    const item = getFeedback(id);
    res.writeHead(item ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(item ? { id: item.id, status: item.status } : { error: "not found" }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/widget.js") {
    await serveWidget(res);
    return;
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/demo.html")) {
    await serveStatic(res, "demo.html", "text/html; charset=utf-8");
    return;
  }
  res.writeHead(404).end("not found");
});
function summary(item) {
  return {
    id: item.id,
    message: item.message,
    url: item.url,
    selector: item.selector,
    elementTag: item.elementTag,
    viewport: item.viewport,
    hasScreenshot: item.screenshotBase64 !== null,
    diagnostics: item.diagnostics,
    createdAt: item.createdAt,
    status: item.status
  };
}
var CHANNEL_INSTRUCTIONS = 'In-page feedback the user leaves on their running web app arrives as <channel source="claude-code-feedback" ...> events, each carrying a feedback `id`. When one arrives, call get_feedback(id) to see the annotated screenshot, the CSS selector, and recent console/network diagnostics; make the change in the codebase; then call resolve_feedback(id). These are one-way \u2014 no chat reply is expected.';
var mcp = new McpServer(
  { name: "claude-code-feedback", version: "0.1.0" },
  {
    // Declaring the channel capability lets Claude Code PUSH feedback into a
    // running session (started with `--channels`) instead of the session having
    // to poll the tools. Harmless otherwise: if the session isn't a channel,
    // Claude Code drops these notifications silently.
    capabilities: { experimental: { "claude/channel": {} } },
    instructions: CHANNEL_INSTRUCTIONS
  }
);
function pushChannelEvent(item) {
  const where = item.selector ? ` at \`${item.selector}\`` : "";
  const notification = {
    method: "notifications/claude/channel",
    params: {
      content: `New web feedback (id ${item.id}) on ${item.url}${where}: "${item.message}". Call get_feedback("${item.id}") to see the screenshot and diagnostics, apply the change, then resolve_feedback("${item.id}").`,
      // Each key becomes a <channel> tag attribute (identifiers only).
      meta: {
        id: item.id,
        url: item.url,
        selector: item.selector,
        element_tag: item.elementTag,
        has_screenshot: String(item.screenshotBase64 !== null)
      }
    }
  };
  mcp.server.notification(notification).catch((error) => log("channel notify failed:", error));
}
mcp.registerTool(
  "list_feedback",
  {
    description: "List pending in-page feedback left by the user on the running web app (message, page URL, CSS selector, diagnostics). Call get_feedback to also see the annotated screenshot.",
    inputSchema: z.object({
      includeResolved: z.boolean().optional()
    })
  },
  async ({ includeResolved }) => {
    const list = listFeedback(includeResolved ?? false).map(summary);
    return {
      content: [
        {
          type: "text",
          text: list.length === 0 ? "No pending feedback." : JSON.stringify(list, null, 2)
        }
      ]
    };
  }
);
mcp.registerTool(
  "get_feedback",
  {
    description: "Get one feedback item in full, including the annotated screenshot as an image so you can see what the user marked.",
    inputSchema: z.object({ id: z.string() })
  },
  async ({ id }) => {
    const item = getFeedback(id);
    if (!item) {
      return { content: [{ type: "text", text: `No feedback with id ${id}` }] };
    }
    markInProgress(id);
    const content = [{ type: "text", text: JSON.stringify(summary(item), null, 2) }];
    if (item.screenshotBase64 && item.screenshotMime) {
      content.push({
        type: "image",
        data: item.screenshotBase64,
        mimeType: item.screenshotMime
      });
    }
    return { content };
  }
);
mcp.registerTool(
  "resolve_feedback",
  {
    description: "Mark a feedback item as resolved once you've addressed it, so it stops showing in list_feedback.",
    inputSchema: z.object({ id: z.string() })
  },
  async ({ id }) => ({
    content: [
      {
        type: "text",
        text: resolveFeedback(id) ? `Resolved ${id}` : `No feedback with id ${id}`
      }
    ]
  })
);
mcp.registerTool(
  "clear_feedback",
  { description: "Discard all collected feedback.", inputSchema: z.object({}) },
  async () => ({ content: [{ type: "text", text: `Cleared ${clearFeedback()} item(s)` }] })
);
async function main() {
  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(
        `Port ${PORT} is already in use \u2014 another claude-feedback bridge is probably running (e.g. a second Claude Code session in this project). MCP tools stay available, but this instance will NOT receive widget feedback: the widget posts to whichever bridge owns the port. Close the other session, or set CLAUDE_FEEDBACK_PORT to a different port.`
      );
    } else {
      log("HTTP server error:", err);
    }
  });
  httpServer.listen(PORT, HOST, () => {
    log(
      `HTTP intake on http://${HOST}:${PORT}  (widget.js, /feedback, demo.html)` + (TOKEN ? "  [token required]" : "")
    );
  });
  await mcp.connect(new StdioServerTransport());
  log("MCP server connected on stdio");
}
main().catch((error) => {
  log("fatal:", error);
  process.exit(1);
});
