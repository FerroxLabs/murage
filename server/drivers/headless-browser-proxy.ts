// Scoped MCP adapter: the agent never receives engine credentials or a raw
// CLI escape hatch. Harness authority is checked before and after every call.
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import type { AgentBrowserSpec } from "../browser-engine.ts";
import { createLineSplitter, writeMcpLine } from "../mcp-bridge.ts";
import { BuiltinFloorGate, floorToolResult } from "../browser-floor-builtin.ts";
import { BEFOREUNLOAD_GUARD_SCRIPT } from "../browser-beforeunload-guard.ts";
import { cdpUrlFromCli, startTargetGuard, type TargetGuard } from "./headless-target-guard.ts";
import { HEADLESS_MODEL_TOOLS, listHeadlessBrowserTools, validateHeadlessBrowserCall } from "../browser-engine-policy.ts";
import { turnSecret, turnSecretWired } from "../turn-credential.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const TOOL_NOT_AVAILABLE = "That browser tool is not available to bots.";
const FAILURE = "Headless browser request refused or unavailable; the turn may have ended or control changed.";
type Authority = { spec: AgentBrowserSpec; held: boolean };
type Rpc = { id?: string | number | null; method?: string; params?: Record<string, unknown> };
export interface EngineClient {
  /** Aborting `signal` withdraws the request: the peer is sent MCP
   * `notifications/cancelled` naming it. The promise still settles only on the
   * peer's own reply or the watchdog, because a cancel is a request to stop,
   * not proof that the work stopped. */
  request: (method: string, params?: Record<string, unknown>, options?: {
    signal?: AbortSignal;
    /** The watchdog on the reply (default 60 s). `null`: no clock on the work
     * itself (the host computer's actions); a withdrawn request still gets
     * only a short grace to answer before the driver is stopped. */
    timeoutMs?: number | null;
  }) => Promise<unknown>;
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
    || !turnSecretWired("MURAGE_CONTROL_TOKEN", env) || !env.MURAGE_BOT_ID || !env.MURAGE_THREAD_ID) throw new Error(FAILURE);
  url.searchParams.set("botId", env.MURAGE_BOT_ID);
  url.searchParams.set("threadId", env.MURAGE_THREAD_ID);
  return url;
}
export function createHeadlessAuthorityReader(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): () => Promise<Authority> {
  const url = authorityUrl(env);
  return async () => {
    const value = await boundedJson(await fetchImpl(url, {
      headers: { authorization: `Bearer ${turnSecret("MURAGE_CONTROL_TOKEN", env)}` },
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
    method: "DELETE", headers: { authorization: `Bearer ${turnSecret("MURAGE_CONTROL_TOKEN", env)}` },
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  const receipt = await boundedJson(response, MAX_REQUEST_BYTES) as { closed?: unknown } | null;
  if (receipt?.closed !== true) throw new Error(FAILURE);
}

/** The binary receives exactly the trusted spec environment. Its stderr and
 * protocol errors never become model-visible diagnostics. */
/** How long a withdrawn request with no clock may take to answer. */
const WITHDRAW_GRACE_MS = 10_000;
/** The longest close() waits for the child to be gone. */
const CLOSE_BOUND_MS = 5_000;

export function startHeadlessEngine(spec: AgentBrowserSpec): EngineClient {
  const child = spawn(spec.command, spec.args, { env: spec.env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let serial = 0;
  let stopped = false;
  let closePromise: Promise<void> | undefined;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | undefined }>();
  const fail = () => {
    stopped = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(FAILURE)); }
    pending.clear();
  };
  const closed = new Promise<void>((resolve) => child.once("close", () => { fail(); resolve(); }));
  // 'close' also waits for every stdio pipe to end. The engine's daemon inherits those pipes and
  // outlives the MCP process until its idle timeout (60 s), so 'exit' is the real end of the child.
  const exited = new Promise<void>((resolve) => child.once("exit", () => { fail(); resolve(); }));
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
    request(method, params, options) {
      const signal = options?.signal;
      if (stopped || signal?.aborted) return Promise.reject(new Error(FAILURE));
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const kill = () => { fail(); child.kill("SIGKILL"); };
        const withdraw = () => {
          const item = pending.get(id);
          if (stopped || !item) return;
          void writeMcpLine(child.stdin, JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "The turn was stopped." } })).catch(fail);
          // a request with no clock still ends after a Stop
          if (options?.timeoutMs === null) { clearTimeout(item.timer); item.timer = setTimeout(kill, WITHDRAW_GRACE_MS); }
        };
        const settle = <T>(finish: (value: T) => void) => (value: T) => { signal?.removeEventListener("abort", withdraw); finish(value); };
        const timer = options?.timeoutMs === null ? undefined : setTimeout(kill, options?.timeoutMs ?? 60_000);
        pending.set(id, { resolve: settle(resolve), reject: settle(reject), timer });
        void writeMcpLine(child.stdin, JSON.stringify({ jsonrpc: "2.0", id, method, params })).catch(fail);
        signal?.addEventListener("abort", withdraw, { once: true });
      });
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        fail();
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
        // Bounded: never wait on pipes a surviving daemon still holds; closeSession stops the daemon.
        let bound: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([exited, closed, new Promise<void>((resolve) => { bound = setTimeout(resolve, CLOSE_BOUND_MS); })]); }
        finally { clearTimeout(timer); clearTimeout(bound); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); }
      })();
      return closePromise;
    },
  };
}

