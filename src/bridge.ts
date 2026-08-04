import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addFeedback,
  clearFeedback,
  type FeedbackItem,
  getFeedback,
  listFeedback,
  markInProgress,
  resolveFeedback,
} from "./store.js";

// Identifies this project across restarts, for the port memory below.
// Falls back to cwd when not running as an installed plugin (e.g. from source).
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

// ${CLAUDE_PLUGIN_DATA} is a per-plugin directory that survives restarts and
// version bumps — Claude Code creates it on first reference and exports it to
// this process automatically. Only set when running as an installed plugin;
// `run it from source` (see README) has no plugin identity, so port memory
// is simply skipped there.
const PORT_REGISTRY_PATH = process.env.CLAUDE_PLUGIN_DATA
  ? join(process.env.CLAUDE_PLUGIN_DATA, "port-registry.json")
  : null;

// The <script> tag /web-feedback:inject writes is static HTML fixed at
// inject-time. If a later restart falls back to a different port than last
// time (another session running, or something else briefly held the default),
// that tag silently goes stale again. Remembering the port this project last
// bound successfully — and trying it first — keeps restarts landing in the
// same place, so an already-injected tag usually keeps working without
// needing a fresh get_bridge_url lookup. Best-effort only: any failure here
// just falls back to the plain default, never blocks startup.
function readRememberedPort(): number | null {
  if (!PORT_REGISTRY_PATH) return null;
  try {
    const registry = JSON.parse(readFileSync(PORT_REGISTRY_PATH, "utf8"));
    const port = registry[PROJECT_DIR];
    return typeof port === "number" ? port : null;
  } catch {
    return null;
  }
}

