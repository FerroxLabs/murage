#!/usr/bin/env node
// Deterministic approval-only CLI. Calls the actual mounted permission host;
// never executes the requested tool and never contacts a model/provider.
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const argv = process.argv.slice(2);
const arg = name => argv[argv.indexOf(name) + 1];
if (argv[0] === "--version") { console.log("2.1.295 (Claude Code)"); process.exit(0); }
if (argv[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); process.exit(0); }
if (!process.env.MURAGE_DATA_DIR || !process.env.MURAGE_CHANNEL_BUTTON_FIXTURE) throw new Error("Isolated button fixture environment required");
const receiptFile = join(process.env.MURAGE_DATA_DIR, "channel-button-decisions.jsonl");
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
// A warm session keeps this process across turns, and the driver removes the
// launch MCP config once it has spawned us, like a real CLI that mounts its
// servers once: read it on the first turn and keep it for the rest.
let mountedConfig, mountedSession;
// One connection belongs to the warm CLI, including every turn it serves.
// Ending the admitted transport before the result retires the running CLI.
function mountPermissionHost(host) {
  const child = spawn(host.command, host.args ?? [], { env: { ...process.env, ...host.env }, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0, failure;
  const fail = error => {
    failure ??= error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure); }
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("close", () => { lines.close(); fail(new Error("Permission host closed without decision")); });
  const send = value => child.stdin.write(JSON.stringify(value) + "\n");
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { fail(new Error("Permission timed out")); child.kill(); }, 600000);
    pending.set(id, { resolve, reject, timer });
    try { send({ jsonrpc: "2.0", id, method, params }); } catch (error) { fail(error); }
  });
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error("Invalid permission host response")); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error("Permission host refused request"));
    else entry.resolve(message.result);
  });
  const ready = (async () => {
    await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "channel-button-fixture", version: "1" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  })();
  // The driver's process-tree retirement owns closure, after the terminal result.
  return { ready, request };
}
async function permission() {
  const match = /^mcp__(.+?)__(.+)$/.exec(arg("--permission-prompt-tool") ?? "");
  if (!match || !argv.includes("--mcp-config")) throw new Error("Actual permission host is required");
  const config = mountedConfig ??= JSON.parse(readFileSync(arg("--mcp-config"), "utf8"));
  const host = config.mcpServers?.[match[1]];
  if (!host) throw new Error("Missing mounted host");
  const id = `channel-button-${process.pid}-${Date.now()}`;
  const input = { command: "printf murage-button-fixture", description: "Qualification permission only; fixture never executes this command" };
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input }] } });
  appendFileSync(receiptFile, JSON.stringify({ id, phase: "requested" }) + "\n", { mode: 0o600 });
  const session = mountedSession ??= mountPermissionHost(host);
  await session.ready;
  const result = await session.request("tools/call", { name: match[2], arguments: { tool_name: "Bash", input, tool_use_id: id } });
  const decision = JSON.parse(result?.content?.[0]?.text ?? "null");
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
  const message = JSON.parse(line);
  // The Claude driver opens with an `initialize` control request (it reads the
  // engine's slash commands from the answer); it is not a user turn.
  if (message.type === "control_request") { out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } }); continue; }
  out({ type: "system", subtype: "init", session_id: `channel-button-${process.pid}`, model: arg("--model") });
  await permission();
}
