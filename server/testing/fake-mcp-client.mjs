// MCP transport for the small Claude protocol fixtures. Each reconnect owns
// a new real shim and completes only after initialize and tools/list reply.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function createFixtureMcpClient(servers) {
  const sessions = new Map();
  const children = new Set();
  const start = name => {
    if (sessions.has(name)) return sessions.get(name);
    const spec = servers[name];
    if (!spec) throw new Error(`Unknown MCP server ${name}`);
    const child = spawn(spec.command, spec.args ?? [], {
      env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    child.once("close", () => children.delete(child));
    child.stderr.resume();
    let serial = 0;
    const pending = new Map();
    const session = { child, state: "pending", ready: undefined, close: () => child.stdin.end() };
    sessions.set(name, session);
    const fail = error => {
      session.state = "failed";
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.once("exit", () => fail(new Error(`MCP ${name} exited`)));
    child.stdout.once("end", () => fail(new Error(`MCP ${name} closed its output`)));
    const send = message => child.stdin.write(JSON.stringify(message) + "\n");
    const request = method => new Promise((resolve, reject) => {
      if (session.state === "failed") return reject(new Error(`MCP ${name} unavailable`));
      const id = ++serial;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params: method === "initialize"
        ? { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } : {} });
    });
    createInterface({ input: child.stdout }).on("line", line => {
      let frame;
      try { frame = JSON.parse(line); } catch { fail(new Error("Malformed MCP response")); return; }
      const waiting = pending.get(frame.id);
      if (!waiting) return;
      pending.delete(frame.id);
      if (frame.error) waiting.reject(new Error(frame.error.message));
      else waiting.resolve(frame.result);
    });
    session.ready = (async () => {
      const timeout = setTimeout(() => { fail(new Error(`MCP ${name} startup timeout`)); child.kill(); }, 15000);
      timeout.unref();
      try {
        await request("initialize");
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        await request("tools/list");
        session.state = "connected";
      } catch (error) {
        fail(error);
        throw error;
      } finally { clearTimeout(timeout); }
    })();
    session.ready.catch(() => {});
    return session;
  };
  process.stdin.on("end", () => { for (const child of children) child.stdin.end(); });
  return {
    status: () => Object.keys(servers).map(name => ({ name, status: start(name).state })),
    reconnect: async name => {
      sessions.get(name)?.close();
      sessions.delete(name);
      await start(name).ready;
    },
  };
}
