// End-to-end loop check: spawn the bridge over MCP stdio, POST feedback to its
// HTTP intake, then read it back through the MCP tools the agent would use.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = 7879;
const ONE_PX_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/bridge.js"],
  env: { ...process.env, CLAUDE_FEEDBACK_PORT: String(PORT) },
});
const client = new Client({ name: "loop-test", version: "0.0.0" });
await client.connect(transport);
await new Promise((r) => setTimeout(r, 600)); // let the HTTP server bind

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));

const post = await fetch(`http://localhost:${PORT}/feedback`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: "Heading sits too close to the paragraph",
    url: "/dashboard",
    selector: "main .card:nth-of-type(1) h2",
    elementTag: "H2",
    viewport: "1280x800",
    userAgent: "loop-test",
    screenshotDataUrl: ONE_PX_PNG,
    diagnostics: { console: [{ level: "error", message: "boom", timestamp: "t" }], network: [] },
  }),
});
const { id } = await post.json();
console.log("POST /feedback ->", post.status, id);

const list = await client.callTool({ name: "list_feedback", arguments: {} });
console.log("\nlist_feedback:\n" + list.content[0].text);

const got = await client.callTool({ name: "get_feedback", arguments: { id } });
console.log(
  "\nget_feedback content types:",
  got.content.map((c) => c.type).join(", ")
);
const img = got.content.find((c) => c.type === "image");
console.log("screenshot returned as image:", img ? `${img.mimeType}, ${img.data.length} b64 chars` : "NONE");

const resolved = await client.callTool({ name: "resolve_feedback", arguments: { id } });
console.log("\nresolve_feedback:", resolved.content[0].text);

const after = await client.callTool({ name: "list_feedback", arguments: {} });
console.log("list_feedback after resolve:", after.content[0].text);

await client.close();
console.log("\nOK: loop verified");
