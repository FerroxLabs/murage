// SPDX-License-Identifier: AGPL-3.0-or-later
// ACP fake-session owner and field consumer owner: c3-memory.
import { spawn } from "node:child_process";

export function nativeSession(server: { command: string; args?: string[]; env?: Record<string, string> }) {
  const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "pipe"] });
  let sequence = 0, buffer = "", failure: Error | undefined;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const fail = (error: Error) => { failure = error; for (const row of pending.values()) row.reject(error); pending.clear(); };
  child.on("error", fail); child.stdin.on("error", fail);
  child.on("exit", () => fail(new Error("fixture MCP session exited")));
  child.stderr.resume();
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++sequence; pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const row = pending.get(message.id); if (!row) continue;
      pending.delete(message.id);
      if (message.error) row.reject(new Error(message.error.message)); else row.resolve(message.result);
    }
  });
  const ready = (async () => {
    await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "field-replay", version: "1" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await request("tools/list", {});
  })();
  return { ready, async call(name: string, args: Record<string, unknown>) { await ready; return request("tools/call", { name, arguments: args }); } };
}
