// Windows only (see browser-beforeunload-guard.ts). The engine registers its init scripts on the page
// that is active at launch, so a tab it opens later has none, and a beforeunload prompt there blocks
// the navigating call. This holds a second CDP connection to the engine's own Chrome: every new page
// target is paused at start, gets the guard as a new-document script, and is then resumed, so the
// guard runs before the first page script. No per-call cost; the connection stays open for the turn.
import { spawn } from "node:child_process";
import WebSocket from "ws";
import type { AgentBrowserSpec } from "../browser-engine.ts";

const STEP_TIMEOUT_MS = 1_500;

export interface TargetGuard {
  close: () => void;
  /** False once the connection has ended; a dead guard installs nothing. */
  alive: () => boolean;
  /** Resolves true once the guard script is registered on that page target (and the target resumed). */
  installed: (targetId: string, timeoutMs?: number) => Promise<boolean>;
}

/** The engine's browser endpoint, from a get_cdp_url reply. Loopback only. */
export function cdpUrlFromReply(reply: unknown): string | undefined {
  let text: string;
  try { text = typeof reply === "string" ? reply : JSON.stringify(reply) ?? ""; } catch { return undefined; }
  const found = /wss?:\/\/[^\s"'\\]+/u.exec(text)?.[0];
  if (!found) return undefined;
  try {
    const url = new URL(found);
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? found : undefined;
  } catch { return undefined; }
}

/** Asks the engine's own CLI (same session and environment as its MCP server, like the session close does)
 * for the browser endpoint. It runs between calls, when the daemon is idle. */
export function cdpUrlFromCli(spec: AgentBrowserSpec, timeoutMs = 5_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(spec.command, ["--session", spec.env.AGENT_BROWSER_SESSION ?? "", "get", "cdp-url"], { env: spec.env, shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { out = (out + chunk).slice(-4096); });
    child.on("error", () => { clearTimeout(timer); resolve(undefined); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? cdpUrlFromReply(out) : undefined); });
  });
}

export async function startTargetGuard(url: string, source: string, trace?: (line: string) => void): Promise<TargetGuard> {
  const socket = new WebSocket(url, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: STEP_TIMEOUT_MS });
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  let serial = 0;
  const waiting = new Map<number, (message: { error?: unknown }) => void>();
  const send = (method: string, params: Record<string, unknown>, sessionId?: string) => new Promise<{ error?: unknown }>((resolve) => {
    const id = ++serial;
    trace?.(`guard -> ${method}${sessionId ? ` [${sessionId.slice(0, 6)}]` : ""}`);
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: "timeout" }); }, STEP_TIMEOUT_MS);
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
      if (error) { clearTimeout(timer); waiting.delete(id); resolve({ error: String(error) }); }
    });
  });
  const done = new Set<string>();
  const watchers = new Map<string, Array<() => void>>();
  const markInstalled = (targetId: string) => { done.add(targetId); for (const wake of watchers.get(targetId) ?? []) wake(); watchers.delete(targetId); };
  socket.on("error", () => {});
  let live = true;
  socket.on("close", () => { live = false; for (const done of waiting.values()) done({ error: "closed" }); waiting.clear(); });
  socket.on("message", (data) => {
    let message: { id?: number; method?: string; params?: { sessionId?: string; waitingForDebugger?: boolean; targetInfo?: { type?: string; targetId?: string } }; error?: unknown };
    try { message = JSON.parse(String(data)); } catch { return; }
    trace?.(`guard <- ${String(data).slice(0, 200)}`);
    if (typeof message.id === "number") { waiting.get(message.id)?.(message); waiting.delete(message.id); return; }
    if (message.method !== "Target.attachedToTarget" || !message.params?.sessionId) return;
    const { sessionId, waitingForDebugger, targetInfo } = message.params;
    void (async () => {
      // Everything auto-attached is paused, whatever its type, so it is always resumed. Commands on one
      // session run in order, so the resume does not wait for the script's reply.
      // The page agent only runs its new-document scripts once it is enabled on this session.
      if (targetInfo?.type === "page") void send("Page.enable", {}, sessionId);
      const added = targetInfo?.type === "page" ? send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId) : undefined;
      const resumed = waitingForDebugger ? send("Runtime.runIfWaitingForDebugger", {}, sessionId) : undefined;
      const [add] = await Promise.all([added, resumed]);
      if (targetInfo?.targetId && add && !add.error) markInstalled(targetInfo.targetId);
    })();
  });
  const attached = await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  if (attached.error) { socket.terminate(); throw new Error("target guard unavailable"); }
  return {
    close: () => { try { socket.terminate(); } catch { /* already closed */ } },
    alive: () => live,
    installed: (targetId, timeoutMs = STEP_TIMEOUT_MS) => {
      if (done.has(targetId)) return Promise.resolve(true);
      if (!live) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        const wake = () => { clearTimeout(timer); resolve(true); };
        watchers.set(targetId, [...(watchers.get(targetId) ?? []), wake]);
        socket.once("close", () => { clearTimeout(timer); resolve(false); });
      });
    },
  };
}
