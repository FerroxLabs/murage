// pi — the pi coding agent (@earendil-works/pi-coding-agent) as a native engine.
//
// pi exposes a JSON-RPC mode over stdio (`pi --mode rpc --no-session`) rather
// than ACP, so — like the Claude Code and Codex CLIs — it gets a native driver
// that speaks its own protocol and emits canonical RuntimeEvents. pi is a
// BYOK agent: credentials live in ~/.pi/agent/auth.json and are injected by
// the pi binary itself, so this driver holds no API key and needs no sign-in.
//
// Conversation continuity: the first turn sends `new_session` and remembers
// the returned `sessionFile`; later turns send `switch_session` with that
// path (the way Claude Code resumes by session id). `sessionFile` is the
// resumeCursor the harness persists per thread.
//
// Model ids in the picker are `provider/modelId` composites (e.g.
// `ollama-cloud/glm-5.2`); `set_model` splits that into pi's separate
// `{provider, modelId}` fields. Live local hosts (oMLX / Ollama / EXO /
// LM Studio / Unsloth) land as `host::model` inject ids the same way the
// other engines do: mergeLocalInject lists them in Custom, and a pick
// upserts ~/.pi/agent/models.json so pi can reach the host. The live
// catalog is probed from `get_available_models` and every entry is flagged
// `custom` because pi is a custom-only (BYOK) engine — the model picker's
// Local pane only lists `custom` options for custom-only engines.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { PROVIDER_CREDENTIAL_ENV, stripRoutingEnv, stripWorkspaceCredentialEnv } from "../config.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { augmentedPath } from "../env-path.ts";
import { describeSpawnFailure, killCliTree, spawnCli } from "../procs.ts";
import { ProviderStopUnconfirmedError, providerCloseDeadlineMs, TurnTeardowns, type TeardownWait } from "./child-teardown.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";

import type {
  DriverCreateInput,
  EffortLevel,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { EFFORT_LEVELS, newEventId, newId } from "../contracts.ts";
import {
  decodeInjectId,
  encodeInjectId,
  hostApiKey,
  localHost,
  mergeLocalInject,
} from "./local-inject.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "piAgent";
const PI_ARGS = ["--mode", "rpc", "--no-session"];
const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

/** Harness effort → pi thinking level (`set_thinking_level`). The sets match
 * one-for-one except for the name of the lowest rung: the harness calls it
 * "none", pi calls it "off". Exported for the test. */
export function piThinkingLevel(effort: EffortLevel): (typeof EFFORT_LEVELS)[number] | "off" {
  return effort === "none" ? "off" : effort;
}

/** Mirror of the Claude driver's integration → stdio MCP mount: every entry is
 * a JSON-RPC 2.0 stdio server the pi-mcp-extension consumes. Returns null when
 * there is nothing to mount (the common case). */
export function buildMcpServers(turn: SendTurnInput): Record<string, unknown> | null {
  const servers: Record<string, unknown> = {};
  if (turn.integrations?.composio) servers.composio = { ...turn.integrations.composio };
  if (turn.integrations?.computer) {
    servers.computer = {
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: { ...NODE_ENV_FLAG, ...computerProxyEnv(turn.integrations.computer) },
    };
  } else if (turn.integrations?.localComputer) {
    const local = turn.integrations.localComputer;
    servers.computer = {
      command: local.command,
      args: local.args,
      env: local.env,
      // Host control carries scope so the extension gates every call behind
      // a permission card; isolated computers deliberately omit it.
      ...(local.scope ? { scope: local.scope } : {}),
    };
  }
  if (turn.integrations?.memory) servers["murage-memory"] = { ...turn.integrations.memory };
  if (turn.integrations?.agents) servers.agents = { ...turn.integrations.agents };
  if (turn.integrations?.phone) servers.phone = { ...turn.integrations.phone };
  if (turn.integrations?.dweb) {
    servers.dweb = {
      command: process.execPath,
      args: [SPAWNED_PROXIES.dweb],
      env: { ...NODE_ENV_FLAG, DWEB_URL: turn.integrations.dweb.url },
    };
  }
  return Object.keys(servers).length ? servers : null;
}

/** A pi `get_available_models` response payload, parsed at its I/O boundary. */
interface PiModelEntry {
  provider: string;
  id: string;
  name?: string;
}
interface PiModelsResponse {
  type: "response";
  command: "get_available_models";
  success: boolean;
  data?: { models?: PiModelEntry[] };
}

/** Pure parser: turn a `get_available_models` stdout blob into a catalog.
 *  Every option is `custom` (pi is BYOK) and id is the `provider/modelId`
 *  composite the picker and `set_model` both use. Exported for the test. */
export function parsePiCatalog(stdout: string, fallbackDefault = ""): ModelCatalog {
  const options: Array<{ id: string; label: string; custom: true; provider: string }> = [];
  let def = fallbackDefault;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const res = msg as PiModelsResponse;
    if (res?.type !== "response" || res.command !== "get_available_models" || !res.success) continue;
    for (const m of res.data?.models ?? []) {
      if (!m?.provider || !m?.id) continue;
      const id = `${m.provider}/${m.id}`;
      options.push({ id, label: m.name ?? m.id, custom: true, provider: m.provider });
    }
    break;
  }
  if (!def && options.length) def = options[0]!.id;
  return { default: def, options };
}

