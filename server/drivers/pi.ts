import { cliSig, engineLaunchFile, knownCliVersion, memoDeps, noteVersionProbe, pathExists, rememberCliVersion, versionProbeAllowed } from "./isolation-cache.ts";
import { engineUpdateRequired } from "./scoped-cli-home.ts";
import { cloudTurnBot, cloudTurnEnvironment } from "../cloud-home/turn-process.ts";
import { cloudHomeCopy } from "../cloud-home/copy.ts";
import { PI_TOOL_SURFACE, renderMurageTurn } from "../murage-tool-surface.ts";
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
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { deleteEnvNames, PROVIDER_CREDENTIAL_ENV, stripRoutingEnv, stripWorkspaceCredentialEnv } from "../config.ts";
import { augmentedPath, envGeneration } from "../env-path.ts";
import { gitBashPath } from "../tool-discovery.ts";
import { CLI_TERM_GRACE_MS, cliVersionReader, describeSpawnFailure, engineJob, killCliTree, spawnCli, HOST_POWER_CODE, hostPowerMessage, hostPowerRefused } from "../procs.ts";
import { ProviderStopUnconfirmedError, stopBudget, TurnTeardowns, type TeardownWait } from "./child-teardown.ts";
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
import { createBoundedLineSplitter, FRAME_TOO_LARGE, frameOverflowMessage } from "./bounded-lines.ts";
import { registerIntake } from "../harness/intake.ts";
import { fromPi, toPiValue, type QuestionAnswer, type QuestionSpec } from "../question-normalize.ts";
import { QUESTION_TIMEOUT_MS } from "../../shared/questions.ts";
import { localContextWindow, type LocalHost } from "./local-inject.ts";
import { isPlainObject, readNativeJsonConfig } from "./native-config-file.ts";
import { primeLocalContext } from "../local-server-probe.ts";
import { approvalSummary } from "../../shared/approval-summary.ts";
import { boundedToolInput } from "../approval-text.ts";
import type { McpMountRecord } from "../../shared/mount-identity.ts";
import { PI_GATE_TITLE_PREFIX } from "./pi-permission-gate.ts";
import { execEnvHanded, execEnvNow, handedEngineEnv } from "../engine-env.ts";
import type { ExecEnv } from "../../shared/mount-identity.ts";
import { createTodoBlockFilter, extractTodoBlocks, type TodoFilterOutput } from "../../shared/todo-block.ts";
import { engineClosedLine, plainDuration } from "./stop-copy.ts";
import { EngineStderrCapture } from "./acp/core.ts";
import { redactSecretsInText } from "../redact.ts";
import { toolFailureText } from "../../shared/tool-activity.ts";
import { buildMcpServers, piMountRecords } from "./mcp-mounts.ts";
import { wakeAwareTimeout } from "../sleep-clock.ts";

/** Pi's window for a local model whose server has not reported one. */
const PI_UNKNOWN_CONTEXT_WINDOW = 131072;
const PI_UNKNOWN_MAX_TOKENS = 16384;
/** Local OpenAI-compatible servers (serving research §3; pi-mono models.md):
 *  no `developer` role, no `store`, and `max_tokens` rather than
 *  `max_completion_tokens`. Only missing keys are added to an existing row. */
const PI_LOCAL_COMPAT: Record<string, unknown> = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsStore: false,
  maxTokensField: "max_tokens",
};

function piMaxTokens(contextWindow: number): number {
  return Math.min(PI_UNKNOWN_MAX_TOKENS, Math.max(1024, Math.floor(contextWindow / 4)));
}

const DRIVER_KIND = "piAgent";
const PI_ARGS = ["--mode", "rpc", "--no-session"];

/**
 * The owner's personal pi setup stays out of a bot's turns (same principles as
 * the Claude engine's design B, claude.ts claudeIsolation): pi auto-discovers
 * ~/.pi/agent extensions (and installed packages), skills, prompt templates
 * and themes, and loads ~/.pi/agent/AGENTS.md plus every AGENTS.md/CLAUDE.md
 * from the cwd up to the filesystem root. Murage's own extensions ride `-e`,
 * which `--no-extensions` keeps ("explicit -e paths still work", pi --help).
 * `--no-context-files` drops the project's own file too, so the files between
 * the turn's folder and the owner's home (exclusive) are handed back with
 * `--append-system-prompt <file>`, root first, as pi would have ordered them.
 * Floors from pi's CHANGELOG: --no-extensions works from 0.48.0 (#776 fix),
 * --no-skills 0.39.0, --no-prompt-templates/--no-themes 0.50.0,
 * --no-context-files 0.67.4. A version below the newest floor, or unknown
 * (the probe is retried once), is rejected: the turn does not start and the
 * owner is told to update pi.
 * Rig (build host, pi 0.73.1, fake model): before = personal extension tool,
 * personal skill and global AGENTS.md in the request; after = none of them,
 * project AGENTS.md and an explicit `-e` extension's tool still present.
 */
const PI_ISOLATION_FLAGS: ReadonlyArray<readonly [string, readonly [number, number, number]]> = [
  ["--no-extensions", [0, 48, 0]],
  ["--no-skills", [0, 39, 0]],
  ["--no-prompt-templates", [0, 50, 0]],
  ["--no-themes", [0, 50, 0]],
  ["--no-context-files", [0, 67, 4]],
];

/** The newest floor above: the first pi that has every switch. */
export const PI_ISOLATION_MIN = [0, 67, 4] as const;

function piSemver(text: string | undefined): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const piAtLeast = (v: readonly number[], min: readonly number[]) =>
  v[0]! !== min[0]! ? v[0]! > min[0]! : v[1]! !== min[1]! ? v[1]! > min[1]! : v[2]! >= min[2]!;

/** The project's own context files, root first, from `cwd` up to (not
 *  including) `home`; at or above home they are the owner's or the
 *  machine's, not the project's. A folder outside home keeps pi's whole walk
 *  to the root. pi takes AGENTS.md, else CLAUDE.md, per folder. */
export function piProjectContextFiles(cwd: string | undefined, home: string): string[] {
  if (!cwd) return [];
  return memoDeps("pi-context-files", JSON.stringify([cwd, home]), () => walkPiProjectContextFiles(cwd, home));
}

