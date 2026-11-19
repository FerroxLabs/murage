import { createHash } from "node:crypto";
// A persistent stdio MCP peer for mount/permission configuration fixtures.
// Unlike a nonexistent executable or `node -e ''`, it survives until its
// owning transport closes, and participates in the normal MCP handshake.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
if (process.env.FIXTURE_REVISION_RECEIPT) appendFileSync(process.env.FIXTURE_REVISION_RECEIPT, JSON.stringify({ pid: process.pid, startedAt: Date.now(), revision: process.env.FIXTURE_REVISION, ...(process.env.MURAGE_COMMS_TOKEN ? { capability: createHash("sha256").update(process.env.MURAGE_COMMS_TOKEN).digest("hex") } : {}) }) + "\n");
import { createMcpCatalogWriter } from "../mcp-listed.ts";
const catalog = createMcpCatalogWriter();

const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  // A cold native peer can initialize while never finishing its tool list.
  // Do not publish a catalog marker for a response it has not delivered.
  if (request.method === "tools/list" && process.env.FIXTURE_TOOLS_LIST_HOLD === "1") return;
  const result = request.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list" ? { tools: [] }
    : request.method === "ping" ? {}
    : undefined;
  const observed = catalog.observeRequest(request);
  void observed.respond({ jsonrpc: "2.0", id: request.id,
    ...(result === undefined ? { error: { code: -32601, message: "Method not found" } } : { result }),
  }).catch(() => { process.exitCode = 1; input.close(); });
});