function rememberPort(port: number): void {
  if (!PORT_REGISTRY_PATH || !process.env.CLAUDE_PLUGIN_DATA) return;
  try {
    mkdirSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true });
    let registry: Record<string, number> = {};
    try {
      registry = JSON.parse(readFileSync(PORT_REGISTRY_PATH, "utf8"));
    } catch {
      // Missing or corrupt — start a fresh registry.
    }
    registry[PROJECT_DIR] = port;
    // Write-then-rename so a concurrent bridge (a different project) writing
    // the same shared file at the same moment can't corrupt it mid-write —
    // worst case is one of the two updates gets overwritten, which just means
    // that project's next restart falls back to the plain default.
    const tmpPath = `${PORT_REGISTRY_PATH}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(registry, null, 2));
    renameSync(tmpPath, PORT_REGISTRY_PATH);
  } catch (error) {
    log("could not persist bridge port:", error);
  }
}

const REQUESTED_PORT = process.env.CLAUDE_FEEDBACK_PORT
  ? Number(process.env.CLAUDE_FEEDBACK_PORT)
  : (readRememberedPort() ?? 7878);
// The actual bound port — starts as the requested one, updated once listening
// succeeds (see listenOnAvailablePort). Two sessions in two different projects
// both default here, so if the first one wins :7878 the second must land
// somewhere else rather than silently going dark: an un-bound bridge still
// looks "connected" over MCP while the widget's feedback POSTs go entirely to
// the other session, which has no way to know they belong to a different app.
let PORT = REQUESTED_PORT;
// Bind to loopback only — the intake must never be reachable from the network.
const HOST = "127.0.0.1";
// Optional shared secret. When set, POST /feedback must carry it; the widget
// picks it up automatically from the token the bridge injects into widget.js.
const TOKEN = process.env.CLAUDE_FEEDBACK_TOKEN || null;

// stdio carries the MCP protocol — never write to stdout.
const log = (...args: unknown[]) => console.error("[claude-feedback]", ...args);

// ---------------------------------------------------------------------------
// HTTP intake: the in-page widget posts feedback here; we also serve the widget.
// ---------------------------------------------------------------------------

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Feedback-Token");
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

// Feedback is a prompt-injection surface, so gate the write path:
//   • a browser Origin must be a loopback host — blocks a random website from
//     POSTing feedback into your session (requests with no Origin are allowed,
//     e.g. curl or same-origin);
//   • if a token is configured, it must match.
function postAllowed(req: IncomingMessage): { ok: true } | { ok: false; status: number; error: string } {
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

function readBody(req: IncomingMessage, limitBytes = 25 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
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

async function serveStatic(res: ServerResponse, file: string, type: string): Promise<void> {
  try {
    const body = await readFile(fileURLToPath(new URL(`../public/${file}`, import.meta.url)));
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

// Serve the widget, injecting the shared token (if any) so the in-page widget
// sends it back on POST /feedback without the user wiring anything up.
async function serveWidget(res: ServerResponse): Promise<void> {
  try {
    let body = await readFile(
      fileURLToPath(new URL("../public/widget.js", import.meta.url)),
      "utf8"
    );
    if (TOKEN) {
      body = `window.__CLAUDE_FEEDBACK_TOKEN__=${JSON.stringify(TOKEN)};\n${body}`;
    }
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      // The widget is re-read from disk per request, so the bridge always has the
      // current build — but without this the browser heuristically caches a 400kb+
      // script and keeps running the old one across plugin updates. Local dev
      // server: correctness beats the round-trip.
      "Cache-Control": "no-store, must-revalidate",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const httpServer = createServer(async (req, res) => {
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
      log(`+ feedback ${item.id} on ${item.url} — "${item.message.slice(0, 60)}"`);
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

  // The widget polls this to animate each pin as Claude works through it.
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

function summary(item: FeedbackItem) {
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
    status: item.status,
  };
}

// ---------------------------------------------------------------------------
// MCP server: how the Claude Code session reads/handles the feedback.
// ---------------------------------------------------------------------------

// Instructions are injected into Claude's system prompt when this runs as a
// channel, so it knows what the pushed <channel> events mean and how to act.
const CHANNEL_INSTRUCTIONS =
  'In-page feedback the user leaves on their running web app arrives as ' +
  '<channel source="claude-code-feedback" ...> events, each carrying a feedback `id`. ' +
  "When one arrives, call get_feedback(id) to see the annotated screenshot, the CSS " +
  "selector, and recent console/network diagnostics; make the change in the codebase; " +
  "then call resolve_feedback(id). These are one-way — no chat reply is expected.";

const mcp = new McpServer(
  { name: "claude-code-feedback", version: "0.1.0" },
  {
    // Declaring the channel capability lets Claude Code PUSH feedback into a
    // running session (started with `--channels`) instead of the session having
    // to poll the tools. Harmless otherwise: if the session isn't a channel,
    // Claude Code drops these notifications silently.
    capabilities: { experimental: { "claude/channel": {} } },
    instructions: CHANNEL_INSTRUCTIONS,
  }
);

// Push a freshly-received feedback item into the session as a channel event.
// The body just nudges Claude with the id; it then pulls the full item (incl.
// the screenshot image) via get_feedback, reusing the same tools as pull mode.
function pushChannelEvent(item: FeedbackItem): void {
  const where = item.selector ? ` at \`${item.selector}\`` : "";
  const notification = {
    method: "notifications/claude/channel",
    params: {
      content:
        `New web feedback (id ${item.id}) on ${item.url}${where}: "${item.message}". ` +
        `Call get_feedback("${item.id}") to see the screenshot and diagnostics, apply ` +
        `the change, then resolve_feedback("${item.id}").`,
      // Each key becomes a <channel> tag attribute (identifiers only).
      meta: {
        id: item.id,
        url: item.url,
        selector: item.selector,
        element_tag: item.elementTag,
        has_screenshot: String(item.screenshotBase64 !== null),
      },
    },
  };
  // The method is a Claude Code extension, outside the SDK's typed union.
  mcp.server
    .notification(notification as Parameters<typeof mcp.server.notification>[0])
    .catch((error) => log("channel notify failed:", error));
}

mcp.registerTool(
  "list_feedback",
  {
    description:
      "List pending in-page feedback left by the user on the running web app (message, page URL, CSS selector, diagnostics). Call get_feedback to also see the annotated screenshot.",
    inputSchema: z.object({
      includeResolved: z.boolean().optional(),
    }),
  },
  async ({ includeResolved }) => {
    const list = listFeedback(includeResolved ?? false).map(summary);
    return {
      content: [
        {
          type: "text",
          text:
            list.length === 0
              ? "No pending feedback."
              : JSON.stringify(list, null, 2),
        },
      ],
    };
  }
);