/** Split a picker id into pi's `{provider, modelId}`. Accepts both the
 *  native `provider/modelId` composite and a live-host `host::model`
 *  inject id. */
export function splitPiModel(id: string): { provider: string; modelId: string } | null {
  const inject = decodeInjectId(id);
  if (inject) return { provider: inject.host, modelId: inject.model };
  if (!id.includes("/")) return null;
  const [provider, ...rest] = id.split("/");
  if (!provider || !rest.length) return null;
  return { provider, modelId: rest.join("/") };
}

/** Prefer live `host::model` inject rows over the same model already
 *  listed as `host/model` from ~/.pi/agent/models.json, so Custom does
 *  not show duplicates. */
export function preferPiInjectRows(catalog: ModelCatalog): ModelCatalog {
  const injectIds = new Set(
    catalog.options.filter((option) => decodeInjectId(option.id)).map((option) => option.id),
  );
  if (!injectIds.size) return catalog;
  const options = catalog.options.filter((option) => {
    if (decodeInjectId(option.id)) return true;
    const slash = option.id.indexOf("/");
    if (slash <= 0) return true;
    return !injectIds.has(encodeInjectId(option.id.slice(0, slash), option.id.slice(slash + 1)));
  });
  let def = catalog.default;
  if (def && !options.some((option) => option.id === def)) {
    const slash = def.indexOf("/");
    const mapped = slash > 0 ? encodeInjectId(def.slice(0, slash), def.slice(slash + 1)) : "";
    def = injectIds.has(mapped) ? mapped : (options[0]?.id ?? "");
  }
  return { default: def, options };
}

