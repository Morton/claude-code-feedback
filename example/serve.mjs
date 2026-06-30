/**
 * Zero-dependency static server for the example app — a stand-in for "your local
 * dev site". It runs on its own port (default 3000), separate from the feedback
 * bridge (default 7878), so it exercises the realistic, cross-origin path: the
 * widget is served by the bridge but embedded on a different origin.
 *
 * The widget <script> tag is injected automatically into every HTML response, so
 * the example pages stay clean and the bridge port stays configurable:
 *
 *   node example/serve.mjs
 *   EXAMPLE_PORT=4000 CLAUDE_FEEDBACK_PORT=7878 node example/serve.mjs
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.EXAMPLE_PORT ?? 3000);
const BRIDGE_PORT = Number(process.env.CLAUDE_FEEDBACK_PORT ?? 7878);
const WIDGET_TAG = `<script src="http://localhost:${BRIDGE_PORT}/widget.js"></script>`;

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  // Resolve inside PUBLIC_DIR and refuse to escape it.
  const filePath = normalize(join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const ext = extname(filePath);
    const type = TYPES[ext] ?? "application/octet-stream";
    if (ext === ".html") {
      let html = await readFile(filePath, "utf8");
      // Inject the widget right before </body> if it isn't already there.
      if (!html.includes("/widget.js")) {
        html = html.replace("</body>", `  ${WIDGET_TAG}\n</body>`);
      }
      res.writeHead(200, { "Content-Type": type });
      res.end(html);
    } else {
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": type });
      res.end(body);
    }
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`Example app  → http://localhost:${PORT}`);
  console.log(`Widget from  → http://localhost:${BRIDGE_PORT}/widget.js (the bridge)`);
  console.log("Make sure the bridge is running (Claude Code spawns it via MCP).");
});