function walkPiProjectContextFiles(cwd: string, home: string): string[] {
  const files: string[] = [];
  const stop = resolve(home);
  let dir = resolve(cwd);
  const rel = relative(stop, dir);
  if (rel === "") return [];
  // Outside home, pi's own walk to the root is the project's (and the volume's); kept whole.
  const inHome = !rel.startsWith("..") && !isAbsolute(rel);
  for (let depth = 0; (!inHome || dir !== stop) && depth < 64; depth++) {
    const found = ["AGENTS.md", "CLAUDE.md"].map((name) => join(dir, name)).find((path) => pathExists(path));
    if (found) files.unshift(found);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return files;
}

/** Isolation argv for one pi turn, given the probed `pi --version`. */
export function piIsolationArgs(version: string | undefined, cwd: string | undefined, home: string): string[] {
  const v = piSemver(version);
  // Fails closed: a pi that lacks any of these switches (or whose version cannot be read) would load the owner's own
  // extensions, skills, prompt templates or AGENTS.md into the bot, so the turn is rejected and the owner told to update pi.
  if (!v || !piAtLeast(v, PI_ISOLATION_MIN)) throw engineUpdateRequired("Pi", version?.trim() || undefined, PI_ISOLATION_MIN);
  const flags = PI_ISOLATION_FLAGS.filter(([, min]) => piAtLeast(v, min)).map(([flag]) => flag);
  if (!flags.includes("--no-context-files")) return flags;
  return [...flags, ...piProjectContextFiles(cwd, home).flatMap((file) => ["--append-system-prompt", file])];
}

const PI_ERROR_DETAIL_MAX = 200;
// Absolute paths under a home, data or temp root. Only the last segment
// survives, so the row does not reveal the machine's layout.
const PI_ABS_PATH = /(?:[A-Za-z]:\\(?:[^\s\\'"`]+\\)+|\/(?:Users|home|root|data|var|opt|tmp|private|Volumes|mnt|srv)(?:\/[^\s/'"`]+)*\/)([^\s/\\'"`]+)/g;

/** The short reason a failed pi tool call gives, for its activity row: the
 * result's own text (a string, or text content parts), first line, redacted,
 * paths cut to their last segment. Never the call's arguments. */
export function piToolErrorDetail(evt: { result?: unknown; error?: unknown }): string | undefined {
  const raw = typeof evt.result === "string" ? evt.result : toolFailureText(evt.result) ?? (typeof evt.error === "string" ? evt.error : undefined);
  const line = raw?.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return undefined;
  const text = redactSecretsInText(line.replace(PI_ABS_PATH, "…/$1")).slice(0, PI_ERROR_DETAIL_MAX).trim();
  return text || undefined;
}

/** Harness effort → pi thinking level (`set_thinking_level`). The sets match
 * one-for-one except for the name of the lowest rung: the harness calls it
 * "none", pi calls it "off". Exported for the test. */
export function piThinkingLevel(effort: EffortLevel): (typeof EFFORT_LEVELS)[number] | "off" {
  return effort === "none" ? "off" : effort;
}

export { buildMcpServers, piMountRecords } from "./mcp-mounts.ts";

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
          compat: { ...PI_LOCAL_COMPAT },
          models: [] as Array<Record<string, unknown>>,
        };
  existing.baseUrl = host.baseUrl;
  existing.api = typeof existing.api === "string" && existing.api ? existing.api : "openai-completions";
  existing.apiKey = hostApiKey(host, env);
  if (!existing.compat) {
    existing.compat = { ...PI_LOCAL_COMPAT };
  } else if (isPlainObject(existing.compat)) {
    existing.compat = { ...PI_LOCAL_COMPAT, ...existing.compat };
  }
  const models: Array<Record<string, unknown>> = Array.isArray(existing.models)
    ? existing.models.filter(
        (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row),
      )
    : [];
  // Spec T2: the window the server actually loaded, not a fixed 131k. A row
  // still carrying the old fixed pair (Murage wrote it) is corrected once a
  // real value is known; a row the user sized differently is left alone.
  const probed = localContextWindow(inject.host, inject.model);
  const contextWindow = probed ?? PI_UNKNOWN_CONTEXT_WINDOW;
  const current = models.find((row) => row.id === inject.model);
  if (!current) {
    models.push({
      id: inject.model,
      name: inject.model,
      reasoning: true,
      input: ["text"],
      contextWindow,
      maxTokens: piMaxTokens(contextWindow),
    });
  } else if (probed && current.contextWindow === PI_UNKNOWN_CONTEXT_WINDOW && current.maxTokens === PI_UNKNOWN_MAX_TOKENS) {
    current.contextWindow = probed;
    current.maxTokens = piMaxTokens(probed);
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

/** Spec A3: drop the provider Murage wrote for a removed local server. */
export function removePiLocalHost(
  host: LocalHost,
  env: Record<string, string | undefined> = process.env,
): "removed" | "absent" {
  const path = join(piAgentDir(env), "models.json");
  const existing = readNativeJsonConfig(path, env.HOME || env.USERPROFILE || homedir());
  if (!existing) return "absent";
  const providers = existing.value.providers;
  if (!isPlainObject(providers) || !Object.hasOwn(providers, host.id)) return "absent";
  const next = { ...providers };
  delete next[host.id];
  writeFileSync(path, `${JSON.stringify({ ...existing.value, providers: next }, null, 2)}\n`, { mode: 0o600 });
  return "removed";
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
    // Byte-bounded framing (A4): an oversized catalog frame is never parsed;
    // the probe resolves empty, the same as any other failed probe.
    const stdoutLines = createBoundedLineSplitter({
      onLine: (line) => {
        if (done || !line.trim()) return;
        const parsed = parsePiCatalog(line + "\n", fallbackDefault);
        if (parsed.options.length || line.includes('"get_available_models"')) {
          clearTimeout(timer);
          finish(parsed);
        }
      },
      onOverflow: () => {
        clearTimeout(timer);
        finish({ default: "", options: [] });
      },
    });
    child.stdout.on("data", (chunk: Buffer) => stdoutLines.push(chunk));
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
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  // turn_end / message_end
  message?: { stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number } };
  usage?: { input?: number; output?: number };
  // extension_ui_request
  id?: string;
  method?: string;
  options?: unknown[];
  title?: string;
  placeholder?: string;
  prefill?: string;
}

/** Settles one pi extension_ui_request. A question's `answer` carries the
 * owner's validated picks (0.1.52 ASK3); `deny` on a question is a skip. */
type PiAskAnswer = (decision: { behavior: "allow" | "deny" | "answer"; message?: string; answers?: QuestionAnswer[] }) => void;

function piEnvironment(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...cloudTurnEnvironment("pi", source, ["MURAGE_MCP_CONFIG", "MURAGE_PI_GATE", "MURAGE_PI_GATE_PREFIXES", "MURAGE_PI_GATE_ONLY"]), PATH: augmentedPath() };
  // pi is BYOK and reads provider keys straight from its environment: an
  // inherited key would silently flip billing onto one the user never granted
  // pi, and workspace credentials are the harness's secrets, not pi's. The
  // keys pi may use live in its own settings file, so the child inherits
  // neither list.
  stripWorkspaceCredentialEnv(env);
  deleteEnvNames(env, PROVIDER_CREDENTIAL_ENV);
  // pi is OpenAI-compatible and reads OPENAI_BASE_URL: an ambient one from a
  // provider switcher would redirect every turn away from pi's own settings.
  stripRoutingEnv(env);
  return env;
}

/** What a pi-permission-gate ask is about, as the card and the guards read it. */
export interface PiGateAsk {
  tool: string;
  summary: string;
  toolInput?: string;
  toolCall?: { name: string; input: unknown };
  filePaths?: string[];
  /** The gate could not send the call whole (its input ran past
   * PI_GATE_MESSAGE_MAX), or sent a shape this could not read: what the card
   * shows is not the whole call. The ask is then unproven: no standing grant
   * is offered and no mode answers it (server/auto-approve.ts unread-call). */
  truncated?: true;
  /** F5: a field the contract needs was absent on the wire. */
  toolInputMissing?: string;
  /** 1.0.4 09-1: the gate held this call as a key file (it resolves links
   * itself); the rule it named. Only ever adds a hold. */
  localHold?: string;
  /** Rule 13/16: a mounted MCP tool is filed as `{namespace: "mcp", name:
   * "<engineName>__<mcpTool>"}`, resolved against F4 by exact engineName; a
   * call the gate could not tie to a mount is `{namespace: "", name: ""}`
   * (unproven). Pi's own tools carry none. */
  toolIdentity?: { namespace: string; name: string };
  /** The input exactly as the gate sent it: echoed back on Allow (Rule 73d). */
  gateInput?: Record<string, unknown>;
}

/** Rule 13: the identity of an ask that did not come from this turn's gate. */
export const PI_UNPROVEN_IDENTITY = { namespace: "", name: "" } as const;
/** The owner-facing reason for a call the gate sent cut. */
const PI_GATE_CUT_REASON = "Murage could not read this call whole, so it did not run.";


/**
 * What a pi-permission-gate ask is about, from the JSON the gate sends. The
 * stop line reads `toolCall` (a shell command, a file, a connected-app call,
 * any other tool by pi's own name for it), so these carry the engine's own
 * input, never display text. A message that does not parse, carries the
 * gate's `truncated` mark, or names a tool without the input that tool needs
 * is a cut call: it is marked so, and never filed under the engine's own name
 * as if that named the tool (Astra r3).
 */
export function piGateAsk(message: string, mounts: readonly McpMountRecord[] = []): PiGateAsk {
  const ask = piGateCall(message, mounts);
  // 1.0.4 09-1: the gate's own key-file verdict (it follows links); it can only add a hold
  let hold: unknown;
  try { hold = (JSON.parse(message) as { sensitive?: unknown } | null)?.sensitive; } catch { hold = undefined; }
  return typeof hold === "string" && hold ? { ...ask, localHold: hold.slice(0, 80) } : ask;
}

function piGateCall(message: string, mounts: readonly McpMountRecord[]): PiGateAsk {
  let parsed: { tool?: unknown; input?: unknown; truncated?: unknown; mount?: unknown; mcpTool?: unknown; note?: unknown } = {};
  let readable = false;
  try {
    const value: unknown = JSON.parse(message);
    if (value && typeof value === "object" && !Array.isArray(value)) { parsed = value as typeof parsed; readable = true; }
  } catch {
    // unreadable: a cut call, below
  }
  const tool = typeof parsed.tool === "string" ? parsed.tool.trim() : "";
  const input = parsed.input && typeof parsed.input === "object" && !Array.isArray(parsed.input) ? (parsed.input as Record<string, unknown>) : undefined;
  const cut = !readable || !tool || parsed.truncated === true;
  const shown = tool ? `pi wants to use ${tool.slice(0, 80)}` : "pi wants to run a tool";
  const note = typeof parsed.note === "string" && parsed.note ? ` (${parsed.note.slice(0, 200)})` : "";
  // Rule 14b: a mounted MCP tool. The mount is resolved against F4 by exact
  // engineName; one that matches no record, or more than one, is unproven.
  if (parsed.mount !== undefined || parsed.mcpTool !== undefined) {
    const mount = typeof parsed.mount === "string" ? parsed.mount : "";
    const mcpTool = typeof parsed.mcpTool === "string" ? parsed.mcpTool : "";
    const matches = mount && !mount.includes("__") ? mounts.filter((record) => record.engineName === mount) : [];
    if (matches.length !== 1 || !mcpTool) {
      return { tool: tool || "pi", summary: `${shown} (Murage could not tell which app this is)${note}`, truncated: true, toolIdentity: PI_UNPROVEN_IDENTITY };
    }
    const name = `mcp__${mount}__${mcpTool}`;
    const identity = { namespace: "mcp", name: `${mount}__${mcpTool}` };
    if (cut) return { tool: name, summary: `${mcpTool.slice(0, 300)} (the call was cut)${note}`, truncated: true, toolIdentity: identity };
    if (!input) return { tool: name, summary: `${mcpTool.slice(0, 300)} (the call was cut)${note}`, truncated: true, toolInputMissing: "input", toolIdentity: identity };
    return { tool: name, summary: `${mcpTool.slice(0, 300)}${note}`, ...(boundedToolInput(input) ? { toolInput: boundedToolInput(input) } : {}), toolCall: { name, input }, toolIdentity: identity, gateInput: input };
  }
  const display = tool === "bash" ? "Bash" : tool === "powershell" ? "PowerShell" : tool === "edit" ? "Edit" : tool === "write" ? "Write" : tool || "pi";
  if (cut) return { tool: display, summary: `${shown} (the call was cut)${note}`, truncated: true };
  if (!input) return { tool: display, summary: `${shown} (the call was cut)${note}`, truncated: true, toolInputMissing: "input" };
  // Rule 15: the WHOLE input, every field, is the call; nothing is projected.
  const base = { toolCall: { name: tool, input }, gateInput: input };
  if (tool === "bash" || tool === "powershell") {
    // F5: a command that is not a string is never read as one
    if (typeof input.command !== "string") return { tool: display, summary: `${shown} (the command was cut)`, truncated: true, toolInputMissing: "command" };
    return { tool: display, summary: approvalSummary(input.command), ...base };
  }
  if (tool === "edit" || tool === "write") {
    if (typeof input.path !== "string") return { tool: display, summary: `${shown} (the file was cut)`, truncated: true, toolInputMissing: "path" };
    return { tool: display, summary: `${display} ${input.path}`.slice(0, 2_000), ...base, filePaths: [input.path] };
  }
  // Any other gated tool (read, grep, find, ls) is filed under pi's own name
  // for it, with its input. The engine's name ("pi") never stands in for a tool.
  return { tool, summary: `${shown}${note}`, ...(boundedToolInput(input) ? { toolInput: boundedToolInput(input) } : {}), ...base };
}

/** Rule 14b/54: stamp each server of the written mcp.json with its mountId,
 * which the extension copies into the gate's table, and mark that the gate
 * asks so the tool raises no confirm of its own. */
export function stampMcpServers(turn: SendTurnInput, servers: Record<string, unknown> | null, gated: boolean): Record<string, unknown> | null {
  if (!servers) return servers;
  const ids = new Map(piMountRecords(turn, servers).map((record) => [record.engineName, record.mountId]));
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(servers)) {
    const id = ids.get(name);
    out[name] = def && typeof def === "object" ? { ...(def as object), ...(id ? { murageMountId: id } : {}), ...(gated ? { murageGated: true } : {}) } : def;
  }
  return out;
}

/** Rule 74: Pi's bash tool runs `<shell> -c <command>` (bash from the engine
 * source: /bin/bash, else bash on PATH, `-c`; a login or interactive shell is
 * never used). */
export async function piShellForm(handed: Readonly<Record<string, string>>, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform !== "win32") return [existsSync("/bin/bash") ? "/bin/bash" : "bash", "-c"];
  const bash = await gitBashPath(handed, envGeneration());
  return bash ? [bash, "-c"] : [];
}

/** The shell form Murage checks for a Pi command ask. Only Pi's Bash tool runs the pinned shell;
 * its optional PowerShell tool finds PowerShell by itself, so no form can vouch for it and it keeps asking (U20). */
export function piCheckForm(tool: string, shellForm: readonly string[]): string[] {
  return tool === "Bash" ? [...shellForm] : [];
}

/** Pi's explicit extension replaces its Bash tool without changing the owner's settings. */
export function piPinnedBashExtension(shellPath: string): string {
  return `export default async function(pi) {
  const { createBashTool } = await import("@earendil-works/pi-coding-agent").catch(() => import("@mariozechner/pi-coding-agent"));
  pi.registerTool(createBashTool(process.cwd(), { shellPath: ${JSON.stringify(shellPath)} }));
}\n`;
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
    /** `pi --version` as last probed (snapshot or a turn); decides the isolation flags. */
    let piVersion = "";
    // The CLI file the version came from: replaced by an update, it is re-probed; otherwise never.
    let piCliSig = "";
    /** The one env pi is found on: its `--version` probe runs here, its signature (piCliSig) is taken here, and the turn
     *  spawns the file found here (engineLaunchFile), so the version that decides the isolation flags is the running pi's. */
    const piProbeEnv = () => piEnvironment({ ...process.env, ...input.environment });
    // The engine as Settings names this instance, for every line the chat shows.
    const ENGINE = input.displayName?.trim() || "pi";
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
      pending: Map<string, PiAskAnswer>;
      child?: { stdin: { write: (s: string) => void } };
      /** Asks opened as host-control permission requests (local-computer scope). */
      scopedRequests: Set<string>;
    }>();
    // A turn between sendTurn's start and its child's registration has no
    // entry in `active`, so a Stop then found nothing to stop and the turn went
    // on to prompt the engine (1.0.3 CI 39418988743: a bot-level Stop right
    // after a room claimed the bot). Such a Stop is kept and honoured as soon
    // as the turn has started, before its handshake and prompt.
    const starting = new Set<string>(), earlyStops = new Set<string>();
    // Settlement emits the terminal event; Stop lets abort finish before
    // termination. The child remains owned until close is confirmed (A2).
    const teardowns = new TurnTeardowns();
    // Pi's abort response follows its session flush; the close budget starts after that bounded grace.
    const piStopBudget = (): TeardownWait => stopBudget(CLI_TERM_GRACE_MS);

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
      earlyStops.delete(threadId); starting.add(threadId);
      // Host control always routes through the permission card; full-auto must
      // never get unapproved hands on the user's machine (same guard as the
      // Claude and ACP drivers).
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      const skipPermissions = config.fullAuto && !turn.stopLine && !turn.routeAsks;
      if (controlsHost && skipPermissions) {
        throw new Error("local computer control requires the interactive approval broker");
      }
      const turnId = newId();
      const pending = new Map<string, PiAskAnswer>();
      const scopedRequests = new Set<string>();
      let settled = false;
      // Token use summed over every model round of this turn (adapted from OpenMausBot 97d7c6df3): a tool round ends in
      // its own turn_end, and pi's usage there covers that round only.
      let turnUsage: { input: number; output: number } | undefined;

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
          message: `${ENGINE} could not select model "${requestedModel.slice(0, 200)}": it needs a provider/model id. Choose a model from its list.`,
        });
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "failed" });
        starting.delete(threadId);
        return { turnId };
      }

      // Write ~/.pi/agent/models.json before creating any credential-bearing
      // MCP temp files. If model setup fails, there is nothing sensitive to
      // clean up yet.
      if (requestedModel) {
        // Read the server's loaded context first, so a new models.json row
        // carries the real window (spec T2) even before any catalog refresh.
        await primeLocalContext(requestedModel, piEnvironment({ ...process.env, ...input.environment }));
        ensurePiInjectModel(requestedModel, piEnvironment({ ...process.env, ...input.environment }));
      }

      // The isolation switches depend on pi's version: read it now (a failed or backed-off probe is tried once more), before any
      // credential-bearing temp file exists, and reject the turn when it is unknown or too old (piIsolationArgs).
      if (piVersion && cliSig(config.cli, piProbeEnv()) !== piCliSig) piVersion = "";
      if (!piVersion) {
        const sig = cliSig(config.cli, piProbeEnv());
        const known = knownCliVersion(`pi|${config.cli}`, sig);
        if (known) { piVersion = known; piCliSig = sig; }
      }
      if (!piVersion && versionProbeAllowed(`pi|${config.cli}`, cliSig(config.cli, piProbeEnv()))) await probePiVersion();
      if (!piVersion) await probePiVersion();
      piIsolationArgs(piVersion, undefined, "");

      // integrations → stdio MCP servers for the pi-mcp-extension. The config
      // carries credentials (box token, composio key, comms token), so it goes
      // into a 0600 temp file removed when the turn settles — never on argv.
      const mcpServers = buildMcpServers(turn, { askBeforeCustom: !skipPermissions });
      turn = renderMurageTurn(turn, PI_TOOL_SURFACE, { agents: mcpServers?.agents ? "agents" : undefined, memory: mcpServers?.["murage-memory"] ? "murage-memory" : undefined, phone: mcpServers?.phone ? "phone" : undefined });
      // Murage's approvals (pi-permission-gate.ts). Pi runs its tools without
      // asking anyone, so without the gate Ask mode never asked and Full
      // access could not stop before a delete, a payment or a new contact.
      // Off only when the instance skips asks and this turn requests neither
      // broker enforcement nor the stop line.
      const gateSecret = !skipPermissions || turn.proposalOnly === true ? randomBytes(24).toString("hex") : null;
      let mcpTempDir: string | null = null;
      if (mcpServers) {
        // Pi is not in a Cloud home's engine manifest, and the launcher renders no Pi config.
        if (process.env.MURAGE_CLOUD_ROLE === "home") throw new Error(cloudHomeCopy.piOnHome);
        mcpTempDir = mkdtempSync(join(tmpdir(), "murage-pi-mcp-"));
        try {
          writeFileSync(join(mcpTempDir, "mcp.json"), JSON.stringify({ mcpServers: stampMcpServers(turn, mcpServers, gateSecret !== null) }), { mode: 0o600 });
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
      if (piVersion && cliSig(config.cli, piProbeEnv()) !== piCliSig) piVersion = "";
      // A pi whose `--version` keeps failing is re-probed on a bounded backoff
      // (isolation-cache.ts), not on every turn; the version stays unknown meanwhile.
      if (!piVersion) {
        const sig = cliSig(config.cli, piProbeEnv());
        const known = knownCliVersion(`pi|${config.cli}`, sig);
        if (known) { piVersion = known; piCliSig = sig; }
      }
      if (!piVersion && versionProbeAllowed(`pi|${config.cli}`, cliSig(config.cli, piProbeEnv()))) await probePiVersion();
      const childArgs = [
        ...PI_ARGS,
        ...piIsolationArgs(piVersion, turn.cwd, input.environment.HOME || process.env.HOME || input.environment.USERPROFILE || process.env.USERPROFILE || homedir()),
        ...(mcpServers ? ["-e", SPAWNED_PROXIES.piMcpExtension] : []),
        ...(gateSecret ? ["-e", SPAWNED_PROXIES.piPermissionGate] : []),
      ];

      // Rule 74: the exact map this engine process gets is the owner's
      // captured toolchain environment with the pins written last, passed as
      // the explicit `env`. Pi's bash runs `<shell> -c`, so no startup file of
      // the owner's runs again (piShellForm); the one file no flag removes is
      // checked, never trusted (Rule 74d).
      const instanceEnv: Record<string, string> = {};
      for (const [name, value] of Object.entries(input.environment)) if (typeof value === "string") instanceEnv[name] = value;
      const handed = await handedEngineEnv({
        cwd: turn.cwd,
        strip: (env) => {
          const cleaned = piEnvironment(env);
          const out: Record<string, string> = {};
          for (const [name, value] of Object.entries(cleaned)) if (typeof value === "string") out[name] = value;
          if (env.PATH !== undefined) out.PATH = env.PATH;
          return out;
        },
        extra: {
          // (a Cloud home: the instance's names reach the engine only through cloudTurnEnvironment, as before)
          ...(process.env.MURAGE_CLOUD_ROLE === "home" ? {} : instanceEnv),
          ...(mcpServers && mcpTempDir ? { MURAGE_MCP_CONFIG: join(mcpTempDir, "mcp.json") } : {}),
          ...(gateSecret ? { MURAGE_PI_GATE: gateSecret } : {}),
          // The Chief's proposal turn: the agents server's propose tool, as
          // pi-mcp-extension.ts names it, is the one tool that runs unasked.
          ...(gateSecret && turn.proposalOnly ? { MURAGE_PI_GATE_ONLY: "agents_project_propose" } : {}),
        },
      }, process.env.MURAGE_CLOUD_ROLE === "home" ? piEnvironment({ ...process.env, ...input.environment }) : undefined);
      // A turn names its bot (the launcher scopes per-bot state by it); the --version probe does not.
      const turnEnv = handed.env;
      cloudTurnBot(turnEnv, turn.warmIdentity?.botId);
      const shellForm = await piShellForm(handed.env);

      // spawnCli can throw synchronously (unresolvable CLI); if it does, the
      // 0600 temp file with the box token / composio key / comms token must
      // not be left on disk — settle() never runs because no child existed.
      const child = (() => {
        try {
          // The pi whose --version gated piIsolationArgs (piProbeEnv: Murage's own PATH), not the handed PATH's first.
          const launchCli = engineLaunchFile(config.cli, piProbeEnv());
          if (process.platform === "win32" && shellForm[0]) {
            mcpTempDir ??= mkdtempSync(join(tmpdir(), "murage-pi-mcp-"));
            const extension = join(mcpTempDir, "pinned-bash.ts");
            writeFileSync(extension, piPinnedBashExtension(shellForm[0]), { mode: 0o600 });
            childArgs.push("-e", extension);
          }
          return spawnCli(launchCli, childArgs, {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: turn.cwd,
            env: handed.env,
          }, engineJob());
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
      teardown.onClosed(() => {
        if (mcpTempDir) {
          try { rmSync(mcpTempDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
      });
      let assistantText = "";
      // Pi runs local models with no plan channel; a <todo> block one writes
      // into its answer becomes a plan update and leaves the answer (issue #7).
      // One filter per text item, so the streamed text and the item agree.
      let todo = createTodoBlockFilter();
      const emitTodoOutput = (out: TodoFilterOutput) => {
        for (const entries of out.plans) emit({ ...base(threadId, turnId), type: "plan.updated", entries });
        if (out.text) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: out.text });
      };
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
            reject(new Error(`${ENGINE} timed out (no answer for ${plainDuration(timeoutMs)}).`));
          }, timeoutMs);
          timer.unref?.();
          responseWaiters.set(command, { resolve, reject, timer });
        });
      /** The bounded reason a one-shot RPC failed, for a user-facing error. */
      const rpcFailure = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);
      child.stdin.on("error", () => rejectWaiters(new Error(`${ENGINE} stopped taking input.`)));
      const send = (obj: Record<string, unknown>) => {
        appendNative(threadId, { dir: "out", source: "pi.rpc", msg: obj });
        child.stdin.write(JSON.stringify(obj) + "\n");
      };

      /** Emit buffered assistant text as its own item, then clear it. */
      const flushAssistantText = () => {
        emitTodoOutput(todo.flush());
        todo = createTodoBlockFilter();
        // The same text the filter saw, so its plans were already sent.
        const text = extractTodoBlocks(assistantText).text;
        assistantText = "";
        if (!text.trim()) return;
        emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", origin: "engine", text });
      };

      let aborting = false;
      const terminate = () => {
        try { child.stdin.end(); } catch { /* already closed */ }
        teardown.markStopRequested();
        try { killCliTree(child); } catch { /* already gone */ }
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
        if (!aborting) terminate();
        active.delete(threadId);
      };

      const stop = () => {
        if (settled || aborting) return;
        aborting = true;
        // Register before writing. A turn_end can precede the abort response;
        // it must not close stdin or kill Pi while its session is still flushing.
        const completed = awaitResponse("abort", CLI_TERM_GRACE_MS);
        void completed.catch(() => {}).then(terminate);
        try {
          send({ type: "abort" });
        } catch {
          rejectWaiters(new Error(`${ENGINE} stopped taking input.`));
        }
        settle(true, "cancelled");
      };
      active.set(threadId, { stop, turnId, pending, child, scopedRequests });
      starting.delete(threadId);

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
                // The outer line names the step; this is the engine's own reason.
                waiter.reject(new Error(reason));
              }
            }
            return;
          }
          case "message_update": {
            const e = evt.assistantMessageEvent;
            if (!e) return;
            if (e.type === "text_delta" && typeof e.delta === "string") {
              assistantText += e.delta;
              emitTodoOutput(todo.push(e.delta));
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
              origin: "engine",
              itemId: evt.toolCallId,
              title: String(evt.toolName ?? "tool").slice(0, 80),
              toolIdentity: { name: evt.toolName },
              input: evt.args,
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
              result: evt.result,
              detail: evt.isError ? piToolErrorDetail(evt) : undefined,
            });
            return;
          }
          case "extension_ui_request": {
            // pi floods setWidget/setStatus for TUI bookkeeping; only
            // select/confirm/input/editor are dialogs that wait for an answer.
            // Verified against pi-mono docs/rpc.md: select answers {value:
            // <option>}, input and editor answer {value: <text>}, confirm
            // answers {confirmed}, and every dialog takes {cancelled: true}.
            if (evt.method === "select" || evt.method === "confirm" || evt.method === "input" || evt.method === "editor") {
              flushAssistantText();
              const reqId = evt.id ?? newId();
              // select, input and editor ask the OWNER something: one question
              // card with the dialog's own options or a free-text field
              // (0.1.52 ASK3). Before this, a select was carded as a
              // permission whose Allow sent {confirmed:true} — not even pi's
              // reply shape for a select. `confirm` stays a permission.
              // Rule 13/73d: this turn's gate asks as an `editor` whose title
              // carries the secret and whose prefill is the call. It is
              // recognised BEFORE an editor is treated as an owner question.
              const isGateAsk = !!gateSecret && evt.method === "editor" && evt.title === `${PI_GATE_TITLE_PREFIX}${gateSecret}`;
              const question = evt.method === "confirm" || isGateAsk ? null : fromPi(evt);
              if (question && !question.ok) {
                // a dialog the owner cannot be shown is cancelled at once,
                // and the owner sees why, instead of a card nobody can answer
                emit({ ...base(threadId, turnId), type: "runtime.error", message: `${ENGINE} asked a question Murage could not show (${question.error}); it was cancelled` });
                send({ type: "extension_ui_response", id: reqId, cancelled: true });
                return;
              }
              const questions: QuestionSpec[] | null = question ? question.questions : null;
              // Carry the trusted host-control scope to the shared policy
              // gate, as the Claude, Codex and ACP drivers do. Without it
              // index.ts treats the card as ordinary: it offers a bare-title
              // "Always allow" and a remembered grant later auto-approves
              // host actions with Auto off (A7). pi's extension protocol has
              // no trusted per-call tag — the title is extension-composed text
              // and is never parsed for this — so every permission ask on a
              // host-controlling turn is scoped conservatively. Questions are
              // not permissions and always reach the human anyway.
              const scoped = controlsHost && !questions;
              if (scoped) scopedRequests.add(reqId);
              // A question waits for the owner up to the shared 30-minute
              // limit, then pi gets an honest {cancelled:true} — never a guess
              // in the owner's name. (pi's own `timeout` field, when set, may
              // auto-resolve sooner on its side.)
              // awake time (1.0.10 C3): a sleep with the question open does not count toward its deadline
              const timer = questions && !turn.holdProjectAsks
                ? wakeAwareTimeout(() => {
                    if (!pending.delete(reqId)) return;
                    send({ type: "extension_ui_response", id: reqId, cancelled: true });
                    emit({ ...base(threadId, turnId), requestId: reqId, type: "request.resolved", behavior: "deny", source: "timeout" });
                  }, QUESTION_TIMEOUT_MS)
                : null;
              // Register BEFORE emitting: the harness may auto-approve from
              // inside its synchronous request.opened listener. Emitting first
              // made respondToRequest see no pending ask, return unavailable,
              // then fall back to a human card on every "Always allow" call.
              const mountRecords = piMountRecords(turn, mcpServers);
              // Murage's own gate, recognised by this turn's secret: the call it
              // carries is what the stop line and the card read.
              const gate = isGateAsk ? piGateAsk(typeof evt.prefill === "string" ? evt.prefill : "", mountRecords) : null;
              pending.set(reqId, (decision) => {
                timer?.clear();
                if (questions) {
                  // validated picks first; a one-string client (voice) still works
                  const value = decision.behavior !== "answer"
                    ? ""
                    : decision.answers?.length
                      ? toPiValue(questions, decision.answers)
                      : (decision.message ?? "").trim();
                  if (value) send({ type: "extension_ui_response", id: reqId, value });
                  else send({ type: "extension_ui_response", id: reqId, cancelled: true });
                  return;
                }
                if (isGateAsk) {
                  // Rule 73d: Allow echoes the input the gate sent (a rewrite,
                  // when the verdict makes one, replaces it); Deny carries the
                  // reason, which for a narrowing denial (Rule 72) is the
                  // verdict's own text.
                  const allowed = decision.behavior === "allow" && gate?.gateInput !== undefined && !gate.truncated;
                  const reply = allowed
                    ? { allow: true, input: gate!.gateInput }
                    : { deny: true, reason: decision.behavior === "allow" ? PI_GATE_CUT_REASON : decision.message?.trim() || "The owner did not allow this in Murage." };
                  send({ type: "extension_ui_response", id: reqId, value: JSON.stringify(reply) });
                  return;
                }
                if (decision.behavior === "deny") send({ type: "extension_ui_response", id: reqId, cancelled: true });
                else send({ type: "extension_ui_response", id: reqId, confirmed: true });
              });
              // F12 when the card opens (Rule 74d): the check of the generation the card opens in, computed for this ask
              const open = (execEnv: ExecEnv) => {
                if (!pending.has(reqId)) return;
                emit({
                  ...base(threadId, turnId),
                  requestId: reqId,
                  type: "request.opened",
                  requestType: questions ? "question" : "permission",
                  tool: questions ? String(evt.method) : gate ? gate.tool : String(evt.title ?? "pi"),
                  summary: questions ? questions[0]!.question.slice(0, 300) : gate ? gate.summary : String(evt.title ?? "pi wants confirmation"),
                  ...(gate?.toolInput ? { toolInput: gate.toolInput } : {}),
                  ...(gate?.toolCall ? { toolCall: gate.toolCall } : {}),
                  ...(gate?.filePaths ? { filePaths: gate.filePaths } : {}),
                  // the gate could not send the call whole: the card says so,
                  // offers no standing grant, and no mode answers it
                  ...(gate?.truncated ? { toolInputTruncated: true } : {}),
                  // F5: a field the contract needs was absent; nothing stands in for it
                  ...(gate?.toolInputMissing ? { toolInputMissing: gate.toolInputMissing } : {}),
                  // 1.0.4 09-1: the gate's own key-file verdict, kept so no mode answers it
                  ...(gate?.localHold ? { localHold: gate.localHold } : {}),
                  // Rule 54: the servers in the mcp.json this turn wrote, no external records
                  // Rule 13: a permission that did not come from this turn's gate
                  // (any other extension's confirm) is unproven: no grant, stop,
                  // no mode answers it. The gate's own set-b ask carries an mcp
                  // identity, resolved against F4 by exact engineName.
                  ...(!questions && (gate ? gate.toolIdentity : PI_UNPROVEN_IDENTITY) ? { toolIdentity: gate ? gate.toolIdentity! : PI_UNPROVEN_IDENTITY } : {}),
                  // Rule 74 / F12: the environment this engine's commands run in
                  execEnv,
                  mcpMounts: mountRecords,
                  toolEngine: "pi" as const,
                  ...(questions ? { choices: questions[0]!.options.map((option) => option.label), questions } : {}),
                  ...(scoped ? { approvalScope: "local-computer" as const } : {}),
                });
              };
              // only the gate's command ask is checked (and so only a command card can carry U20); any other ask reports the
              // map as handed, unchecked
              if (gate && !questions && (gate.tool === "Bash" || gate.tool === "PowerShell")) void execEnvNow(threadId, piCheckForm(gate.tool, shellForm), handed, turn.cwd ?? process.cwd()).then(open);
              else open(execEnvHanded(handed, turn.cwd ?? process.cwd(), shellForm));
            }
            return;
          }
          case "turn_end":
          case "agent_end": {
            const sr = evt.message?.stopReason;
            const round = evt.usage ?? evt.message?.usage;
            // a turn_end is one model round; agent_end counts only when no round reported (it is not another round)
            if (round && !settled && (evt.type === "turn_end" || !turnUsage)) {
              turnUsage = { input: (turnUsage?.input ?? 0) + (round.input ?? 0), output: (turnUsage?.output ?? 0) + (round.output ?? 0) };
            }
            // toolUse means pi ran a tool and auto-continues next turn to
            // answer — settling now would drop the final reply.
            if (sr === "toolUse" || sr === "tool_use" || sr === "tool_calls") return;
            const usage = turnUsage;
            if (sr === "error" || sr === "failed") {
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message: String(evt.message?.errorMessage ?? `${ENGINE} could not finish this turn.`).slice(0, 2_000),
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

      // Byte-bounded framing (A4): UTF-8 is decoded per complete line, so a
      // multibyte character split across reads stays intact, and one frame
      // never holds more than ENGINE_FRAME_MAX_BYTES of the shared process.
      const stdoutLines = createBoundedLineSplitter({
        onLine: (line) => {
          if (!line.trim()) return;
          try {
            onEvent(JSON.parse(line) as PiEvent);
          } catch {
            /* skip non-JSON line */
          }
        },
        onOverflow: (overflow) => {
          appendNative(threadId, { dir: "in", source: "pi.rpc", msg: { frameOverflow: overflow } });
          if (settled) return;
          const message = frameOverflowMessage("pi", overflow);
          emit({ ...base(threadId, turnId), type: "runtime.error", message });
          // settle first so a pending handshake step sees the turn is over
          // and adds no second failure
          settle(false, FRAME_TOO_LARGE);
          rejectWaiters(new Error(message));
        },
      });
      // The last words pi wrote, for the line shown if it closes before its turn ended (a missing runtime, a crash).
      const stderrTail = new EngineStderrCapture();
      child.stderr?.on("data", (chunk: Buffer) => stderrTail.push(chunk));
      let sessionReady = false;
      const piClosedMessage = (code: number | null, signal: NodeJS.Signals | null) => {
        // the capture is kept from its start and redacted whole before any cut (acp/core.ts EngineStderrCapture)
        const lastWords = stderrTail.lastWords();
        if (sessionReady) return engineClosedLine(ENGINE, code, signal, lastWords);
        return `${ENGINE} could not start a session: it closed before it was ready${lastWords ? ` (${lastWords})` : ""}. Send your message again. If this keeps happening, check that ${ENGINE} is installed and runs, or choose another engine for this bot.`;
      };
      child.stdout.on("data", (chunk: Buffer) => stdoutLines.push(chunk));
      registerIntake(threadId, child.stdout, child);
      child.on("error", (err) => {
        const fail = describeSpawnFailure(err as NodeJS.ErrnoException, config.cli);
        // S4 power: a launch the block could not cover wrote no prompt (turn-attribution.ts notWritten).
        if ((err as NodeJS.ErrnoException).code === HOST_POWER_CODE) turn.notWritten?.();
        rejectWaiters(new Error(fail.message));
        emit({ ...base(threadId, turnId), type: "runtime.error", message: fail.message, setup: fail.setup });
        settle(false);
      });
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        // S4 power (design sections 2 and 8): bwrap or sandbox-exec refused before pi ran; nothing it was sent was delivered.
        if (!settled && hostPowerRefused(child)) {
          turn.notWritten?.();
          rejectWaiters(new Error(hostPowerMessage()));
          emit({ ...base(threadId, turnId), type: "runtime.error", message: hostPowerMessage() });
          settle(false);
          return;
        }
        // A close without a terminal event is a failed turn, never a hang, and never a silent one: a wrapper (bwrap,
        // sandbox-exec) holds stdin open until it exits, so no EPIPE fires first, and a pi that crashes after the first
        // write gets none either. Exactly one error, emitted and settled before the waiters are rejected, so a pending
        // handshake step (failBeforePrompt) sees the turn is over and adds no second one.
        if (!settled) {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: piClosedMessage(code, signal) });
          settle(false);
        }
        rejectWaiters(new Error(`${ENGINE} stopped before replying.`));
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      if (earlyStops.delete(threadId)) {
        stop();
        return { turnId };
      }

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
        sessionReady = true;
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
            ? `${ENGINE} could not resume this thread's session: ${rpcFailure(err)}`
            : `${ENGINE} could not start a session: ${rpcFailure(err)}`,
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
          failBeforePrompt(`${ENGINE} could not select model "${requestedModel.slice(0, 200)}": ${rpcFailure(err)}`);
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
      // Keep the refused child addressable until the harness binds its lease
      // and performs exact-turn teardown. Never submit across this refusal.
      try { turn.beforeSubmit?.(); } catch { return { turnId }; }
      if (settled) return { turnId };
      try {
        send({ type: "prompt", message });
      } catch {
        failBeforePrompt(`${ENGINE} stopped before it took this message. Send your message again.`);
      }

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const probe = await probePi();
      if (!("version" in probe)) return { state: "unavailable", reason: probe.reason };
      const { version } = probe;
      // pi manages its own credentials (~/.pi/agent/auth.json); there is no
      // separate sign-in step the harness can probe, so treat it as authed.
      return { state: "available", version, authenticated: true };
    };
    // Upstream #3433: a slow probe keeps the last version; only a real miss reads as not installed.
    const snapshotVersionOf = cliVersionReader(config.cli);
    async function probePiVersion(): Promise<string | null> {
      const probe = await probePi();
      return "version" in probe ? probe.version : null;
    }
    async function probePi(): Promise<{ version: string } | { reason: string }> {
      const answer = await new Promise<{ err: Error | null; out: string }>((resolve) => {
        const child = spawnCli(config.cli, ["--version"], {
          stdio: ["ignore", "pipe", "pipe"],
          env: piProbeEnv(),
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
          resolve({ err: Object.assign(new Error("pi --version timed out"), { killed: true }), out: "" });
        }, 8000);
        timer.unref?.();
        child.on("error", (error) => {
          clearTimeout(timer);
          resolve({ err: error, out: "" });
        });
        child.on("close", () => {
          clearTimeout(timer);
          resolve({ err: out.trim() ? null : new Error("pi --version printed nothing"), out });
        });
      });
      const version = answer.err ? null : answer.out.trim();
      const sig = cliSig(config.cli, piProbeEnv());
      noteVersionProbe(`pi|${config.cli}`, sig, Boolean(version));
      if (version) { piVersion = version; piCliSig = sig; rememberCliVersion(`pi|${config.cli}`, sig, version); }
      return snapshotVersionOf(answer.err, answer.out);
    }

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
        mcpToolSurface: PI_TOOL_SURFACE,
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
          // The owner's own MCP servers (MCP-LINK T9): mounted by the same
          // extension, each call behind pi's permission card unless the
          // instance is on Full access.
          customMcp: true,
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
        // Close-confirmed stop (A2): stop() settles, waits for abort, then
        // requests termination; resolve on confirmed close or reject at the deadline.
        interruptTurn: async (threadId, turnId) => {
          const entry = active.get(threadId);
          if (entry) entry.stop();
          else if (starting.has(threadId)) earlyStops.add(threadId);
          const result = await teardowns.wait(threadId, turnId, piStopBudget());
          if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
          return result;
        },
        awaitTurnTeardown: (threadId, turnId) => teardowns.wait(threadId, turnId, piStopBudget()),
        awaitTurnClose: (threadId, turnId) => teardowns.closed(threadId, turnId),
        respondToRequest: async (threadId, requestId, decision) => {
          const entry = active.get(threadId);
          const answer = entry?.pending.get(requestId);
          if (!entry || !answer) return "unavailable";
          entry.pending.delete(requestId);
          const scoped = entry.scopedRequests.delete(requestId);
          answer({ behavior: decision.behavior, message: decision.message, answers: decision.answers });
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