export async function applyPiLocalCatalog(
  catalog: ModelCatalog,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCatalog> {
  return preferPiInjectRows(await mergeLocalInject(catalog, env, fetchImpl));
}

function piAgentDir(env: Record<string, string | undefined>): string {
  return join(env.HOME || env.USERPROFILE || homedir(), ".pi", "agent");
}

/** Upsert a live local host into ~/.pi/agent/models.json so `set_model`
 *  can reach it. Existing providers and models are kept. Returns the
 *  `{provider, modelId}` pair pi's RPC expects, or null when the picker
 *  id is not a model at all. */
export function ensurePiInjectModel(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): { provider: string; modelId: string } | null {
  const split = splitPiModel(modelId);
  if (!split) return null;
  const inject = decodeInjectId(modelId);
  if (!inject) return split;
  const host = localHost(inject.host);
  if (!host) return split;

  const dir = piAgentDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "models.json");
  let root: Record<string, unknown> = { providers: {} };
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      } else {
        // Malformed — do not destroy the file; still return the split so
        // set_model can try.
        return split;
      }
    } catch {
      return split;
    }
  }

  const providers =
    root.providers && typeof root.providers === "object" && !Array.isArray(root.providers)
      ? { ...(root.providers as Record<string, unknown>) }
      : {};
  const previous = providers[inject.host];
  const existing: Record<string, unknown> =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? { ...(previous as Record<string, unknown>) }
      : {
          baseUrl: host.baseUrl,
          api: "openai-completions",
          apiKey: hostApiKey(host, env),
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
          models: [] as Array<Record<string, unknown>>,
        };
  existing.baseUrl = host.baseUrl;
  existing.api = typeof existing.api === "string" && existing.api ? existing.api : "openai-completions";
  existing.apiKey = hostApiKey(host, env);
  if (!existing.compat) {
    existing.compat = { supportsDeveloperRole: false, supportsReasoningEffort: true };
  }
  const models: Array<Record<string, unknown>> = Array.isArray(existing.models)
    ? existing.models.filter(
        (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row),
      )
    : [];
  if (!models.some((row) => row.id === inject.model)) {
    models.push({
      id: inject.model,
      name: inject.model,
      reasoning: true,
      input: ["text"],
      contextWindow: 131072,
      maxTokens: 16384,
    });
  }
  existing.models = models;
  providers[inject.host] = existing;
  root.providers = providers;
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; keep the inject even if chmod is unsupported.
  }
  return split;
}

/** The pi-side default model, read from ~/.pi/agent/settings.json so the
 *  catalog's `default` matches what `pi` would actually run. Missing file →
 *  empty string, and the first option is used instead. */
function readPiDefaultModel(env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  try {
    const s = JSON.parse(readFileSync(`${home}/.pi/agent/settings.json`, "utf8")) as {
      defaultProvider?: string;
      defaultModel?: string;
    };
    return s.defaultProvider && s.defaultModel ? `${s.defaultProvider}/${s.defaultModel}` : "";
  } catch {
    return "";
  }
}

/** Probe the live catalog by spawning `pi --mode rpc --no-session`, sending
 *  `get_available_models`, and parsing the response. A failed probe resolves
 *  with an empty catalog — the instance reports unavailable via snapshot. */
export async function fetchPiModels(
  cli: string,
  env: Record<string, string | undefined>,
): Promise<ModelCatalog> {
  const child = spawnCli(cli, PI_ARGS, { stdio: ["pipe", "pipe", "pipe"], env });
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const fallbackDefault = readPiDefaultModel(env);
    const finish = (catalog: ModelCatalog) => {
      if (done) return;
      done = true;
      try {
        killCliTree(child);
      } catch {
        /* already gone */
      }
      resolve(catalog);
    };
    const timer = setTimeout(() => finish({ default: "", options: [] }), 15_000);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const parsed = parsePiCatalog(line + "\n", fallbackDefault);
        if (parsed.options.length || line.includes('"get_available_models"')) {
          clearTimeout(timer);
          finish(parsed);
          return;
        }
      }
    });
    child.on("error", () => finish({ default: "", options: [] }));
    child.on("close", () => finish({ default: "", options: [] }));
    try {
      child.stdin.write(JSON.stringify({ id: "catalog", type: "get_available_models" }) + "\n");
    } catch {
      finish({ default: "", options: [] });
    }
  });
}

export interface PiConfig {
  cli: string;
  /** Full-auto: never ask before an action. Host control is unavailable in
   * this mode — the same knob as Claude's `bypassPermissions` and the ACP
   * engines' `fullAuto`. */
  fullAuto: boolean;
}

