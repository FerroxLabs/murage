// Scoped MCP adapter: the agent never receives engine credentials or a raw
// CLI escape hatch. Harness authority is checked before and after every call.
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import type { AgentBrowserSpec } from "../browser-engine.ts";
import { createLineSplitter, writeMcpLine } from "../mcp-bridge.ts";
import { listHeadlessBrowserTools, validateHeadlessBrowserCall } from "../browser-engine-policy.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const FAILURE = "Headless browser request refused or unavailable; the turn may have ended or control changed.";
type Authority = { spec: AgentBrowserSpec; held: boolean };
type Rpc = { id?: string | number | null; method?: string; params?: Record<string, unknown> };
export interface EngineClient {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  notify?: (method: string, params?: Record<string, unknown>) => Promise<void>;
  close: () => Promise<void>;
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error(FAILURE);
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error(FAILURE);
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error(FAILURE);
  } finally { reader.releaseLock(); }
}

function authorityUrl(env: NodeJS.ProcessEnv): URL {
  const url = new URL("/api/internal/headless-browser", env.MURAGE_CONTROL_URL);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !env.MURAGE_CONTROL_TOKEN || !env.MURAGE_BOT_ID || !env.MURAGE_THREAD_ID) throw new Error(FAILURE);
  url.searchParams.set("botId", env.MURAGE_BOT_ID);
  url.searchParams.set("threadId", env.MURAGE_THREAD_ID);
  return url;
}
export function createHeadlessAuthorityReader(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): () => Promise<Authority> {
  const url = authorityUrl(env);
  return async () => {
    const value = await boundedJson(await fetchImpl(url, {
      headers: { authorization: `Bearer ${env.MURAGE_CONTROL_TOKEN}` },
      redirect: "error", signal: AbortSignal.timeout(5000),
    }), MAX_REQUEST_BYTES) as Partial<Authority> | null;
    const spec = value?.spec;
    if (typeof value?.held !== "boolean" || !spec || typeof spec.command !== "string" || !spec.command
      || !Array.isArray(spec.args) || !spec.args.every((arg) => typeof arg === "string")
      || !spec.env || typeof spec.env !== "object" || Array.isArray(spec.env)
      || !Object.values(spec.env).every((item) => typeof item === "string")) throw new Error(FAILURE);
    return { spec, held: value.held };
  };
}

/** The harness owns daemon cleanup and serializes duplicate release paths.
 * Revoked authority is not an acknowledgment that a daemon actually exited. */
export async function closeHeadlessAuthority(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(authorityUrl(env), {
    method: "DELETE", headers: { authorization: `Bearer ${env.MURAGE_CONTROL_TOKEN}` },
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  const receipt = await boundedJson(response, MAX_REQUEST_BYTES) as { closed?: unknown } | null;
  if (receipt?.closed !== true) throw new Error(FAILURE);
}

/** The binary receives exactly the trusted spec environment. Its stderr and
 * protocol errors never become model-visible diagnostics. */
export function startHeadlessEngine(spec: AgentBrowserSpec): EngineClient {
  const child = spawn(spec.command, spec.args, { env: spec.env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let serial = 0;
  let stopped = false;
  let closePromise: Promise<void> | undefined;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const fail = () => {
    stopped = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(FAILURE)); }
    pending.clear();
  };
  const closed = new Promise<void>((resolve) => child.once("close", () => { fail(); resolve(); }));
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.resume();
  const splitter = createLineSplitter((line) => {
    let message: { id?: number; result?: unknown; error?: unknown };
    try { message = JSON.parse(line); } catch { fail(); child.kill("SIGKILL"); return; }
    const item = typeof message?.id === "number" ? pending.get(message.id) : undefined;
    if (!item) return;
    pending.delete(message.id!);
    clearTimeout(item.timer);
    if (message.error || !Object.hasOwn(message, "result")) item.reject(new Error(FAILURE));
    else item.resolve(message.result);
  }, MAX_RESPONSE_BYTES);
  child.stdout.on("data", (chunk: Buffer) => {
    try { splitter.push(chunk); } catch { fail(); child.kill("SIGKILL"); }
  });
  child.stdout.on("end", () => { try { splitter.flush(); } catch { fail(); } });
  return {
    async notify(method, params) {
      if (stopped) throw new Error(FAILURE);
      await writeMcpLine(child.stdin, JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
    request(method, params) {
      if (stopped) return Promise.reject(new Error(FAILURE));
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { fail(); child.kill("SIGKILL"); }, 60_000);
        pending.set(id, { resolve, reject, timer });
        void writeMcpLine(child.stdin, JSON.stringify({ jsonrpc: "2.0", id, method, params })).catch(fail);
      });
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        fail();
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
        try { await closed; } finally { clearTimeout(timer); }
      })();
      return closePromise;
    },
  };
}

