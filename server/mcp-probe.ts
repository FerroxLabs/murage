import { redactConfiguredValues } from "../shared/configured-value-redaction.cjs";
import { probeFolder } from "./probe-folder.ts";
import type { TestRelease } from "./mcp-test-release.ts";
import { augmentedPath } from "./env-path.ts";
import {
  deleteEnvNames,
  PROVIDER_CREDENTIAL_ENV,
  stripWorkspaceCredentialEnv,
} from "./config.ts";
import { createLineSplitter } from "./mcp-bridge.ts";
import type { StoredMcpServer } from "./mcp-registry.ts";
import { engineJob, killCliTree, spawnCli } from "./procs.ts";
import { chatMcpChildEnv } from "./drivers/chat-mcp-client.ts";

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
  | "address-changed" | "blocked-address" | "server-error" | "no-answer" | "session-gone"
  /** q1022-connparity: Test passed nothing because a chat would not mount this entry (mcp-chat-path-test.ts). */
  | "not-in-chats"
  /** q1023-connparity-fix: a legacy SSE server's stream ended or broke while a call waited on it for its answer
   * (remote-mcp-sse-sessions.ts pump). The engine proxy treats it as every other mid-call stream break. */
  | "stream-broke";

/** What a server's list holds past the tools a probe keeps. */
export interface McpToolsBeyondList {
  /** Tools in the answer, when more than the probe kept. */
  toolsTotal?: number;
  /** The server has a further page, which no probe asks for. */
  toolsMore?: true;
}

/** Say what was left out, so Settings shows the server's real size and not the probe's limit. */
export function toolsBeyondList(tools: readonly unknown[], nextCursor: unknown, kept: number): McpToolsBeyondList {
  return {
    ...(tools.length > kept ? { toolsTotal: tools.length } : {}),
    ...(typeof nextCursor === "string" && nextCursor ? { toolsMore: true as const } : {}),
  };
}

export type McpProbeResult =
  | ({ ok: true; tools: McpProbeTool[]; transport?: "http" | "sse" } & McpToolsBeyondList)
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
  /** q1022-connparity (MAIN-RULING CONNPARITY-1022): the process a chat spawns for this server (the wipe wrapper
   * around the owner's command, built by the chat's own mount code) and this Test's release at the door. Started
   * INSTEAD of the bare command; the wrapper's stdout is release envelopes, each acknowledged over its IPC channel as
   * a chat's mount relay does. `server` stays the owner's entry (environment, redaction, installer patience). */
  chat?: { command: string; args: readonly string[]; env: Record<string, string>; release: TestRelease };
}

/** The one line the wrapper writes to its own stderr when the owner's command could not be started (mcp-bridge.ts). */
const WRAPPER_SPAWN_FAILED = /^bridge failures=1 code=\S+ syscall=spawn\b/m;

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

    const chat = options.chat;
    let child: ReturnType<typeof spawnCli>;
    try {
      child = chat
        ? spawnCli(chat.command, [...chat.args], {
          cwd: probeFolder(),
          // the environment a chat's relay gives the wrapper (chatMcpChildEnv: the system allowlist, PATH, then the
          // mount's own values), never this server's whole environment; first-run patience reaches the wrapper too
          env: chatMcpChildEnv({ ...server.env, ...chat.env, ...chat.release.env,
            ...(installerWindow !== null ? { MURAGE_MCP_TEST_START_MS: String(Math.min(installerWindow + 5_000, 310_000)) } : {}) }),
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          // started the way a chat's mount relay starts an admitted mount (cli-mount-relay.ts spawnMount): a
          // server-owned child with its IPC channel, never an engine launch
        }, engineJob({ posixHostPower: false }), { serverTool: "mcp" })
        : spawnCli(server.command, server.args, {
          cwd: probeFolder(),
          env: probeEnvironment(server),
          stdio: ["pipe", "pipe", "pipe"],
        });
    } catch {
      resolve(fail("spawn"));
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    let frameBytes = 0;
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
    // The wrapper's stdout: one release envelope per line. Only an envelope this Test's release issued is opened, and
    // the wrapper is told so (it holds its next frame until then), exactly as a chat's mount relay does.
    const splitter = createLineSplitter((line) => {
      if (settled || !line.trim()) return;
      if (!chat) return onFrame(line);
      let opened: ReturnType<TestRelease["accept"]>;
      try { opened = chat.release.accept(line); } catch { finish(fail("protocol")); return; }
      try { child.send?.(opened.ack, (error) => { if (error) finish(fail("closed")); }); } catch { finish(fail("closed")); return; }
      // the cap is on what the server said, as for a chat; the envelope around it is Murage's own
      frameBytes += Buffer.byteLength(opened.frame);
      if (frameBytes > MAX_STDOUT_BYTES) { finish(fail("protocol")); return; }
      onFrame(opened.frame);
    });
    const onFrame = (line: string) => {
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
      const result = value.result as { tools?: unknown; nextCursor?: unknown } | undefined;
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
          name: redactConfiguredValues(candidate.name, Object.values(server.env)).slice(0, 200),
          ...(typeof candidate.description === "string"
            ? { description: redactConfiguredValues(candidate.description, Object.values(server.env)).slice(0, 500) }
            : {}),
        });
      }
      finish({ ok: true, tools, ...toolsBeyondList(result.tools, result.nextCursor, tools.length) });
    };

    timer = setTimeout(() => {
      finish(fail(installerWindow !== null ? "still-installing" : "timeout"));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > (chat ? 4 * MAX_STDOUT_BYTES : MAX_STDOUT_BYTES)) {
        finish(fail("protocol"));
        return;
      }
      splitter.push(chunk);
    });
    // Drain without retaining it. Child stderr often contains secrets or
    // arbitrary native logs and is not part of the MCP protocol.
    let wrapperSaid = "";
    if (chat) {
      // The wrapper never forwards the server's stderr; what arrives here is the wrapper's own fixed lines. Only the
      // launch-failure line is looked for, and nothing of it is kept or shown.
      child.stderr.on("data", (chunk: Buffer) => { if (wrapperSaid.length < 4096) wrapperSaid += chunk.toString("utf8").slice(0, 4096); });
      child.on("message", (message: unknown) => {
        const type = (message as { type?: unknown } | null)?.type;
        // the owner's command exited or could not be started: give the wrapper's stderr line a moment to arrive
        if (type === "mcp-server-unavailable") { const late = setTimeout(() => finish(fail(WRAPPER_SPAWN_FAILED.test(wrapperSaid) ? "spawn" : "closed")), 150); late.unref?.(); }
        // the door refused the wrapper: nothing more of this server may be read
        else if (type === "turn-release-terminal") finish(fail("protocol"));
      });
    } else child.stderr.resume();
    child.once("error", () => finish(fail("spawn")));
    // (the wrapper's stderr has ended by now, so its launch-failure line, if any, is in)
    child.once("close", () => finish(fail(chat && WRAPPER_SPAWN_FAILED.test(wrapperSaid) ? "spawn" : "closed")));
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
