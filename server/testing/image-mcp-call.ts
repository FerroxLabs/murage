// Test-only MCP transport. The ready envelope starts the card wait after startup.
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export async function startImageMcpCall(proxy: ChildProcessWithoutNullStreams, name: string, args: Record<string, unknown>) {
  let pending = "", settled = false;
  let ready!: () => void, notReady!: (error: Error) => void;
  const initialized = new Promise<void>((resolve, reject) => { ready = resolve; notReady = reject; });
  let accept!: (value: any) => void, refuse!: (error: Error) => void;
  const result = new Promise<any>((resolve, reject) => { accept = resolve; refuse = reject; });
  // Both branches report transport failure; the unawaited branch is handled.
  void result.catch(() => {});
  const cleanup = () => {
    clearTimeout(timer);
    proxy.off("error", fail); proxy.off("close", closed);
    proxy.stdin.off("error", fail); proxy.stdout.off("error", fail);
    proxy.stdout.off("data", receive);
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true; cleanup(); notReady(error); refuse(error);
  };
  const closed = () => fail(new Error("Image MCP closed before its result"));
  const receive = (chunk: string) => {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      let value: any;
      try { value = JSON.parse(line); } catch { continue; }
      if (value?.id === 41) {
        if (value.error) { fail(new Error("Image MCP initialization refused")); return; }
        ready();
      }
      if (value?.id === 42) {
        if (value.error) { fail(new Error("Image MCP call refused")); return; }
        settled = true; cleanup(); proxy.stdin.end(); accept(value.result); return;
      }
    }
  };
  // Startup and the call share the original bound; card/case guards stay put.
  const timer = setTimeout(() => { proxy.kill(); fail(new Error("Image MCP timed out")); }, 15_000);
  proxy.stderr.resume(); proxy.stdout.setEncoding("utf8");
  proxy.stdout.on("data", receive);
  proxy.on("error", fail); proxy.once("close", closed);
  proxy.stdin.on("error", fail); proxy.stdout.on("error", fail);
  proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 41, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "image-fixture", version: "1" } } }) + "\n");
  await initialized;
  proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name, arguments: args } }) + "\n");
  return { proxy, result };
}
