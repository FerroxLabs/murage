import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { waitForExit } from "./cleanup.ts";

type Result = { isError?: boolean; content?: Array<{ type: string; text?: string }>; tools?: Array<{ name: string }> };

/** Test-only persistent stdio client. Never logs config, credentials or payloads. */
export function persistentAgentsClient(env: Record<string, string>) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../drivers/agents-proxy.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  let nextId = 0;
  const pending = new Map<number, { resolve(result: Result): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const fail = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("fixture proxy closed")); }
    pending.clear();
  };
  child.on("error", fail);
  child.on("close", fail);
  child.stdin.on("error", fail);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let message: { id?: number; result?: Result; error?: { code?: number } };
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`fixture MCP error ${message.error.code}`));
    else request.resolve(message.result ?? {});
  });
  const request = (method: string, params: object = {}) => new Promise<Result>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return reject(new Error("fixture proxy exited"));
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("fixture MCP request timed out")); }, 5_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return {
    child,
    request,
    async initialize() {
      await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: (name: "list_bots" | "list_image_models") => request("tools/call", { name, arguments: {} }),
    async close() { child.stdin.end(); await waitForExit(child); lines.close(); },
  };
}
