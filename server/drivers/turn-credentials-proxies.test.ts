// Every stdio proxy that carries a per-turn token reads it from the process's
// credential file on EACH call. Reverting any of them to a token captured at
// startup (a module-level const read from env) fails here: the file is
// rewritten between two calls and the bearer on the wire must follow it.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createControlClient } from "../control-client.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";

interface ProxyCase { name: string; file: string; args?: string[]; server: string; envVar: string; env?: Record<string, string>; urlEnv: string; method: string; params: unknown }

const cases: ProxyCase[] = [
  { name: "agents", file: "./agents-proxy.ts", server: "murage-agents", envVar: "MURAGE_COMMS_TOKEN", urlEnv: "MURAGE_HARNESS_URL", env: { MURAGE_BOT_ID: "b1", MURAGE_THREAD_ID: "t1", MURAGE_TURN_DEPTH: "0" }, method: "tools/call", params: { name: "web_search", arguments: { query: "x" } } },
  { name: "browser", file: "./browser-proxy.ts", server: "murage-browser", envVar: "MURAGE_BROWSER_TOKEN", urlEnv: "MURAGE_BROWSER_URL", env: { MURAGE_BOT_ID: "b1" }, method: "tools/call", params: { name: "browser_navigate", arguments: { url: "https://example.com" } } },
  { name: "memory", file: "./memory-proxy.ts", server: "murage-memory", envVar: "MURAGE_MEMORY_TOKEN", urlEnv: "MURAGE_HARNESS_URL", method: "tools/call", params: { name: "memory_search", arguments: { query: "a" } } },
  { name: "remote-mcp", file: "./remote-mcp-proxy.ts", args: ["--server", "comfy"], server: "murage-remote-comfy", envVar: "MURAGE_MCP_TOKEN", urlEnv: "MURAGE_HARNESS_URL", method: "tools/list", params: {} },
];

let stub: Server | null = null;
let child: ChildProcess | null = null;
afterEach(async () => {
  child?.kill();
  child = null;
  if (stub) await new Promise<void>((resolve) => stub!.close(() => resolve()));
  stub = null;
});

describe.each(cases)("$name proxy follows the credential file between calls", (c) => {
  it("sends turn N's bearer, then turn N+1's, never the stale env value", async () => {
    const store = createTurnCredentialStore();
    const auths: Array<string | undefined> = [];
    try {
      stub = createServer((req, res) => {
        req.resume();
        req.on("end", () => { auths.push(req.headers.authorization); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
      });
      await new Promise<void>((resolve) => stub!.listen(0, "127.0.0.1", resolve));
      const port = (stub.address() as { port: number }).port;
      child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL(c.file, import.meta.url)), ...(c.args ?? [])], {
        env: { ...process.env, ...c.env, [c.urlEnv]: `http://127.0.0.1:${port}`, MURAGE_CRED_FILE: store.path, MURAGE_CRED_SERVER: c.server, [c.envVar]: "stale-env-token" },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const pending = new Map<number, () => void>();
      let buffered = "";
      child.stdout!.on("data", (chunk) => {
        buffered += chunk.toString();
        let end: number;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          if (!line.trim()) continue;
          const id = JSON.parse(line).id as number;
          pending.get(id)?.(); pending.delete(id);
        }
      });
      let nextId = 1;
      const call = () => new Promise<void>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, resolve);
        child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: c.method, params: c.params }) + "\n");
        setTimeout(() => reject(new Error(`${c.name} did not answer`)), 8_000).unref?.();
      });
      store.write({ [c.server]: { [c.envVar]: "turn-1" } });
      await call();
      store.write({ [c.server]: { [c.envVar]: "turn-2" } });
      await call();
      const bearers = auths.filter((a) => a?.startsWith("Bearer "));
      expect(bearers.length).toBeGreaterThanOrEqual(2);
      expect(bearers[0]).toBe("Bearer turn-1");
      expect(bearers.at(-1)).toBe("Bearer turn-2");
      expect(auths).not.toContain("Bearer stale-env-token");
    } finally {
      store.dispose();
    }
  });
});

describe("control client", () => {
  it("reads MURAGE_CONTROL_TOKEN from the credential file on every read", async () => {
    const store = createTurnCredentialStore();
    const saved = { file: process.env.MURAGE_CRED_FILE, server: process.env.MURAGE_CRED_SERVER, token: process.env.MURAGE_CONTROL_TOKEN };
    process.env.MURAGE_CRED_FILE = store.path;
    process.env.MURAGE_CRED_SERVER = "murage-browser";
    process.env.MURAGE_CONTROL_TOKEN = "stale-env-token";
    try {
      const auths: string[] = [];
      const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
        auths.push((init?.headers as Record<string, string>).authorization!);
        return new Response(JSON.stringify({ held: false, helpOpen: false }), { status: 200 });
      }) as typeof fetch;
      store.write({ "murage-browser": { MURAGE_CONTROL_TOKEN: "turn-1" } });
      const client = createControlClient({ url: "http://127.0.0.1:1/control", fetchImpl });
      await client.state(true);
      store.write({ "murage-browser": { MURAGE_CONTROL_TOKEN: "turn-2" } });
      await client.state(true);
      expect(auths).toEqual(["Bearer turn-1", "Bearer turn-2"]);
    } finally {
      for (const [key, value] of [["MURAGE_CRED_FILE", saved.file], ["MURAGE_CRED_SERVER", saved.server], ["MURAGE_CONTROL_TOKEN", saved.token]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      store.dispose();
    }
  });
});