function decodeConfig(raw: unknown): PiConfig {
  if (raw === null || raw === undefined) return { cli: "pi", fullAuto: false };
  if (typeof raw !== "object") throw new Error("pi config must be an object");
  const obj = raw as { cli?: unknown; fullAuto?: unknown };
  if (obj.cli !== undefined && typeof obj.cli !== "string") throw new Error("pi config `cli` must be a string");
  if (obj.fullAuto !== undefined && typeof obj.fullAuto !== "boolean") throw new Error("pi config `fullAuto` must be a boolean");
  return {
    cli: obj.cli && obj.cli.trim() ? obj.cli.trim() : "pi",
    fullAuto: obj.fullAuto === true,
  };
}

const EMPTY: ModelCatalog = { default: "", options: [] };

/** The parsed pi RPC event we branch on — only the fields this driver reads. */
interface PiEvent {
  type: string;
  // response
  command?: string;
  success?: boolean;
  data?: unknown;
  /** pi's reason on a `success:false` response. */
  error?: unknown;
  // message_update
  assistantMessageEvent?: { type?: string; delta?: string };
  // tool_execution_*
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  // turn_end / message_end
  message?: { stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number } };
  usage?: { input?: number; output?: number };
  // extension_ui_request
  id?: string;
  method?: string;
  options?: unknown[];
  title?: string;
}

function piEnvironment(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source, PATH: augmentedPath() };
  // pi is BYOK and reads provider keys straight from its environment: an
  // inherited key would silently flip billing onto one the user never granted
  // pi, and workspace credentials are the harness's secrets, not pi's. The
  // keys pi may use live in its own settings file, so the child inherits
  // neither list.
  stripWorkspaceCredentialEnv(env);
  for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
  // pi is OpenAI-compatible and reads OPENAI_BASE_URL: an ambient one from a
  // provider switcher would redirect every turn away from pi's own settings.
  stripRoutingEnv(env);
  return env;
}

