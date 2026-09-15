#!/usr/bin/env node
// Deterministic approval-only CLI. Calls the actual mounted permission host;
// never executes the requested tool and never contacts a model/provider.
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const argv = process.argv.slice(2);
const arg = name => argv[argv.indexOf(name) + 1];
if (argv[0] === "--version") { console.log("2.1.232 (Claude Code)"); process.exit(0); }
if (argv[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); process.exit(0); }
if (!process.env.MURAGE_DATA_DIR || !process.env.MURAGE_CHANNEL_BUTTON_FIXTURE) throw new Error("Isolated button fixture environment required");
const receiptFile = join(process.env.MURAGE_DATA_DIR, "channel-button-decisions.jsonl");
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
async function permission() {
  const match = /^mcp__(.+?)__(.+)$/.exec(arg("--permission-prompt-tool") ?? "");
  if (!match || !argv.includes("--mcp-config")) throw new Error("Actual permission host is required");
  const config = JSON.parse(readFileSync(arg("--mcp-config"), "utf8"));
  const host = config.mcpServers?.[match[1]];
  if (!host) throw new Error("Missing mounted host");
  const id = `channel-button-${process.pid}-${Date.now()}`;
  const input = { command: "printf murage-button-fixture", description: "Qualification permission only; fixture never executes this command" };
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input }] } });
  appendFileSync(receiptFile, JSON.stringify({ id, phase: "requested" }) + "\n", { mode: 0o600 });
  const decision = await new Promise((resolve, reject) => {
    const child = spawn(host.command, host.args ?? [], { env: { ...process.env, ...host.env }, stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Permission timed out")); }, 600000);
    const lines = createInterface({ input: child.stdout });
    const send = value => child.stdin.write(JSON.stringify(value) + "\n");
    let result;
    child.on("error", reject);
    child.on("close", () => { clearTimeout(timer); lines.close(); if (result) resolve(result); else reject(new Error("Permission host closed without decision")); });
    lines.on("line", line => {
      const message = JSON.parse(line);
      if (message.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: match[2], arguments: { tool_name: "Bash", input, tool_use_id: id } } });
      }
      if (message.id === 2) { result = JSON.parse(message.result?.content?.[0]?.text ?? "null"); child.stdin.end(); }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "channel-button-fixture", version: "1" } } });
  });
  if (!["allow", "deny"].includes(decision.behavior)) throw new Error("Unexpected permission decision");
  appendFileSync(receiptFile, JSON.stringify({ id, phase: "resolved", behavior: decision.behavior }) + "\n", { mode: 0o600 });
  const text = `Qualification permission ${decision.behavior === "allow" ? "allowed once" : "denied"}; no tool was executed.`;
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: decision.behavior === "deny", content: text }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
}
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  JSON.parse(line);
  out({ type: "system", subtype: "init", session_id: `channel-button-${process.pid}`, model: arg("--model") });
  await permission();
}
