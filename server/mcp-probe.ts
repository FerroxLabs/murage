import { augmentedPath } from "./env-path.ts";
import {
  deleteEnvNames,
  PROVIDER_CREDENTIAL_ENV,
  stripWorkspaceCredentialEnv,
} from "./config.ts";
import { createLineSplitter } from "./mcp-bridge.ts";
import type { StoredMcpServer } from "./mcp-registry.ts";
import { killCliTree, spawnCli } from "./procs.ts";

export interface McpProbeTool {
  name: string;
  description?: string;
}

/** Why a test failed. The stdio ones are this file's; the rest belong to a
 * link server (server/remote-mcp-client.ts). Each has one fixed sentence. */
export type McpProbeFailureReason =
  | "spawn" | "timeout" | "closed" | "cancelled" | "initialize" | "protocol" | "still-installing"
  | "needs-sign-in" | "needs-key" | "key-rejected" | "sign-in-ended" | "needs-more-access"
  | "not-found" | "unreachable" | "wrong-address" | "moved" | "https-required" | "local-confirm"
  | "address-changed" | "blocked-address" | "server-error" | "no-answer" | "session-gone";

export type McpProbeResult =
  | { ok: true; tools: McpProbeTool[]; transport?: "http" | "sse" }
  | {
    ok: false;
    error: string;
    reason?: McpProbeFailureReason;
    /** needs-sign-in: where to start (host and the server's own hints). */
    signIn?: { host: string; resourceMetadataUrl?: string; scopeHint?: string };
    /** needs-sign-in and needs-key: the header an API key goes in. */
    apiKey?: { headerHint: "x-api-key" | "authorization" };
    /** A masked form of the new address (never the address when it holds a secret). */
    suggestUrl?: string;
    /** The new address holds a secret, so acting on it goes through the desktop shell. */
    suggestHoldsSecret?: boolean;
    needs?: "this-computer" | "local-network";
    scopes?: string[];
  };

const MAX_STDOUT_BYTES = 1_048_576;
const MAX_TOOLS = 100;
const DEFAULT_TIMEOUT_MS = 8_000;
/** First-run windows for commands that download before they start (spec 3.6). */
export const INSTALLER_WINDOW_MS = 150_000;
export const DOCKER_WINDOW_MS = 300_000;

/** Whether a command fetches what it runs before running it, and how long its
 * first Test may take: npx, bunx, uvx, pipx, `pnpm dlx|exec`, `yarn dlx` get
 * 150 s; `docker run|pull` gets 300 s; anything else is not an installer. */
export function installerWindowMs(command: string, args: readonly string[]): number | null {
  const base = (command.split(/[\\/]/).pop() ?? command).replace(/\.(cmd|exe|bat)$/i, "");
  if (["npx", "bunx", "pnpx", "uvx", "pipx"].includes(base)) return INSTALLER_WINDOW_MS;
  if (base === "pnpm" && (args[0] === "dlx" || args[0] === "exec")) return INSTALLER_WINDOW_MS;
  if (base === "yarn" && args[0] === "dlx") return INSTALLER_WINDOW_MS;
  if (base === "docker" && (args[0] === "run" || args[0] === "pull")) return DOCKER_WINDOW_MS;
  return null;
}

export interface McpProbeOptions {
  /** "first-run": an installer command gets its long window, and a timeout
   * inside it is `still-installing` (the package cache is warm on the next try). */
  patience?: "first-run";
  /** Tests only: override the installer windows. */
  installerWindowMs?: number;
}

function probeEnvironment(server: StoredMcpServer): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
  stripWorkspaceCredentialEnv(env);
  deleteEnvNames(env, PROVIDER_CREDENTIAL_ENV);
  Object.assign(env, server.env);
  return env;
}

