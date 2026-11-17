#!/usr/bin/env node
// Offline protocol peer, never a real Claude qualification receipt. Unlike the
// small runtime fixture this starts the real relay shims and initializes/lists
// each MCP generation before reporting connected.
import "../../shared/win-hide-child-process.mjs";
import { withHideInherit } from "../../shared/win-hide-child-process.mjs";
import { readFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.310 (offline S2 protocol fixture)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "api_key" })); process.exit(0); }
const servers = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers;
const sessions = new Map(), callbacks = new Map(), children = new Set();
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
const log = value => appendFileSync(process.env.FAKE_CLAUDE_S2_PROTOCOL_LOG, JSON.stringify({ pid: process.pid, at: performance.now(), ...value }) + "\n");
const quote = word => `'${word.replaceAll("'", "'\\''")}'`;
let sequence = 0;
function session(name) {
  const server = servers[name];
  const prefix = process.env.CLAUDE_CODE_SHELL_PREFIX;
  const command = prefix ? process.env.CLAUDE_CODE_SHELL || "/bin/sh" : server.command;
  const argv = prefix ? ["-c", `${quote(prefix)} ${quote([server.command, ...server.args].map(quote).join(" "))}`] : server.args;
  const child = spawn(command, [...argv], withHideInherit({ env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "pipe"] }));
  children.add(child); child.once("close", () => children.delete(child));
  const pending = new Map();
  let stopped = false;
  const fail = error => { stopped = true; for (const p of pending.values()) p.reject(error); pending.clear(); };
  child.on("error", fail); child.stdin.on("error", fail); child.stderr.resume();
  child.once("exit", () => fail(new Error("offline shim exited")));
  function send(frame) { child.stdin.write(JSON.stringify(frame) + "\n", () => {}); }
  function request(method, params) {
    if (stopped) return Promise.reject(new Error("offline shim stopped"));
    const id = ++sequence;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    send({ jsonrpc: "2.0", id, method, params }); return result;
  }
  createInterface({ input: child.stdout }).on("line", line => {
    const frame = JSON.parse(line);
    log({ event: "mcp-frame", name, frame });
    if (frame.method === "elicitation/create") {
      const id = `offline-elicit-${++sequence}`;
      // Retain the exact old transport, as a real pending CLI callback does.
      callbacks.set(id, response => send({ jsonrpc: "2.0", id: frame.id, result: response }));
      out({ type: "control_request", request_id: id, request: { subtype: "elicitation", mcp_server_name: name,
        message: frame.params.message, requested_schema: frame.params.requestedSchema } });
    } else if (pending.has(frame.id)) {
      const p = pending.get(frame.id); pending.delete(frame.id);
      if (frame.error) p.reject(new Error(frame.error.message)); else p.resolve(frame.result);
    }
  });
  const ready = (async () => {
    await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "offline-s2", version: "1" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await request("tools/list", {});
    log({ event: "listed", name, tools: listed.tools });
    return listed.tools;
  })();
  ready.catch(() => {});
  return { child, ready, request, close: () => { child.stdin.end(); } };
}
function get(name) { if (!sessions.has(name)) sessions.set(name, session(name)); return sessions.get(name); }
async function control(frame) {
  const { subtype, serverName } = frame.request;
  if (subtype === "mcp_reconnect") {
    sessions.get(serverName)?.close(); sessions.delete(serverName);
    await get(serverName).ready;
    log({ event: "reconnected", name: serverName });
  }
  if (subtype === "mcp_status") {
    await Promise.all(Object.keys(servers).map(name => get(name).ready));
  }
  out({ type: "control_response", response: { request_id: frame.request_id, subtype: "success",
    response: subtype === "mcp_status" ? { mcpServers: Object.keys(servers).map(name => ({ name, status: "connected" })) } : {} } });
}
async function prompt(frame) {
  const text = frame.message.content;
  log({ event: "prompt", text });
  const name = Object.keys(servers)[0], s = get(name), tools = await s.ready;
  out({ type: "system", subtype: "init", session_id: `offline-${process.pid}`, model: "claude-sonnet-5-5", tools: [],
    mcp_servers: Object.keys(servers).map(name => ({ name, status: "connected" })) });
  const result = await s.request("tools/call", { name: tools[0].name, arguments: {} });
  out({ type: "assistant", message: { content: [{ type: "text", text: result.content[0].text }] } });
  out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0 });
}
createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line);
  log({ event: "stdin", frame });
  if (frame.type === "control_response") {
    const id = frame.response.request_id;
    if (callbacks.has(id)) { callbacks.get(id)(frame.response.response); callbacks.delete(id); log({ event: "delayed-answer", id }); }
    return;
  }
  const work = frame.type === "control_request" ? control(frame) : frame.type === "user" ? prompt(frame) : Promise.resolve();
  work.catch(error => {
    log({ event: "failure", message: error.message });
    if (frame.type === "control_request") out({ type: "control_response", response: { request_id: frame.request_id, subtype: "error", error: error.message } });
  });
});
function close() { for (const child of children) child.kill(); process.exit(0); }
process.stdin.once("end", close); process.once("SIGTERM", close); process.once("SIGINT", close);