mcp.registerTool(
  "get_feedback",
  {
    description:
      "Get one feedback item in full, including the annotated screenshot as an image so you can see what the user marked.",
    inputSchema: z.object({ id: z.string() }),
  },
  async ({ id }) => {
    const item = getFeedback(id);
    if (!item) {
      return { content: [{ type: "text", text: `No feedback with id ${id}` }] };
    }
    // Fetching an item means work has started — lets the widget pin start pulsing.
    markInProgress(id);
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [{ type: "text", text: JSON.stringify(summary(item), null, 2) }];
    if (item.screenshotBase64 && item.screenshotMime) {
      content.push({
        type: "image",
        data: item.screenshotBase64,
        mimeType: item.screenshotMime,
      });
    }
    return { content };
  }
);

mcp.registerTool(
  "resolve_feedback",
  {
    description:
      "Mark a feedback item as resolved once you've addressed it, so it stops showing in list_feedback.",
    inputSchema: z.object({ id: z.string() }),
  },
  async ({ id }) => ({
    content: [
      {
        type: "text",
        text: resolveFeedback(id) ? `Resolved ${id}` : `No feedback with id ${id}`,
      },
    ],
  })
);

mcp.registerTool(
  "clear_feedback",
  { description: "Discard all collected feedback.", inputSchema: z.object({}) },
  async () => ({ content: [{ type: "text", text: `Cleared ${clearFeedback()} item(s)` }] })
);

mcp.registerTool(
  "get_bridge_url",
  {
    description:
      "Get the URL THIS bridge is actually listening on right now. Always call this " +
      "before hardcoding a port in a <script> tag or bookmarklet — if another bridge " +
      "(e.g. a second Claude Code session in a different project) already held the " +
      "default port, this one will have landed on a different one.",
    inputSchema: z.object({}),
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ port: PORT, widgetUrl: `http://${HOST}:${PORT}/widget.js` }, null, 2),
      },
    ],
  })
);

const MAX_PORT_ATTEMPTS = 20;

// Try REQUESTED_PORT, then REQUESTED_PORT+1, +2, ... A collision must not take
// down the MCP connection (Claude Code would just show the server stuck
// "connecting" and re-spawn into the same crash) — but it also must not leave
// this bridge silently unbound, since an unbound bridge still reports as
// connected over MCP while receiving zero widget traffic. Landing on the next
// free port keeps every session's feedback flowing to that session.
function listenOnAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    tryPort();

    function tryPort() {
      const port = startPort + attempt;
      const onError = (err: NodeJS.ErrnoException) => {
        httpServer.off("listening", onListening);
        if (err.code !== "EADDRINUSE") {
          reject(err);
          return;
        }
        attempt += 1;
        if (attempt >= MAX_PORT_ATTEMPTS) {
          reject(
            new Error(`No free port found in range ${startPort}-${startPort + MAX_PORT_ATTEMPTS - 1}`)
          );
          return;
        }
        tryPort();
      };
      const onListening = () => {
        httpServer.off("error", onError);
        resolve(port);
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port, HOST);
    }
  });
}

async function main() {
  PORT = await listenOnAvailablePort(REQUESTED_PORT);
  // Only attached once bound — errors during the port hunt above are handled
  // by listenOnAvailablePort's own one-shot listeners instead.
  httpServer.on("error", (err: NodeJS.ErrnoException) => log("HTTP server error:", err));
  rememberPort(PORT);
  log(
    `HTTP intake on http://${HOST}:${PORT}  (widget.js, /feedback, demo.html)` +
      (TOKEN ? "  [token required]" : "")
  );
  if (PORT !== REQUESTED_PORT) {
    log(
      `Port ${REQUESTED_PORT} was already in use — probably another claude-feedback ` +
        `bridge (another project, or a stale process of this one) — so this session ` +
        `landed on ${PORT} instead. A widget already pointed at ${REQUESTED_PORT} will ` +
        `NOT reach this bridge: re-run /web-feedback:inject (it looks up the live port ` +
        `via get_bridge_url), or call get_bridge_url yourself for the exact URL. Set ` +
        `CLAUDE_FEEDBACK_PORT to pin a specific port instead.`
    );
  }
  await mcp.connect(new StdioServerTransport());
  log("MCP server connected on stdio");
}

main().catch((error) => {
  log("fatal:", error);
  process.exit(1);
});