export function createHeadlessBrowserProxy(options: {
  authorize: () => Promise<Authority>;
  start?: (spec: AgentBrowserSpec) => EngineClient;
  closeSession: (spec: AgentBrowserSpec) => Promise<void>;
  secrets?: string[];
}) {
  let engine: EngineClient | null = null;
  let spec: AgentBrowserSpec | null = null;
  let stopped = false;
  let closePromise: Promise<void> | undefined;
  const identity = (value: AgentBrowserSpec) => JSON.stringify([value.command, value.args, Object.entries(value.env).sort(([a], [b]) => a.localeCompare(b))]);
  const authorized = async () => {
    if (stopped) throw new Error(FAILURE);
    const current = await options.authorize();
    if (stopped || current.held || (spec && identity(spec) !== identity(current.spec))) throw new Error(FAILURE);
    return current.spec;
  };
  const ensureEngine = async () => {
    const current = await authorized();
    if (!engine) {
      spec = current;
      engine = (options.start ?? startHeadlessEngine)(current);
      await engine.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "murage-headless", version: "1" } });
    }
    return engine;
  };
  const clean = (value: unknown) => {
    let serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) throw new Error(FAILURE);
    for (const secret of [...(options.secrets ?? []), spec?.env.AGENT_BROWSER_ENCRYPTION_KEY]) {
      if (secret) serialized = serialized.replaceAll(secret, "[redacted]");
    }
    return JSON.parse(serialized);
  };
  return {
    async handle(message: Rpc): Promise<unknown | undefined> {
      if (message.id === undefined) return undefined;
      const result = (value: unknown) => ({ jsonrpc: "2.0", id: message.id, result: value });
      try {
        if (message.method === "initialize") return result({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "murage-headless-browser", version: "1" } });
        if (message.method === "ping") return result({});
        if (message.method === "tools/list") {
          const client = await ensureEngine();
          const upstream = await client.request("tools/list");
          const tools = listHeadlessBrowserTools((upstream as { tools?: unknown } | null)?.tools);
          await authorized();
          return result({ tools });
        }
        if (message.method === "tools/call") {
          const call = validateHeadlessBrowserCall(message.params?.name, message.params?.arguments ?? {});
          const client = await ensureEngine();
          // Initialization can cross a turn cancellation; check again at the
          // last boundary before the child receives any browser action.
          await authorized();
          const reply = await client.request("tools/call", call);
          await authorized();
          return result(clean(reply));
        }
        return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported MCP method" } };
      } catch {
        return result({ isError: true, content: [{ type: "text", text: FAILURE }] });
      }
    },
    close() {
      if (closePromise) return closePromise;
      stopped = true;
      closePromise = (async () => {
        if (engine) await engine.close();
        if (spec) await options.closeSession(spec);
      })();
      return closePromise;
    },
  };
}

export async function runHeadlessBrowserProxy(input: Readable = process.stdin, output: Writable = process.stdout, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const proxy = createHeadlessBrowserProxy({ authorize: createHeadlessAuthorityReader(env), closeSession: () => closeHeadlessAuthority(env), secrets: [env.MURAGE_CONTROL_TOKEN ?? ""] });
  const stop = () => { input.destroy(); void proxy.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const lines: string[] = [];
  const splitter = createLineSplitter((line) => { lines.push(line); }, MAX_REQUEST_BYTES);
  const drain = async () => {
    for (const line of lines.splice(0)) {
      let message: Rpc;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message !== "object") continue;
      const response = await proxy.handle(message);
      if (response !== undefined) await writeMcpLine(output, JSON.stringify(response));
    }
  };
  try {
    for await (const chunk of input) { splitter.push(chunk as Buffer); await drain(); }
    splitter.flush();
    await drain();
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await proxy.close();
  }
}
if (process.argv[1] && existsSync(process.argv[1]) && /headless-browser-proxy\.(?:ts|js)$/.test(process.argv[1])) {
  void runHeadlessBrowserProxy().catch(() => { process.stderr.write("Headless browser proxy ended without verified cleanup.\n"); process.exitCode = 1; });
}
