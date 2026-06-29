import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
  resolveFeedback,
} from "./store.js";

const PORT = Number(process.env.CLAUDE_FEEDBACK_PORT ?? 7878);

// stdio carries the MCP protocol — never write to stdout.
const log = (...args: unknown[]) => console.error("[claude-feedback]", ...args);

// ---------------------------------------------------------------------------
// HTTP intake: the in-page widget posts feedback here; we also serve the widget.
// ---------------------------------------------------------------------------

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

const httpServer = createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/feedback") {
    try {
      const item = addFeedback(JSON.parse(await readBody(req)));
      log(`+ feedback ${item.id} on ${item.url} — "${item.message.slice(0, 60)}"`);
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

  if (req.method === "GET" && url.pathname === "/widget.js") {
    await serveStatic(res, "widget.js", "application/javascript; charset=utf-8");
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

const mcp = new McpServer({ name: "claude-code-feedback", version: "0.1.0" });

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

async function main() {
  httpServer.listen(PORT, () => {
    log(`HTTP intake on http://localhost:${PORT}  (widget.js, /feedback, demo.html)`);
  });
  await mcp.connect(new StdioServerTransport());
  log("MCP server connected on stdio");
}

main().catch((error) => {
  log("fatal:", error);
  process.exit(1);
});
