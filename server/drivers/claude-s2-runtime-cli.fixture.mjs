#!/usr/bin/env node
import "../../shared/win-hide-child-process.mjs";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const NotModelRequest = (_reason, value) => value;

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.310 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "api_key" })); process.exit(0); }
const names = Object.keys(JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers);
const out = value => NotModelRequest("Offline fake CLI emits synthetic protocol frames on stdout.", process.stdout.write(JSON.stringify(value) + "\n"));
let prompts = 0;
createInterface({ input: process.stdin }).on("line", async line => {
  const frame = JSON.parse(line);
  appendFileSync(process.env.FAKE_CLAUDE_S2_LOG, JSON.stringify({ pid: process.pid, frame }) + "\n");
  if (frame.type === "control_request") {
    if (frame.request.subtype === "mcp_status" && process.env.FAKE_CLAUDE_S2_UNSUPPORTED === "1") {
      out({ type: "control_response", response: { request_id: frame.request_id, subtype: "error", error: "Unsupported control request subtype: mcp_status" } });
      return;
    }
    if (frame.request.subtype === "mcp_reconnect") {
      const incoming = process.env.FAKE_CLAUDE_S2_INCOMING;
      if (incoming) {
        while (!existsSync(process.env.FAKE_CLAUDE_S2_RELEASE + ".incoming")) await new Promise(r => setTimeout(r, 10));
        out({ type: "control_request", request_id: "barrier-ask", request: { subtype: incoming } });
      }
      while (!existsSync(process.env.FAKE_CLAUDE_S2_RELEASE)) await new Promise(r => setTimeout(r, 10));
    }
    out({ type: "control_response", response: { request_id: frame.request_id,
      subtype: frame.request.subtype === "mcp_reconnect" && process.env.FAKE_CLAUDE_S2_FAIL === "1" ? "error" : "success",
      response: frame.request.subtype === "mcp_status" ? { mcpServers: names.map(name => ({ name, status: "connected" })) } : {} } });
  } else if (frame.type === "user") {
    out({ type: "system", subtype: "init", session_id: `s2-${process.pid}`, model: "claude-sonnet-5-5", tools: [], mcp_servers: names.map(name => ({ name, status: "connected" })) });
    if (++prompts === 1 && String(frame.message.content).includes("first")) {
      out({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
      out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0 });
    }
  }
});