const SELF_ANSWERED_DIALOGS = new Set(["alert", "beforeunload"]);
function pendingDialogType(reply: unknown): string | undefined {
  const r = reply as { structuredContent?: { response?: { data?: unknown } }; content?: Array<{ text?: unknown }> } | null;
  const candidates: unknown[] = [r?.structuredContent?.response?.data];
  for (const part of r?.content ?? []) if (typeof part?.text === "string") { try { candidates.push(JSON.parse(part.text)); } catch { /* not JSON */ } }
  for (const c of candidates) {
    const d = c as { hasDialog?: unknown; type?: unknown } | null;
    if (d && d.hasDialog === true && typeof d.type === "string") return d.type;
  }
  return undefined;
}
/** Answers a pending alert or beforeunload through the engine's own dialog tools. Only used where the
 * engine's auto-answer is off (Windows, browser-engine.ts). confirm and prompt are left for the owner. */
async function answerPendingAlerts(client: EngineClient): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const type = pendingDialogType(await client.request("tools/call", { name: "agent_browser_dialog_status", arguments: {} }));
    if (!type || !SELF_ANSWERED_DIALOGS.has(type)) return;
    await client.request("tools/call", { name: "agent_browser_dialog_accept", arguments: {} });
  }
}

export function createHeadlessBrowserProxy(options: {
  authorize: () => Promise<Authority>;
  start?: (spec: AgentBrowserSpec) => EngineClient;
  closeSession: (spec: AgentBrowserSpec) => Promise<void>;
  secrets?: string[] | (() => string[]);
  /** Windows only: opens the guard connection that covers tabs opened later. */
  startTargetGuard?: (url: string, source: string) => Promise<TargetGuard>;
  /** The engine's browser endpoint; by default asked of the engine's own CLI for this session. */
  cdpUrl?: (spec: AgentBrowserSpec) => Promise<string | undefined>;
}) {
  let engine: EngineClient | null = null;
  let spec: AgentBrowserSpec | null = null;
  let stopped = false;
  let targetGuard: Promise<TargetGuard | undefined> | undefined;
  let activeGuard: TargetGuard | undefined;
  let guardAttempts = 0;
  let closePromise: Promise<void> | undefined;
  const connectGuard = async () => {
    guardAttempts++;
    const attempt = (async () => {
      const url = await (options.cdpUrl ?? cdpUrlFromCli)(spec!);
      return url ? await (options.startTargetGuard ?? startTargetGuard)(url, BEFOREUNLOAD_GUARD_SCRIPT) : undefined;
    })().catch(() => undefined);
    targetGuard = attempt;
    activeGuard = await attempt;
    if (!activeGuard?.alive()) { activeGuard?.close(); activeGuard = undefined; targetGuard = undefined; }
  };
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
    for (const secret of [...(typeof options.secrets === "function" ? options.secrets() : options.secrets ?? []), spec?.env.AGENT_BROWSER_ENCRYPTION_KEY]) {
      if (secret) serialized = serialized.replaceAll(secret, "[redacted]");
    }
    return JSON.parse(serialized);
  };
  const gate = new BuiltinFloorGate();
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
          const upstreamTools = (upstream as { tools?: unknown } | null)?.tools;
          const tools = listHeadlessBrowserTools(Array.isArray(upstreamTools) ? upstreamTools.filter((t) => HEADLESS_MODEL_TOOLS.includes((t as { name?: string } | null)?.name ?? "")) : upstreamTools);
          await authorized();
          return result({ tools });
        }
        if (message.method === "tools/call") {
          if (!HEADLESS_MODEL_TOOLS.includes(String(message.params?.name))) return result({ isError: true, content: [{ type: "text", text: TOOL_NOT_AVAILABLE }] });
          const call = validateHeadlessBrowserCall(message.params?.name, message.params?.arguments ?? {});
          const client = await ensureEngine();
          // Initialization can cross a turn cancellation; check again at the
          // last boundary before the child receives any browser action.
          await authorized();
          // The hard floor (T39), before the child receives any step the owner must take.
          const stop = await gate.guardAgentBrowser(call.name, call.arguments, async (selector) => {
            const html = clean(await client.request("tools/call", { name: "agent_browser_get_html", arguments: { selector } })) as { content?: Array<{ text?: unknown }> };
            return (html.content ?? []).map((c) => (typeof c.text === "string" ? c.text : "")).join("\n");
          });
          if (stop !== null) return result(floorToolResult(stop));
          const answersDialogs = spec?.env.AGENT_BROWSER_NO_AUTO_DIALOG === "1";
          if (answersDialogs) await answerPendingAlerts(client).catch(() => {});
          // A guard whose connection ended gets one bounded reconnect; after that tabs are created as before.
          if (activeGuard && !activeGuard.alive()) { activeGuard = undefined; targetGuard = undefined; guardAttempts = 2; await connectGuard(); }
          let reply: unknown;
          const wantedUrl = call.name === "agent_browser_tab_new" && typeof call.arguments.url === "string" ? call.arguments.url : undefined;
          if (activeGuard && wantedUrl !== undefined) {
            // A tab created with a URL commits that page before any script can be registered, so it is
            // created blank, given the guard, and only then sent to the page.
            const { url: _url, ...blank } = call.arguments;
            reply = await client.request("tools/call", { name: call.name, arguments: blank });
            const targetId = /targetId\\?"\s*:\s*\\?"([0-9A-Fa-f]{16,64})/u.exec(JSON.stringify(reply) ?? "")?.[1];
            if (targetId) await activeGuard.installed(targetId);
            await client.request("tools/call", { name: "agent_browser_open", arguments: { url: wantedUrl } });
          } else reply = await client.request("tools/call", call);
          if (answersDialogs) {
            await answerPendingAlerts(client).catch(() => {});
            // Once a browser exists: later tabs get the beforeunload guard at document start.
            // A failed attempt (no browser yet) is retried on the next calls, at most three times.
            if (!targetGuard && guardAttempts < 3) await connectGuard();
          }
          await authorized();
          const cleaned = clean(reply);
          gate.rememberToolResult(call.name, cleaned);
          return result(cleaned);
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
        (await targetGuard?.catch(() => undefined))?.close();
        if (engine) await engine.close();
        if (spec) await options.closeSession(spec);
      })();
      return closePromise;
    },
  };
}

export async function runHeadlessBrowserProxy(input: Readable = process.stdin, output: Writable = process.stdout, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const proxy = createHeadlessBrowserProxy({ authorize: createHeadlessAuthorityReader(env), closeSession: () => closeHeadlessAuthority(env), secrets: () => [turnSecret("MURAGE_CONTROL_TOKEN", env)] });
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