export const PiDriver: ProviderDriver<PiConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "pi", supportsMultipleInstances: true, access: "custom" },
  install: {
    command: {
      darwin: "npm install -g @earendil-works/pi-coding-agent",
      linux: "npm install -g @earendil-works/pi-coding-agent",
      win32: "npm install -g @earendil-works/pi-coding-agent",
    },
    needsNode: true,
    docsUrl: "https://pi.dev",
  },
  models: EMPTY,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<PiConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const catalogEnv = piEnvironment({ ...process.env, ...input.environment });
    let models = EMPTY;
    const refreshModels = async () => {
      let base = models;
      try {
        const resolved = await fetchPiModels(config.cli, catalogEnv);
        if (resolved.options.length) base = resolved;
      } catch {
        // Keep the last usable catalog when the probe fails.
      }
      try {
        const next = await applyPiLocalCatalog(base, catalogEnv);
        if (next.options.length) models = next;
      } catch {
        if (base.options.length) models = base;
      }
    };
    await refreshModels();

    const listeners = new Set<RuntimeEventListener>();
    // one active turn per thread
    const active = new Map<string, {
      stop: () => void;
      turnId: string;
      pending: Map<string, (decision: { behavior: "allow" | "deny" | "answer"; message?: string }) => void>;
      child?: { stdin: { write: (s: string) => void } };
      /** Asks opened as host-control permission requests (local-computer scope). */
      scopedRequests: Set<string>;
    }>();
    // settle() emits the terminal event and then requests termination; the
    // child is owned until its close is observed (A2).
    const teardowns = new TurnTeardowns();
    // pi requests the kill in the same tick as settlement, so no grace period.
    const piStopBudget = (): TeardownWait => {
      const closeMs = providerCloseDeadlineMs();
      return { closeMs, maxMs: closeMs };
    };

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      // Host control always routes through the permission card; full-auto must
      // never get unapproved hands on the user's machine (same guard as the
      // Claude and ACP drivers).
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      if (controlsHost && config.fullAuto) {
        throw new Error("local computer control requires the interactive approval broker");
      }
      const turnId = newId();
      const pending = new Map<string, (decision: { behavior: "allow" | "deny" | "answer"; message?: string }) => void>();
      const scopedRequests = new Set<string>();
      let settled = false;

      // An explicit pick must land on exactly that provider/model. A bare id
      // carries no provider, so set_model cannot pin it, and prompting anyway
      // would run pi's configured default — possibly a hosted, billed provider
      // in place of a local or private pick. Fail before anything is spawned.
      const requestedModel = typeof turn.model === "string" && turn.model ? turn.model : null;
      const chosen = requestedModel ? splitPiModel(requestedModel) : null;
      if (requestedModel && !chosen) {
        emit({ ...base(threadId, turnId), type: "turn.started" });
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `pi could not select model "${requestedModel.slice(0, 200)}": pi needs a provider/model id. Choose a model from pi's list.`,
        });
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "failed" });
        return { turnId };
      }

      // Write ~/.pi/agent/models.json before creating any credential-bearing
      // MCP temp files. If model setup fails, there is nothing sensitive to
      // clean up yet.
      if (requestedModel) {
        ensurePiInjectModel(requestedModel, { ...process.env, ...input.environment });
      }

      // integrations → stdio MCP servers for the pi-mcp-extension. The config
      // carries credentials (box token, composio key, comms token), so it goes
      // into a 0600 temp file removed when the turn settles — never on argv.
      const mcpServers = buildMcpServers(turn);
      let mcpTempDir: string | null = null;
      if (mcpServers) {
        mcpTempDir = mkdtempSync(join(tmpdir(), "murage-pi-mcp-"));
        try {
          writeFileSync(join(mcpTempDir, "mcp.json"), JSON.stringify({ mcpServers }), { mode: 0o600 });
        } catch (err) {
          // A failed write must not leave the temp dir behind — a partial file
          // could still hold the box token / composio key / comms token.
          try {
            rmSync(mcpTempDir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
          throw err;
        }
      }
      const childArgs = mcpServers ? [...PI_ARGS, "-e", SPAWNED_PROXIES.piMcpExtension] : PI_ARGS;

      // spawnCli can throw synchronously (unresolvable CLI); if it does, the
      // 0600 temp file with the box token / composio key / comms token must
      // not be left on disk — settle() never runs because no child existed.
      const child = (() => {
        try {
          return spawnCli(config.cli, childArgs, {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: turn.cwd,
            env: piEnvironment({
              ...process.env,
              ...input.environment,
              ...(mcpServers && mcpTempDir ? { MURAGE_MCP_CONFIG: join(mcpTempDir, "mcp.json") } : {}),
            }),
          });
        } catch (err) {
          if (mcpTempDir) {
            try {
              rmSync(mcpTempDir, { recursive: true, force: true });
            } catch {
              /* best effort */
            }
          }
          throw err;
        }
      })();
      const teardown = teardowns.track(threadId, turnId, child);
      let buf = "";
      let assistantText = "";
      // resolve one-shot RPC responses (new_session / switch_session / set_model)
      const responseWaiters = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
      const rejectWaiters = (err: Error) => {
        for (const waiter of responseWaiters.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(err);
        }
        responseWaiters.clear();
      };
      const awaitResponse = (command: string, timeoutMs = 20_000) =>
        new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            responseWaiters.delete(command);
            reject(new Error(`pi ${command} timed out`));
          }, timeoutMs);
          timer.unref?.();
          responseWaiters.set(command, { resolve, reject, timer });
        });
      /** The bounded reason a one-shot RPC failed, for a user-facing error. */
      const rpcFailure = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);
      child.stdin.on("error", () => rejectWaiters(new Error("pi stdin closed")));
      const send = (obj: Record<string, unknown>) => {
        appendNative(threadId, { dir: "out", source: "pi.rpc", msg: obj });
        child.stdin.write(JSON.stringify(obj) + "\n");
      };

      /** Emit buffered assistant text as its own item, then clear it. */
      const flushAssistantText = () => {
        const text = assistantText;
        assistantText = "";
        if (!text.trim()) return;
        emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
      };

      const settle = (ok: boolean, stopReason?: string | null, usage?: { input?: number; output?: number }) => {
        if (settled) return;
        settled = true;
        flushAssistantText();
        emit({
          ...base(threadId, turnId),
          type: "turn.completed",
          ok,
          stopReason: stopReason ?? (ok ? "end_turn" : "failed"),
          ...(usage ? { usage: { input: usage.input ?? 0, output: usage.output ?? 0 } } : {}),
        });
        try {
          child.stdin.end();
        } catch {
          /* already closed */
        }
        teardown.markStopRequested();
        try {
          killCliTree(child);
        } catch {
          /* already gone */
        }
        if (mcpTempDir) {
          try {
            rmSync(mcpTempDir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }
        active.delete(threadId);
      };

      const stop = () => {
        try {
          send({ type: "abort" });
        } catch {
          /* ignore */
        }
        teardown.markStopRequested();
        try {
          killCliTree(child);
        } catch {
          /* ignore */
        }
        settle(true, "cancelled");
      };
      active.set(threadId, { stop, turnId, pending, child, scopedRequests });

      const onEvent = (evt: PiEvent) => {
        appendNative(threadId, { dir: "in", source: "pi.rpc", msg: evt });
        switch (evt.type) {
          case "response": {
            if (evt.command && responseWaiters.has(evt.command)) {
              const waiter = responseWaiters.get(evt.command)!;
              responseWaiters.delete(evt.command);
              clearTimeout(waiter.timer);
              if (evt.success) waiter.resolve(evt.data);
              else {
                const reason = typeof evt.error === "string" && evt.error.trim() ? evt.error.trim() : "no reason given";
                waiter.reject(new Error(`pi ${evt.command} failed: ${reason}`));
              }
            }
            return;
          }
          case "message_update": {
            const e = evt.assistantMessageEvent;
            if (!e) return;
            if (e.type === "text_delta" && typeof e.delta === "string") {
              assistantText += e.delta;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: e.delta });
            } else if (e.type === "thinking_delta" && typeof e.delta === "string") {
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta: e.delta });
            }
            return;
          }
          case "tool_execution_start": {
            flushAssistantText();
            emit({
              ...base(threadId, turnId),
              type: "item.started",
              itemType: "tool",
              itemId: evt.toolCallId,
              title: String(evt.toolName ?? "tool").slice(0, 80),
            });
            return;
          }
          case "tool_execution_end": {
            emit({
              ...base(threadId, turnId),
              type: "item.completed",
              itemType: "tool",
              itemId: evt.toolCallId,
              ok: !evt.isError,
            });
            return;
          }
          case "extension_ui_request": {
            // pi floods setWidget/setStatus for TUI bookkeeping; only
            // select/confirm/input are questions that wait for an answer.
            if (evt.method === "select" || evt.method === "confirm" || evt.method === "input") {
              flushAssistantText();
              const reqId = evt.id ?? newId();
              const isQuestion = evt.method === "input";
              // Carry the trusted host-control scope to the shared policy
              // gate, as the Claude, Codex and ACP drivers do. Without it
              // index.ts treats the card as ordinary: it offers a bare-title
              // "Always allow" and a remembered grant later auto-approves
              // host actions with Auto off (A7). pi's extension protocol has
              // no trusted per-call tag — the title is extension-composed text
              // and is never parsed for this — so every permission ask on a
              // host-controlling turn is scoped conservatively. Questions are
              // not permissions and always reach the human anyway.
              const scoped = controlsHost && !isQuestion;
              if (scoped) scopedRequests.add(reqId);
              // A `select` asks the owner to pick an option — a question, even
              // while it is still carded as a permission here. The method is
              // pi's trusted signal (the title is extension text), so it rides
              // on the event and the harness never auto-approves, remembers or
              // AI-reviews it. `confirm` stays an ordinary permission.
              const questionTool = evt.method === "select";
              // Register BEFORE emitting: the harness may auto-approve from
              // inside its synchronous request.opened listener. Emitting first
              // made respondToRequest see no pending ask, return unavailable,
              // then fall back to a human card on every "Always allow" call.
              pending.set(reqId, (decision) => {
                if (decision.behavior === "deny") send({ type: "extension_ui_response", id: reqId, cancelled: true });
                else if (isQuestion) send({ type: "extension_ui_response", id: reqId, value: decision.message ?? "" });
                else send({ type: "extension_ui_response", id: reqId, confirmed: true });
              });
              emit({
                ...base(threadId, turnId),
                requestId: reqId,
                type: "request.opened",
                requestType: isQuestion ? "question" : "permission",
                tool: String(evt.title ?? "pi"),
                summary: String(evt.title ?? "pi wants confirmation"),
                ...(scoped ? { approvalScope: "local-computer" as const } : {}),
                ...(questionTool ? { questionTool: true as const } : {}),
              });
            }
            return;
          }
          case "turn_end":
          case "agent_end": {
            const sr = evt.message?.stopReason;
            // toolUse means pi ran a tool and auto-continues next turn to
            // answer — settling now would drop the final reply.
            if (sr === "toolUse" || sr === "tool_use" || sr === "tool_calls") return;
            const usage = evt.usage ?? evt.message?.usage;
            if (sr === "error" || sr === "failed") {
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message: String(evt.message?.errorMessage ?? "pi turn failed").slice(0, 2_000),
              });
              settle(false, "failed", usage);
              return;
            }
            settle(true, sr === "cancelled" || sr === "aborted" ? "cancelled" : "end_turn", usage);
            return;
          }
          default:
            return;
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            onEvent(JSON.parse(line) as PiEvent);
          } catch {
            /* skip non-JSON line */
          }
        }
      });
      child.on("error", (err) => {
        const fail = describeSpawnFailure(err as NodeJS.ErrnoException, config.cli);
        rejectWaiters(new Error(fail.message));
        emit({ ...base(threadId, turnId), type: "runtime.error", message: fail.message, setup: fail.setup });
        settle(false);
      });
      child.on("close", () => {
        // a clean close without a terminal event is a failed turn, never a hang
        rejectWaiters(new Error("pi process exited before replying"));
        settle(false);
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });

      /** Fail the turn before the prompt is dispatched: surface why, settle
       * ok:false and stop the child (settle kills it). A no-op once the turn
       * has already settled — e.g. the child exited, or the user cancelled. */
      const failBeforePrompt = (message: string) => {
        if (settled) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", message });
        settle(false, "failed");
      };

      // handshake: resume the remembered session or start a fresh one. The
      // harness persists session.started.sessionId as the resumeCursor and
      // hands it back next turn, so that id IS the resume handle — pi's
      // sessionFile, which switch_session expects as `sessionPath`.
      const sessionPath = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      let sessionFile = sessionPath;
      try {
        const command = sessionPath ? "switch_session" : "new_session";
        const hsPromise = awaitResponse(command);
        send(sessionPath ? { type: "switch_session", sessionPath } : { type: "new_session" });
        const hs = (await hsPromise) as { sessionFile?: string; sessionId?: string } | undefined;
        if (hs?.sessionFile) sessionFile = hs.sessionFile;
        emit({
          ...base(threadId, turnId),
          type: "session.started",
          sessionId: sessionFile ?? hs?.sessionId ?? null,
          model: turn.model ?? null,
        });
      } catch (err) {
        // A failed handshake is not a fresh start. Prompting anyway would run
        // this turn without the thread's conversation (a resumed thread would
        // silently lose its history), or talk to a child that is already gone.
        failBeforePrompt(
          sessionPath
            ? `pi could not resume this thread's session: ${rpcFailure(err)}`
            : `pi could not start a session: ${rpcFailure(err)}`,
        );
        return { turnId };
      }
      if (settled) return { turnId };

      // pin the chosen model (composite id or host::model inject → provider + modelId)
      if (chosen && requestedModel) {
        try {
          const modelPromise = awaitResponse("set_model");
          send({ type: "set_model", provider: chosen.provider, modelId: chosen.modelId });
          await modelPromise;
        } catch (err) {
          // Never fall back to pi's default model: that can move a local or
          // private pick onto a hosted or paid provider the user did not choose.
          failBeforePrompt(`pi could not select model "${requestedModel.slice(0, 200)}": ${rpcFailure(err)}`);
          return { turnId };
        }
        if (settled) return { turnId };
      }

      // pin reasoning effort after the model (the supported level set is
      // model-dependent); a rejection keeps the engine default
      if (turn.effort) {
        try {
          const levelPromise = awaitResponse("set_thinking_level");
          send({ type: "set_thinking_level", level: piThinkingLevel(turn.effort) });
          await levelPromise;
        } catch {
          /* keep going on the engine default */
        }
      }
      // cancelled or exited while pinning: nothing left to prompt
      if (settled) return { turnId };

      const message = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
      try {
        send({ type: "prompt", message });
      } catch {
        settle(false);
      }

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        const child = spawnCli(config.cli, ["--version"], {
          stdio: ["ignore", "pipe", "pipe"],
          env: piEnvironment({ ...process.env, ...input.environment }),
        });
        let out = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (c: string) => (out += c));
        const timer = setTimeout(() => {
          try {
            killCliTree(child);
          } catch {
            /* ignore */
          }
          resolve(null);
        }, 8000);
        timer.unref?.();
        child.on("error", () => {
          clearTimeout(timer);
          resolve(null);
        });
        child.on("close", () => {
          clearTimeout(timer);
          resolve(out.trim() || null);
        });
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      // pi manages its own credentials (~/.pi/agent/auth.json); there is no
      // separate sign-in step the harness can probe, so treat it as authed.
      return { state: "available", version, authenticated: true };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          // model is set per turn via set_model before prompt
          sessionModelSwitch: "in-session",
          // Integrations arrive as stdio MCP servers mounted by the
          // pi-mcp-extension (pi core has no MCP client of its own).
          agentsMcp: true,
          memoryMcp: true,
          computerMcp: true,
          composioMcp: true,
          phoneMcp: true,
          // Host control (the user's real Mac) rides the pi-native permission
          // card (`ctx.ui.confirm` → extension_ui_request) gated in the
          // extension, so it is offered exactly when the other engines offer
          // it: enabled unless the bot is in full-auto.
          localComputerMcp: !config.fullAuto,
          // Images ride the ordinary prompt as <attached-image path> refs the
          // agent opens with its read tool — no native image blocks needed,
          // same as every other CLI engine.
          images: true,
          // Reasoning effort pins pi's thinking level per turn (none → off).
          // xhigh/max only land on models that expose them; pi rejects an
          // unsupported level and the turn keeps the engine default.
          effortLevels: EFFORT_LEVELS,
        },
        sendTurn,
        // Close-confirmed stop (A2): stop() settles and requests termination;
        // resolve only after the child closed, reject at the deadline.
        interruptTurn: async (threadId, turnId) => {
          active.get(threadId)?.stop();
          const result = await teardowns.wait(threadId, turnId, piStopBudget());
          if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
          return result;
        },
        awaitTurnTeardown: (threadId, turnId) => teardowns.wait(threadId, turnId, piStopBudget()),
        respondToRequest: async (threadId, requestId, decision) => {
          const entry = active.get(threadId);
          const answer = entry?.pending.get(requestId);
          if (!entry || !answer) return "unavailable";
          entry.pending.delete(requestId);
          const scoped = entry.scopedRequests.delete(requestId);
          answer({ behavior: decision.behavior, message: decision.message });
          emit({
            ...base(threadId, entry.turnId),
            requestId,
            type: "request.resolved",
            behavior: decision.behavior,
            source: "user",
            ...(scoped ? { approvalScope: "local-computer" as const } : {}),
          });
          return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
          const result = await teardowns.waitAll(piStopBudget());
          if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const { stop } of active.values()) stop();
        const result = await teardowns.waitAll(piStopBudget());
        if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
        listeners.clear();
      },
    };
  },
};