function publicProbeError(kind: "spawn" | "timeout" | "initialize" | "protocol" | "closed" | "cancelled" | "still-installing"): string {
  if (kind === "still-installing") return "It is still installing.";
  if (kind === "spawn") return "Could not start this command. Check that it is installed and executable.";
  if (kind === "timeout") return "The server did not answer in time.";
  if (kind === "closed") return "The server stopped before the MCP handshake finished.";
  if (kind === "cancelled") return "Connection test was cancelled.";
  if (kind === "initialize") return "The server did not complete MCP initialization.";
  return "The command did not return a valid MCP tools list.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactConfiguredValues(value: string, env: Record<string, string>): string {
  let redacted = value;
  for (const secret of Object.values(env)) {
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

/** Start one stdio server long enough to prove the MCP handshake and list its
 * tools. It is always reaped, never inherits Murage's own workspace or
 * provider credentials, and never returns child stderr or environment values
 * to the renderer. */
export function probeMcpServer(
  server: StoredMcpServer,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
  options: McpProbeOptions = {},
): Promise<McpProbeResult> {
  const installerWindow = options.patience === "first-run"
    ? options.installerWindowMs ?? installerWindowMs(server.command, server.args)
    : null;
  if (installerWindow !== null) timeoutMs = installerWindow;
  const fail = (kind: Parameters<typeof publicProbeError>[0]): McpProbeResult => ({ ok: false, error: publicProbeError(kind), reason: kind });
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(fail("cancelled"));
      return;
    }

    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(server.command, server.args, {
        cwd: process.cwd(),
        env: probeEnvironment(server),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve(fail("spawn"));
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    let initialized = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(fail("cancelled"));
    const finish = (result: McpProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      killCliTree(child);
      resolve(result);
    };
    const write = (frame: unknown) => {
      if (settled) return;
      try {
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      } catch {
        finish(fail("closed"));
      }
    };
    const splitter = createLineSplitter((line) => {
      if (settled || !line.trim()) return;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(frame)) return;
      const value = frame;
      if (value.id === 1 && !initialized) {
        const result = value.result;
        // An error response is terminal, and its server-authored text must
        // never reach the renderer. Only a well-formed initialize success
        // permits the notification and tools/list request that follow it.
        if (
          value.jsonrpc !== "2.0" || "error" in value || !isRecord(result) ||
          typeof result.protocolVersion !== "string" || !result.protocolVersion ||
          !isRecord(result.capabilities) || !isRecord(result.serverInfo) ||
          typeof result.serverInfo.name !== "string" || typeof result.serverInfo.version !== "string"
        ) {
          finish(fail("initialize"));
          return;
        }
        initialized = true;
        write({ jsonrpc: "2.0", method: "notifications/initialized" });
        write({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        return;
      }
      if (value.id !== 2) return;
      if (!initialized) {
        finish(fail("initialize"));
        return;
      }
      const result = value.result as { tools?: unknown } | undefined;
      if (value.jsonrpc !== "2.0" || "error" in value || !Array.isArray(result?.tools)) {
        finish(fail("protocol"));
        return;
      }
      const tools: McpProbeTool[] = [];
      for (const raw of result.tools.slice(0, MAX_TOOLS)) {
        if (!raw || typeof raw !== "object") continue;
        const candidate = raw as Record<string, unknown>;
        if (typeof candidate.name !== "string" || !candidate.name.trim()) continue;
        tools.push({
          name: redactConfiguredValues(candidate.name, server.env).slice(0, 200),
          ...(typeof candidate.description === "string"
            ? { description: redactConfiguredValues(candidate.description, server.env).slice(0, 500) }
            : {}),
        });
      }
      finish({ ok: true, tools });
    });

    timer = setTimeout(() => {
      finish(fail(installerWindow !== null ? "still-installing" : "timeout"));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        finish(fail("protocol"));
        return;
      }
      splitter.push(chunk);
    });
    // Drain without retaining it. Child stderr often contains secrets or
    // arbitrary native logs and is not part of the MCP protocol.
    child.stderr.resume();
    child.once("error", () => finish(fail("spawn")));
    child.once("close", () => finish(fail("closed")));
    // Defensive hardening: asynchronous stdin errors are not caught by
    // write's try/catch. Settle the probe if one arrives. The fixture proves
    // a closed-stdin probe answers; it does not prove a reachable EPIPE crash.
    child.stdin.on("error", () => finish(fail("closed")));

    if (signal?.aborted) {
      onAbort();
      return;
    }

    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "Murage", version: "probe" },
      },
    });
  });
}
