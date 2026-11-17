// Minimal real MCP child used by the mounted integration and retirement tests.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.R3_MCP_LOG;
const gate = process.env.R3_MCP_GATE;
let holding = false, gated = false, inputClosed = false;
process.stdout.on("error", () => {});
if (log) appendFileSync(log, JSON.stringify({ event: "spawn", pid: process.pid }) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify({ event: "request", pid: process.pid, method: message.method }) + "\n");
  if (message.id === undefined) return;
  const result = message.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "r3", version: "1" } }
    : message.method === "tools/list"
      ? { tools: [{ name: "list_bots", inputSchema: { type: "object" } }, { name: "ask_bot", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: message.params?.name === "list_bots" ? "id: r3-peer" : "R3-MOUNT-DELIVERED" }] };
  const deliver = () => {
    if (gate && message.method === "tools/call") result.content = [{ type: "text", text: "id: r3-peer R3-MOUNT-LATE" }];
    if (gate && message.method === "tools/call") writeFileSync(`${gate}.attempted`, String(process.pid));
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n", () => {
      holding = false;
      if (inputClosed) process.exit(0);
    });
  };
  if (gate && !gated && message.method === "tools/call") {
    gated = true; holding = true;
    process.on("SIGTERM", () => writeFileSync(`${gate}.stopping`, String(process.pid)));
    writeFileSync(`${gate}.waiting`, String(process.pid));
    const deadline = Date.now() + 15_000;
    const poll = setInterval(() => {
      if (Date.now() > deadline) process.exit(2);
      if (!existsSync(`${gate}.release`)) return;
      clearInterval(poll); deliver();
    }, 5);
  } else deliver();
}).on("close", () => { inputClosed = true; if (!holding) process.exit(0); });
