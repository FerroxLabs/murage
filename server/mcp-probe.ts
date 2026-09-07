import { augmentedPath } from "./env-path.ts";
import {
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

export type McpProbeResult =
  | { ok: true; tools: McpProbeTool[] }
  | { ok: false; error: string };

const MAX_STDOUT_BYTES = 1_048_576;
const MAX_TOOLS = 100;
const DEFAULT_TIMEOUT_MS = 8_000;

function probeEnvironment(server: StoredMcpServer): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
  stripWorkspaceCredentialEnv(env);
  for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
  Object.assign(env, server.env);
  return env;
}

function publicProbeError(kind: "spawn" | "timeout" | "initialize" | "protocol" | "closed" | "cancelled"): string {
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
): Promise<McpProbeResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: publicProbeError("cancelled") });
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
      resolve({ ok: false, error: publicProbeError("spawn") });
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    let initialized = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish({ ok: false, error: publicProbeError("cancelled") });
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
        finish({ ok: false, error: publicProbeError("closed") });
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
          finish({ ok: false, error: publicProbeError("initialize") });
          return;
        }
        initialized = true;
        write({ jsonrpc: "2.0", method: "notifications/initialized" });
        write({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        return;
      }
      if (value.id !== 2) return;
      if (!initialized) {
        finish({ ok: false, error: publicProbeError("initialize") });
        return;
      }
      const result = value.result as { tools?: unknown } | undefined;
      if (value.jsonrpc !== "2.0" || "error" in value || !Array.isArray(result?.tools)) {
        finish({ ok: false, error: publicProbeError("protocol") });
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
      finish({ ok: false, error: publicProbeError("timeout") });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        finish({ ok: false, error: publicProbeError("protocol") });
        return;
      }
      splitter.push(chunk);
    });
    // Drain without retaining it. Child stderr often contains secrets or
    // arbitrary native logs and is not part of the MCP protocol.
    child.stderr.resume();
    child.once("error", () => finish({ ok: false, error: publicProbeError("spawn") }));
    child.once("close", () => finish({ ok: false, error: publicProbeError("closed") }));
    // Defensive hardening: asynchronous stdin errors are not caught by
    // write's try/catch. Settle the probe if one arrives. The fixture proves
    // a closed-stdin probe answers; it does not prove a reachable EPIPE crash.
    child.stdin.on("error", () => finish({ ok: false, error: publicProbeError("closed") }));

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
