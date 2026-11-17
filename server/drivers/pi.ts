import { noLimitsPowerFallbackActive, takeNoLimitsPowerFallbackNotice } from "../host-power.ts";
import { NotModelRequest } from "../../shared/engine-transport.ts";
import { registerBusyloopRequestSite, fluxRouteFor } from "../../shared/flux-route.ts";
import { registerBusyloopPayloadSite } from "../../shared/flux-route.ts";
import { guardEngineRelease } from '../decision/provider-release.ts';
import { deliverNative, type NativeAskSlot, type AskMode } from './native-ask.ts';
import { RequestTransport } from './request-transport.ts';
import { withRequestDelivery } from "./request-delivery.ts";
import { assertNativeIngressAdmission } from "./engine-input.ts";
import { engineJsonLine } from "./engine-wire.ts";
import { fencedSubmit, releaseNativeAnswer, refusalFor, fencedOf, composeClose, type FencedRefusal, type ConfirmedClose } from "./engine-input.ts";
import { piGateControlAnswer } from "./hook-control.ts";
export { piGateControlAnswer } from "./hook-control.ts";
import { refuseConsumingTurn } from "../consuming-turn-response.ts";
import { emitterRefusalLine } from "../turn-end.ts";
import { LEDGER_REFUSAL_LINE } from "../ledger-refusal.ts";
import { mountedTurn } from "./cli-mount-relay.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { probeFolder } from "../probe-folder.ts";
import { botFolderOrThrow } from "../bot-folder.ts";
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
// Conversation continuity: pi runs with --no-session, so `new_session` returns
// no `sessionFile`, session.started carries no id, no cursor is stored, and the
// harness replays the thread into each turn's prompt (keepsNoSession). A cursor
// handed in all the same goes through `switch_session`.
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
import { writeFileSync } from "../counted-fs.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { deleteEnvNames, PROVIDER_CREDENTIAL_ENV, stripRoutingEnv, stripWorkspaceCredentialEnv } from "../config.ts";
import { augmentedPath, envGeneration } from "../env-path.ts";
import { gitBashPath } from "../tool-discovery.ts";
import { CLI_TERM_GRACE_MS, cliVersionReader, describeSpawnFailure, engineJob, killCliTree, nextTask, spawnCli, HOST_POWER_CODE, hostPowerMessage, hostPowerRefused } from "../procs.ts";
import { ProviderStopUnconfirmedError, providerCloseDeadlineMs, ROOT_CLOSE_GRACE_MS, stopBudget, TurnTeardowns, type TeardownWait } from "./child-teardown.ts";
import { createStopGate, type GateEntry } from "./stop-gate.ts";
import { classifyError } from "./retry.ts";
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
import { phoneAskLine } from "./phone-tool-schemas.ts";
import { boundedToolInput } from "../approval-text.ts";
import type { McpMountRecord } from "../../shared/mount-identity.ts";
import { PI_GATE_TITLE_PREFIX } from "./pi-permission-gate.ts";
import { inventoryPath, assertPiInventoryAvailable, registerPiInventoryConsumer } from "../pi-root-inventory.ts";
import { degradedWipeContext, wipeContextFor } from "../wipe/context.ts";
import { execEnvHanded, execEnvNow, handedEngineEnv } from "../engine-env.ts";
import type { ExecEnv } from "../../shared/mount-identity.ts";
import { createTodoBlockFilter, extractTodoBlocks, type TodoFilterOutput } from "../../shared/todo-block.ts";
import { engineClosedLine, plainDuration } from "./stop-copy.ts";
import { EngineStderrCapture } from "./acp/core.ts";
import { redactSecretsInText } from "../redact.ts";
import { toolFailureText } from "../../shared/tool-activity.ts";
import { buildMcpServers, piMountRecords } from "./mcp-mounts.ts";
import { wakeAwareTimeout } from "../sleep-clock.ts";

/** E24: the turn waits for pi's session answer however long it takes, and says so in the chat after this long. */
export const PI_SESSION_SLOW_MS = 20_000;
export const piSessionSlowLine = (engine: string) =>
  `${engine} is taking longer than usual to start this chat. The reply carries on when ${engine} is ready; press Stop to cancel it.`;

/** pi-ai's per-round usage: `input` leaves out cached prompt tokens, and `cost.total` is pi's own priced USD. */
export type PiUsage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
const piCount = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
/** G6 (upstream 95d60df4e): one model round added to the turn's tally, in the shape the other drivers report: input counts
 *  cached and cache-written prompt tokens too, cachedInput is the cache reads, and cost sums pi's priced USD. A zero price
 *  is pi's default for a model it has no prices for, so it leaves the cost unknown rather than booking it as nothing. */
export function addPiRoundUsage(
  total: { input: number; output: number; cachedInput?: number } | undefined,
  cost: number | undefined,
  round: PiUsage,
): { usage: { input: number; output: number; cachedInput?: number }; cost: number | undefined } {
  const cacheRead = piCount(round.cacheRead);
  const cachedInput = cacheRead === undefined ? total?.cachedInput : (total?.cachedInput ?? 0) + cacheRead;
  const roundCost = piCount(round.cost?.total);
  return {
    usage: {
      input: (total?.input ?? 0) + (piCount(round.input) ?? 0) + (cacheRead ?? 0) + (piCount(round.cacheWrite) ?? 0),
      output: (total?.output ?? 0) + (piCount(round.output) ?? 0),
      ...(cachedInput === undefined ? {} : { cachedInput }),
    },
    cost: roundCost ? (cost ?? 0) + roundCost : cost,
  };
}

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

/** The first pi that reports `agent_settled`, the event a turn ends on (0.80.3 and 0.75.4 never send it; 0.80.4 was not
 * published). Below it a turn would never end, so none is started and the owner is told to update. */
export const PI_TURN_MIN = [0, 80, 5] as const;

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

/** The owner-facing line for a readable pi older than PI_TURN_MIN, or null. An unreadable version is piIsolationArgs's refusal. */
function piBelowTurnMin(version: string | undefined): string | null {
  const v = piSemver(version);
  return v && !piAtLeast(v, PI_TURN_MIN) ? `Your Pi engine is version ${v.join(".")}, and Murage needs ${PI_TURN_MIN.join(".")} or newer.` : null;
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

const PI_MASK = /«redacted (\d+) chars»/g;
const PI_MASK_TOKEN = /«redacted-(\d+)-chars»/g;

/** The short reason a failed pi tool call gives, for its activity row: the
 * result's own text (a string, or text content parts), first line, redacted,
 * paths cut to their last segment. Never the call's arguments. */
export function piToolErrorDetail(evt: { result?: unknown; error?: unknown }): string | undefined {
  const raw = typeof evt.result === "string" ? evt.result : toolFailureText(evt.result) ?? (typeof evt.error === "string" ? evt.error : undefined);
  const line = raw?.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return undefined;
  // Redact first: the fold cuts a path to its last segment, so `token=/tmp/sk-…/rest` would reach the redactor as a key with no body.
  // The mask has spaces, so it goes through the fold as one token and the path around it is cut whole (acpEngineErrorText does the same).
  const redacted = redactSecretsInText(line).replace(PI_MASK, "«redacted-$1-chars»");
  const text = redacted.replace(PI_ABS_PATH, "…/$1").replace(PI_MASK_TOKEN, "«redacted $1 chars»").slice(0, PI_ERROR_DETAIL_MAX).trim();
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
      msg = registerBusyloopPayloadSite("read", JSON.parse(line));
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
      const parsed = registerBusyloopPayloadSite("read", JSON.parse(readFileSync(path, "utf8"))) as unknown;
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
    const s = registerBusyloopPayloadSite("read", JSON.parse(readFileSync(`${home}/.pi/agent/settings.json`, "utf8"))) as {
      defaultProvider?: string;
      defaultModel?: string;
    };
    return s.defaultProvider && s.defaultModel ? `${s.defaultProvider}/${s.defaultModel}` : "";
  } catch {
    return "";
  }
}

/** Resolve only the URL configured for this model; provider labels never decide Flux scope. */
export function piRequestUrl(model: string | null, env: Record<string, string | undefined>): string | undefined {
  const selected = model || readPiDefaultModel(env);
  const injected = decodeInjectId(selected);
  if (injected) return localHost(injected.host)?.baseUrl;
  const choice = splitPiModel(selected);
  if (!choice) return undefined;
  try {
    const settings = registerBusyloopPayloadSite("read", JSON.parse(readFileSync(join(piAgentDir(env), "models.json"), "utf8")));
    const provider = settings?.providers?.[choice.provider];
    const row = provider?.models?.find((item: { id?: unknown }) => item.id === choice.modelId);
    const url = row?.baseUrl ?? provider?.baseUrl;
    return typeof url === "string" ? url : undefined;
  } catch { return undefined; }
}

/** Probe the live catalog by spawning `pi --mode rpc --no-session`, sending
 *  `get_available_models`, and parsing the response. A failed probe resolves
 *  with an empty catalog — the instance reports unavailable via snapshot. */
export async function fetchPiModels(
  cli: string,
  env: Record<string, string | undefined>,
): Promise<ModelCatalog> {
  const child = spawnCli(cli, PI_ARGS, { stdio: ["pipe", "pipe", "pipe"], cwd: probeFolder(), env });
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
      NotModelRequest("Pi get_available_models catalog probe; no prompt is submitted", child.stdin.write(JSON.stringify({ id: "catalog", type: "get_available_models" }) + "\n"));
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
/** How one turn ended, closeTurn's only input. */
type TurnEnd = { kind: "done" } | { kind: "cancelled" } | { kind: "failed"; message?: string; stopReason?: string; setup?: boolean };

/** The extension requests that wait for an answer; pi floods setWidget and setStatus besides. */
const PI_DIALOGS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

/** Why pi refuses a prompt, in words Murage chose. Pi's text can carry anything (an extension's error, a folder, a key), so none of it
 * reaches the chat: a known refusal reads as its line here and any other as no reason given. The text itself stays in the native trace. */
const PI_REFUSED_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bNo API key found\b/, "No API key found for the selected model"],
  [/\bNo model selected\b/, "No model selected"],
  [/^\W*Authentication failed\b/, "Authentication failed"],
];

/** A prompt pi refused, for the chat. */
export function piRefusedLine(engine: string, error: unknown): string {
  const text = typeof error === "string" ? error : "";
  const reason = PI_REFUSED_REASONS.find(([pattern]) => pattern.test(text))?.[1] ?? "no reason given";
  return `${engine} did not take this message: ${reason}. Check this bot's engine and model in Settings, then send it again.`;
}

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
  // turn_end / message_start / message_end
  message?: { role?: string; stopReason?: string; errorMessage?: string; usage?: PiUsage };
  usage?: PiUsage;
  // auto_retry_start / compaction_end / agent_settled
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  reason?: string;
  aborted?: boolean;
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
type PiAskAnswer = (decision: { behavior: "allow" | "deny" | "answer"; message?: string; answers?: QuestionAnswer[]; source?: "narrow"; updatedInput?:Record<string,unknown> }, mode?: AskMode, source?: "user" | "system" | "timeout") => Promise<boolean>;

function piEnvironment(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...cloudTurnEnvironment("pi", source, ["MURAGE_MCP_CONFIG", "MURAGE_PI_GATE", "MURAGE_PI_GATE_PREFIXES", "MURAGE_PI_GATE_ONLY", "MURAGE_PI_GATE_MODE"]), PATH: augmentedPath() };
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
  try { hold = (registerBusyloopPayloadSite("read", JSON.parse(message)) as { sensitive?: unknown } | null)?.sensitive; } catch { hold = undefined; }
  return typeof hold === "string" && hold ? { ...ask, localHold: hold.slice(0, 80) } : ask;
}

function piGateCall(message: string, mounts: readonly McpMountRecord[]): PiGateAsk {
  let parsed: { tool?: unknown; input?: unknown; truncated?: unknown; mount?: unknown; mcpTool?: unknown; note?: unknown } = {};
  let readable = false;
  try {
    const value: unknown = registerBusyloopPayloadSite("read", JSON.parse(message));
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
    return { tool: name, summary: phoneAskLine(name, input) ?? `${mcpTool.slice(0, 300)}${note}`, ...(boundedToolInput(input) ? { toolInput: boundedToolInput(input) } : {}), toolCall: { name, input }, toolIdentity: identity, gateInput: input };
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

// --force: pi up to 0.73.1 was published as @mariozechner/pi-coding-agent, and without it npm refuses to replace that package's `pi` (EEXIST).
const PI_INSTALL_COMMAND = "npm install -g --force @earendil-works/pi-coding-agent";

/** Final prompt serialization, after system text has been composed. */
export function serializePiInput(message: Record<string, unknown>, beforeWrite?: () => void): string {
  return engineJsonLine(message, message.type === "prompt" ? beforeWrite : undefined);
}

export const PiDriver: ProviderDriver<PiConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "pi", supportsMultipleInstances: true, access: "custom" },
  install: {
    command: {
      darwin: PI_INSTALL_COMMAND,
      linux: PI_INSTALL_COMMAND,
      win32: PI_INSTALL_COMMAND,
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
    const answerTransport = new RequestTransport();
    const active = new Map<string, {
      /** "asked": interruptTurn or stopAll, the turn ends as Stop. "closing": dispose, the turn ends as the engine closing. */
      stop: (why: "asked" | "closing") => void;
      turnId: string;
      pending: Map<string, PiAskAnswer>;
      child?: { stdin: { write: (s: string) => void } };
      /** Asks opened as host-control permission requests (local-computer scope). */
      scopedRequests: Set<string>;
    }>();
    // STOP-NONACP: a turn between sendTurn's start and its child's registration has no entry in `active`; the stop gate holds it
    // from its first line. A Stop (interruptTurn, stopAll) or the close (dispose) that lands while it is starting ends it there,
    // before any models.json write, MCP temp file or pi child (every await of that path is a gate step, the spawn is the launch).
    // Settlement emits the terminal event; Stop lets abort finish before
    // termination. The child remains owned until close is confirmed (A2).
    const teardowns = new TurnTeardowns();
    // One logical turn may replace a refused startup wrapper. Each child has
    // its own teardown identity; exact public-turn waits follow the live child.
    const retryLeases = new Map<string, string>();
    const teardownId = (turnId: string | undefined) => turnId === undefined ? undefined : retryLeases.get(turnId) ?? turnId;
    const powerSession = {};
    // Pi's abort response follows its session flush; the close budget starts after that bounded grace.
    const piStopBudget = (): TeardownWait => stopBudget(CLI_TERM_GRACE_MS);

    const emissionSource = new AsyncLocalStorage<SendTurnInput["sourceContext"]>();
    const emit = (event: RuntimeEvent, source = emissionSource.getStore()) => {
      for (const l of [...listeners]) l(event, source);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const stopGate = createStopGate({ engineName: ENGINE, emit: (event, source) => emit(event as unknown as RuntimeEvent, source as SendTurnInput["sourceContext"]), base });

    /** A turn that ends before sendTurn has handed its id back (a request refused at its write, a handshake that failed) ends
     * after the handback, never inside it: the host binds its lease to the turn it was given, and a terminal event inside
     * sendTurn would reach it while that turn is still unknown. */
    const beforeHandback = new Set<string>();
    const endingsAfterHandback = new Map<string, () => void>();
    const endAfterHandback = (turnId: string) => { const ending = endingsAfterHandback.get(turnId); endingsAfterHandback.delete(turnId); ending?.(); };
    const endTurnAfterHandback = (e: GateEntry, ending: () => void) => {
      // Its terminal event is still the dispatch's own: it carries the source context sendTurn ran under.
      const source = emissionSource.getStore();
      if (e.turnId !== undefined && beforeHandback.has(e.turnId)) endingsAfterHandback.set(e.turnId, () => emissionSource.run(source, ending)); else ending();
    };

    const sendTurn = (turn: SendTurnInput): Promise<{ turnId: string }> => emissionSource.run(turn.prewarm ? undefined : turn.sourceContext, () => sendTurnCaptured(turn));
    const sendTurnCaptured = async (turn: SendTurnInput) => {
      assertNativeIngressAdmission(turn, "pi");
      if (mountedTurn(turn)) { turn.admissionNotLaunched?.("toolTurnRefused"); throw new Error("Murage keeps this bot's memory out of Pi's tools."); }
      turn = { ...turn, cwd: botFolderOrThrow(turn) };
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const entry = stopGate.enter(threadId, { turnId: newId(), source: turn.prewarm ? undefined : turn.sourceContext });
      const handbackTurn = entry.turnId!;
      beforeHandback.add(handbackTurn);
      const handedBack = () => { beforeHandback.delete(handbackTurn); if (endingsAfterHandback.has(handbackTurn)) setImmediate(() => endAfterHandback(handbackTurn)); };
      return stopGate.run(entry, async () => {
        // A terminal result does not prove its process tree is gone. Keep the
        // new send gated until every predecessor on this thread is confirmed.
        if (teardowns.pending(threadId)) {
          const stopped = await stopGate.step(entry, teardowns.wait(threadId, undefined, piStopBudget()));
          if (!stopped.closeConfirmed) throw Object.assign(new ProviderStopUnconfirmedError(DRIVER_KIND, stopped), { message: `${ENGINE} is still closing its last turn` });
        }
        return runTurn(turn, entry);
      }, () => null).finally(handedBack);
    };
    const runTurn = async (turn: SendTurnInput, e: GateEntry, powerRetried = false): Promise<{ turnId: string }> => {
      const originalTurn = turn;
      const { threadId } = turn;
      // A terminal event does not prove the previous process tree is dead.
      // Keep the workspace owned until that exact predecessor has closed,
      // including its descendants, before preparing or spawning another turn.
      if (teardowns.pending(threadId)) {
        const stopped = await stopGate.step(e, teardowns.wait(threadId, undefined, piStopBudget()));
        if (!stopped.closeConfirmed) throw new Error("Pi is still closing its last turn. Wait a moment and send again.");
      }
      // Host control always routes through the permission card; full-auto must
      // never get unapproved hands on the user's machine (same guard as the
      // Claude and ACP drivers).
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      const skipPermissions = config.fullAuto && !turn.stopLine && !turn.routeAsks;
      if (controlsHost && skipPermissions) {
        throw new Error("local computer control requires the interactive approval broker");
      }
      const turnId = e.turnId ?? "";
      /** The MCP temp dir of a turn a Stop or the close ended before its spawn (it holds the credential-bearing mcp.json). */
      const dropTemp = (dir: string | null) => {
        if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
      };
      const pending = new Map<string, PiAskAnswer>();
      const scopedRequests = new Set<string>();
      let settled = false;
      let retryingPower = false;
      // Token use summed over every model round of this turn (adapted from OpenMausBot 97d7c6df3). A round is counted at
      // the first place pi reports it, normally its message_end, which precedes the round's tools.
      let turnUsage: { input: number; output: number; cachedInput?: number } | undefined;
      // pi's own priced USD for the turn (G6, upstream 95d60df4e); unknown until a round reports a price above zero.
      let turnCost: number | undefined;
      let roundCounted = false;
      const addUsage = (round: PiUsage) => {
        const counted = addPiRoundUsage(turnUsage, turnCost, round);
        turnUsage = counted.usage;
        turnCost = counted.cost;
      };

      // An explicit pick must land on exactly that provider/model. A bare id
      // carries no provider, so set_model cannot pin it, and prompting anyway
      // would run pi's configured default — possibly a hosted, billed provider
      // in place of a local or private pick. Fail before anything is spawned.
      const requestedModel = typeof turn.model === "string" && turn.model ? turn.model : null;
      const chosen = requestedModel ? splitPiModel(requestedModel) : null;
      if (requestedModel && !chosen) {
        e.finish({
          ok: false,
          stopReason: "failed",
          error: `${ENGINE} could not select model "${requestedModel.slice(0, 200)}": it needs a provider/model id. Choose a model from its list.`,
        });
        return { turnId };
      }

      // Write ~/.pi/agent/models.json before creating any credential-bearing
      // MCP temp files. If model setup fails, there is nothing sensitive to
      // clean up yet.
      if (requestedModel) {
        // Read the server's loaded context first, so a new models.json row
        // carries the real window (spec T2) even before any catalog refresh.
        await stopGate.step(e, primeLocalContext(requestedModel, piEnvironment({ ...process.env, ...input.environment })));   // a Stop (or the close) that lands here ends the turn: models.json is not written
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
      if (!piVersion && versionProbeAllowed(`pi|${config.cli}`, cliSig(config.cli, piProbeEnv()))) await stopGate.step(e, probePiVersion());
      if (!piVersion) await stopGate.step(e, probePiVersion());   // each step reads the gate before the version verdict below can become an error card
      const belowTurnMin = piBelowTurnMin(piVersion);
      if (belowTurnMin) {
        // No child: nothing would ever end this turn. `setup` puts the update command on the card in place of Retry.
        e.finish({ ok: false, stopReason: "failed", error: { setup: true, message: `${belowTurnMin} Update it in Settings under Engines, then send your message again.` } });
        return { turnId };
      }
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
      const gateSecret = (turn.releaseBinding ?? null) !== null || !skipPermissions || (turn.permissionNow?.() ?? turn).noLimits === true || turn.proposalOnly === true ? randomBytes(24).toString("hex") : null;
      let mcpTempDir: string | null = null;
      let gateModeFile: string | undefined;
      let gateStatusFile: string | undefined;
      let wipeContextFile: string | undefined;
      if (gateSecret && (turn.releaseBinding ?? null) !== null) {
        mcpTempDir = mkdtempSync(join(tmpdir(), "murage-pi-gate-"));
        gateModeFile = join(mcpTempDir, "mode");
        gateStatusFile = join(mcpTempDir, "status");
        writeFileSync(gateModeFile, "MODE=bound\n", { mode: 0o600 });
      }
      if (mcpServers) {
        // Pi is not in a Cloud home's engine manifest, and the launcher renders no Pi config.
        if (process.env.MURAGE_CLOUD_ROLE === "home") throw new Error(cloudHomeCopy.piOnHome);
        mcpTempDir ??= mkdtempSync(join(tmpdir(), "murage-pi-mcp-"));
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
      if (gateSecret && (turn.permissionNow?.() ?? turn).noLimits === true) {
        // Owners: shared inventory publisher — pi-roots; turn context consumer — Pi gate.
        // Only the constant-sized descriptor belongs to this turn’s temporary directory.
        mcpTempDir ??= mkdtempSync(join(tmpdir(), "murage-pi-gate-"));
        wipeContextFile = join(mcpTempDir, "wipe-context.json");
        try {
          const context = degradedWipeContext(wipeContextFor(threadId, turn.warmIdentity?.botId, {cwd:turn.cwd,project:turn.cwd}), turn.warmIdentity?.botId);
          writeFileSync(wipeContextFile, JSON.stringify({context:{project:context.project,home:context.home,dataDir:context.dataDir},inventoryPath:inventoryPath()}), {mode:0o600});
        } catch (err) {
          dropTemp(mcpTempDir);
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
      if (!piVersion && versionProbeAllowed(`pi|${config.cli}`, cliSig(config.cli, piProbeEnv()))) await stopGate.step(e, probePiVersion(), { onStopped: () => dropTemp(mcpTempDir) });
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
      const handed = await stopGate.step(e, handedEngineEnv({
        cwd: botFolderOrThrow(turn),
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
          ...(gateSecret ? { MURAGE_PI_GATE: gateSecret, MURAGE_PI_GATE_MODE: (turn.releaseBinding ?? null) === null ? "open" : "bound" } : {}),
          ...(gateModeFile ? { MURAGE_PI_GATE_MODE_FILE: gateModeFile, MURAGE_PI_GATE_STATUS_FILE: gateStatusFile! } : {}),
          ...(wipeContextFile ? { MURAGE_PI_WIPE_CONTEXT_FILE: wipeContextFile } : {}),
          ...((turn.permissionNow?.() ?? turn).noLimits === true ? { MURAGE_PI_NO_LIMITS: "1" } : {}),
          // The Chief's proposal turn: the agents server's propose tool, as
          // pi-mcp-extension.ts names it, is the one tool that runs unasked.
          ...(gateSecret && turn.proposalOnly ? { MURAGE_PI_GATE_ONLY: "agents_project_propose" } : {}),
        },
      }, process.env.MURAGE_CLOUD_ROLE === "home" ? piEnvironment({ ...process.env, ...input.environment }) : undefined), { onStopped: () => dropTemp(mcpTempDir) });
      // A turn names its bot (the launcher scopes per-bot state by it); the --version probe does not.
      const turnEnv = handed.env;
      cloudTurnBot(turnEnv, turn.warmIdentity?.botId);
      const shellForm = await stopGate.step(e, piShellForm(handed.env), { onStopped: () => dropTemp(mcpTempDir) });

      // spawnCli can throw synchronously (unresolvable CLI); if it does, the
      // 0600 temp file with the box token / composio key / comms token must
      // not be left on disk — closeTurn never runs because no child existed.
      // The launch reads the gate in the same tick as the spawn: a Stop or the close that landed ends the turn here, spawning nothing.
      let releaseInventoryConsumer = () => {};
      const child = stopGate.launch(e, () => {
        try {
          assertPiInventoryAvailable();
          // The pi whose --version gated piIsolationArgs (piProbeEnv: Murage's own PATH), not the handed PATH's first.
          const launchCli = engineLaunchFile(config.cli, piProbeEnv());
          if (process.platform === "win32" && shellForm[0]) {
            mcpTempDir ??= mkdtempSync(join(tmpdir(), "murage-pi-mcp-"));
            const extension = join(mcpTempDir, "pinned-bash.ts");
            writeFileSync(extension, piPinnedBashExtension(shellForm[0]), { mode: 0o600 });
            childArgs.push("-e", extension);
          }
          const spawned = spawnCli(launchCli, childArgs, {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: botFolderOrThrow(turn),
            env: handed.env,
          }, engineJob({ noLimits: (turn.permissionNow?.() ?? turn).noLimits === true, powerSession }), undefined, threadId);
          // Register before any runtime emission can reenter Store. A failed
          // invalidation terminates the exact owned engine without Pi's abort
          // grace period, even when the stale inventory could not be removed.
          const stopInventoryConsumer = () => {
            try { spawned.kill("SIGKILL"); } finally { killCliTree(spawned); }
          };
          try { releaseInventoryConsumer = registerPiInventoryConsumer(stopInventoryConsumer); }
          catch(error){stopInventoryConsumer();throw error;}
          return spawned;
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
      });
      if ((turn.permissionNow?.() ?? turn).noLimits === true) {
        const title = takeNoLimitsPowerFallbackNotice(powerSession);
        if (title) {
          const itemId = `power-fallback-${turnId}`;
          emit({ ...base(threadId, turnId), type: "item.started", itemId, itemType: "tool", origin: "murage", toolKind: "notice", title });
          emit({ ...base(threadId, turnId), type: "item.completed", itemId, itemType: "tool", ok: true });
        }
      }
      const leaseId = powerRetried ? newId() : turnId;
      const teardown = teardowns.track(threadId, leaseId, child);
      if (powerRetried) retryLeases.set(turnId, leaseId);
      teardown.onClosed(() => {
        if (retryLeases.get(turnId) === leaseId) retryLeases.delete(turnId);
        releaseInventoryConsumer();
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
      const responseWaiters = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer?: NodeJS.Timeout }>();
      const rejectWaiters = (err: Error) => {
        for (const waiter of responseWaiters.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(err);
        }
        responseWaiters.clear();
      };
      /** `timeoutMs` Infinity waits for the answer however long it takes; the child closing or a Stop still ends the wait. */
      const awaitResponse = (command: string, timeoutMs = 20_000) => {
        const answer = new Promise<unknown>((resolve, reject) => {
          const timer = timeoutMs === Infinity ? undefined : setTimeout(() => {
            responseWaiters.delete(command);
            reject(new Error(`${ENGINE} timed out (no answer for ${plainDuration(timeoutMs)}).`));
          }, timeoutMs);
          timer?.unref?.();
          responseWaiters.set(command, { resolve, reject, timer });
        });
        // The request is written after the waiter is registered, and a refusal at that write (the memory fence)
        // ends the turn before anything awaits the answer: closeTurn then rejects it with no listener, which
        // would take the server down as an unhandled rejection. Every awaiting caller still sees the rejection.
        answer.catch(() => {});
        return answer;
      };
      /** The bounded reason a one-shot RPC failed, for a user-facing error. */
      const rpcFailure = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);
      child.stdin.on("error", () => {
        // EPIPE can arrive before close has classified a Seatbelt refusal.
        // Keep startup pending until that exact child's close confirms the cause.
        if (!powerRetried && !sessionReady && (turn.permissionNow?.() ?? turn).noLimits === true) {
          void teardown.wait(stopBudget(0)).then(() => {
            if (hostPowerRefused(child) && noLimitsPowerFallbackActive(powerSession)) retryingPower = true;
            rejectWaiters(new Error(`${ENGINE} stopped taking input.`));
          });
        } else rejectWaiters(new Error(`${ENGINE} stopped taking input.`));
      });
      const send = (obj: Record<string, unknown>) => {
        const wire = serializePiInput(obj, turn.beforeSubmit);
        let complete!: (ok: boolean) => void;
        const receipt = new Promise<boolean>(resolve => { complete = resolve; });
        const enqueue = () => registerBusyloopRequestSite(fluxRouteFor(piRequestUrl(requestedModel, turnEnv)), child.stdin.write(wire, error => complete(!error)));
        // Stop closes new submissions, but its exact code-only cancel must
        // still reach this child so Pi can flush its session before exit.
        // The retained native-answer fence below still owns that write.
        const abortControl = obj.type === "abort" && Object.keys(obj).length === 1;
        const cancelControl = obj.type === "extension_ui_response" && obj.cancelled === true
          && typeof obj.id === "string" && Object.keys(obj).sort().join(",") === "cancelled,id,type";
        const write = () => abortControl || cancelControl ? enqueue() : stopGate.launch(e, enqueue);
        if (obj.type === "prompt") fencedSubmit(turn, write, wire, () => {
          if (stopGate.why(e) || e.done) throw new Error("PI_TURN_STOPPED");
        });
        else releaseNativeAnswer(turn.releaseBinding ?? null, "pi:answer", wire, write);
        appendNative(threadId, { dir: "out", source: "pi.rpc", msg: obj }, { rawChars: wire.length - 1 });
        return receipt;
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
      // The last assistant message of the attempt in progress, and what a failed compaction recovery said.
      let lastAssistant: { stopReason?: string; errorMessage?: string } | null = null;
      let recoveryFailure: string | null = null;
      let attemptStreamed = false;
      let compactionItem: string | null = null;
      // The slow-session line (E24), open while the turn still waits on pi's session answer.
      let sessionWaitItem: string | null = null;
      const askTimers = new Set<{ clear: () => void }>();
      const closeCompaction = (ok: boolean) => {
        if (compactionItem) emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId: compactionItem, ok });
        compactionItem = null;
      };
      const closeSessionWait = (ok: boolean) => {
        if (sessionWaitItem) emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId: sessionWaitItem, ok });
        sessionWaitItem = null;
      };
      const terminate = () => {
        try { child.stdin.end(); } catch { /* already closed */ }
        teardown.markStopRequested();
        try { killCliTree(child); } catch { /* already gone */ }
      };
      /** PIS: the one memoized closer of this turn's child; closeTurn, the refusal exit and Stop's abort acknowledgement all join it (one tree kill). */
      let closed = false;
      const closeOnce = () => { if (closed) return; closed = true; terminate(); };
      /** The one way a turn ends (designs/PI-SETTLE-AGENT-END-1013.md): once, with no ask outliving it. */
      const closeTurn = (end: TurnEnd): boolean => {
        if (settled) return false;
        settled = true;
        // P1 ATTACH (M4): a lease-only refusal (no driver claim) is found by the captured dispatch generation, so a lookup Stop that
        // reaches this settle ends the turn memory-refused (lease mode: no turn.completed of its own), never cancelled.
        const fenced = fencedOf(refusalOwner);
        if (fenced && fenced.kind !== "submission") end = failed(LEDGER_REFUSAL_LINE, { stopReason: "memory-refused" });
        for (const answer of pending.values()) void answer({behavior:'deny'}, 'retire', 'system');
        scopedRequests.clear();
        for (const timer of askTimers) timer.clear();
        askTimers.clear();
        closeCompaction(false);
        closeSessionWait(false);
        // A handshake step still waiting (E24's session answer has no timeout) ends with the turn; only Stop's own bounded
        // abort acknowledgement is kept, so pi is not killed while it flushes.
        for (const [key, waiter] of [...responseWaiters]) {
          if (key === "abort") continue;
          responseWaiters.delete(key);
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`${ENGINE} turn ended.`));
        }
        flushAssistantText();
        // the gate's finish is the one ending: a Stop that reached the turn reads as the stopped pair, a close as the engine closing
        endTurnAfterHandback(e, () => e.finish({
          ...(fenced ? { final: true as const, ...(fenced.closer === "lease" ? { leaseMode: true as const } : {}), releaseAfter: fenced.teardown } : {}),
          // a refused lease is the turn's terminal even after a Stop was asked (stop-gate would otherwise rewrite it cancelled)
          ...(!fenced && end.kind === "failed" && end.stopReason === "memory-refused" ? { final: true as const } : {}),
          ok: end.kind !== "failed",
          stopReason: end.kind === "done" ? "end_turn" : end.kind === "cancelled" ? "cancelled" : end.stopReason ?? "failed",
          ...(end.kind === "failed" && end.message ? { error: { message: end.message, ...(end.setup !== undefined ? { setup: end.setup } : {}) } } : {}),
          extra: { ...(turnUsage ? { usage: turnUsage } : {}), ...(turnCost !== undefined ? { cost: turnCost } : {}) },
        }));
        if (!aborting) closeOnce();
        active.delete(threadId);
        return true;
      };
      /** The captured refusal owner of this turn (G0-R): refusalFor stores the R here and pushes R.teardown. */
      const refusalOwner: { fenced?: FencedRefusal; teardowns: Promise<unknown>[]; releaseBinding: SendTurnInput["releaseBinding"]; closing?: Promise<unknown> } = { teardowns: [], releaseBinding: turn.releaseBinding };
      const claimRefusal = (error: unknown, site: string, kind?: "submission"): FencedRefusal | undefined =>
        refusalFor(error, site, { engine: "pi", threadId, binding: turn.releaseBinding, owner: refusalOwner, target: refusalOwner, ...(kind ? { kind } : {}) });
      /** piClose: the one terminate + this turn's teardown confirmed within the stop budget (never kills first beyond terminate). */
      const piClose = (): ConfirmedClose => async () => {
        terminate();
        const result = await teardowns.wait(threadId, teardownId(turnId), piStopBudget());
        if (!result.closeConfirmed) { void teardowns.closed(threadId, teardownId(turnId)).then(() => refusalOwner.fenced?.confirmedLate()); return { confirmed: false, reason: "timeout" }; }
        return { confirmed: true };
      };
      const settleFenced = async (): Promise<void> => {
        closeTurn(refusalOwner.fenced?.kind === "submission" ? failed(piRefusedLine(ENGINE, "the message was withheld"), { stopReason: "submission_refused" }) : failed(LEDGER_REFUSAL_LINE, { stopReason: "memory-refused" }));
      };
      /** The claim winner runs the ONE composite close (settle first, never awaiting R.teardown); a lease-won claim only joins. */
      const finishRefusal = async (R: FencedRefusal): Promise<void> => {
        try { if (R.closer === "driver") await R.close(composeClose({ settleFenced }, piClose())); else await settleFenced(); } catch { /* the close never rejects; the settle is guarded */ }
      };
      const failed = (message?: string, more: { stopReason?: string; setup?: boolean } = {}): TurnEnd => ({ kind: "failed", ...(message ? { message } : {}), ...more });
      const refuseBoundExit = () => {
        if (settled) return;
        // Discard buffered content before the synchronous lease refusal interrupts us.
        assistantText = "";
        todo = createTodoBlockFilter();
        try { if (turn.releaseBinding) refuseConsumingTurn(turn.releaseBinding); }
        catch { /* the lease handler owns its terminal refusal */ }
        finally {
          // The lease's one frozen result: the owner's Stop makes it silent, an MCP cause keeps its own sentence.
          const line = emitterRefusalLine(turn.releaseBinding);
          closeTurn(failed(line, { stopReason: "memory-refused" }));
          closeOnce();
          rejectWaiters(new Error(line ?? "MEMORY_CONTEXT_REVOKED"));
        }
      };
      const noFinish = () => `${ENGINE} could not finish this turn.`;
      /** How a run that pi says is over ended. Only a last message of `stop` is success; anything unknown fails. */
      const outcome = (aborted: boolean): TurnEnd => {
        const sr = lastAssistant?.stopReason;
        if (aborted || sr === "aborted" || sr === "cancelled") return { kind: "cancelled" };
        if (recoveryFailure) return failed(recoveryFailure.slice(0, 2_000));
        if (sr === "stop") return { kind: "done" };
        if (sr === "length") return failed(`This reply stopped at the model's length limit, so it is not complete. Ask ${ENGINE} to continue, or choose a model with a longer limit.`);
        if (sr === "error" || sr === "failed") return failed(String(lastAssistant?.errorMessage ?? noFinish()).slice(0, 2_000));
        return failed(noFinish());
      };

      /** A Stop with a card open: pi's abort waits for the dialog, which has no abort listener of its own. */
      const cancelOpenAsks = () => {
        for (const id of pending.keys()) {
          try { NotModelRequest("Pi session setup, model/effort selection, abort or extension UI reply; no prompt is submitted", send({ type: "extension_ui_response", id, cancelled: true })); } catch { /* pi is gone: nothing is waiting */ }
        }
      };
      const stop = (why: "asked" | "closing") => {
        if (settled || aborting) return;
        aborting = true;
        // Register before writing: pi's own events can precede the abort response, and it must
        // not have stdin closed or be killed while its session is still flushing.
        const completed = awaitResponse("abort", CLI_TERM_GRACE_MS);
        void completed.catch(() => {}).then(closeOnce);
        try {
          NotModelRequest("Pi session setup, model/effort selection, abort or extension UI reply; no prompt is submitted", send({ type: "abort" }));
        } catch (error) {
          // A Stop write refused while the lease is revoked ends the turn as that refusal, never cancelled (PIS, P1); any other failure is pi gone.
          if ((error as Error | undefined)?.message === "MEMORY_CONTEXT_REVOKED") { refuseBoundExit(); return; }
          rejectWaiters(new Error(`${ENGINE} stopped taking input.`));
        }
        cancelOpenAsks();
        // Only a stop someone asked for ends as Stop; a quit or restart alone is the engine closing (ACP's rule, CLOSE-STOP-1014).
        closeTurn(why === "asked" ? { kind: "cancelled" } : failed(engineClosedLine(ENGINE, null), { stopReason: "exit_before_result" }));
      };
      active.set(threadId, { stop, turnId, pending, child, scopedRequests });
      stopGate.bindLive(e, { stop, kept: () => undefined });   // pi keeps no usage getter: stop() closes the turn in the same tick, which already finishes with turnUsage and turnCost (PI-NO-KEPT, ruled);  from here a Stop or the close reaches the live child (the launch above made the entry live in the same tick)

      const onEvent = (evt: PiEvent, rawChars: number) => {
        appendNative(threadId, { dir: "in", source: "pi.rpc", msg: evt }, { rawChars });
        // After the end only what a graceful Stop needs still counts: the abort's response, and a dialog pi would otherwise wait on.
        if (settled && evt.type !== "response") {
          if (aborting && evt.type === "extension_ui_request" && evt.id && PI_DIALOGS.has(String(evt.method))) {
            try { NotModelRequest("Pi session setup, model/effort selection, abort or extension UI reply; no prompt is submitted", send({ type: "extension_ui_response", id: evt.id, cancelled: true })); } catch { /* pi is gone */ }
          }
          return;
        }
        switch (evt.type) {
          case "response": {
            if (evt.command === "prompt") {
              if (evt.success === false) closeTurn(failed(piRefusedLine(ENGINE, evt.error)));
              else if ((evt.data as { disposition?: string } | undefined)?.disposition === "handled") closeTurn({ kind: "done" });
              return;
            }
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
          case "message_start": {
            if (evt.message?.role !== "assistant") return;
            // An error or a cut reply followed by another attempt: retry or recovery replaced it. What it showed goes.
            if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "length") {
              assistantText = "";
              todo = createTodoBlockFilter();
              if (attemptStreamed) for (const streamKind of ["assistant_text", "reasoning_text"] as const) emit({ ...base(threadId, turnId), type: "content.reset", streamKind });
            }
            lastAssistant = null;
            recoveryFailure = null;
            attemptStreamed = false;
            return;
          }
          case "message_end": {
            if (evt.message?.role !== "assistant") return;
            lastAssistant = { stopReason: evt.message.stopReason, errorMessage: evt.message.errorMessage };
            if (evt.message.usage) { addUsage(evt.message.usage); roundCounted = true; }
            // Neither retry nor recovery replaces a `stop` message, and the owner has the reply even if pi then wedges.
            if (evt.message.stopReason === "stop") flushAssistantText();
            return;
          }
          case "auto_retry_start": {
            emit({
              ...base(threadId, turnId),
              type: "turn.retrying",
              attempt: Number(evt.attempt) || 1,
              delayMs: Number(evt.delayMs) || 0,
              reason: classifyError({ text: String(evt.errorMessage ?? "") }).reason,
              // the first try plus pi's retries
              ...(typeof evt.maxAttempts === "number" ? { maxAttempts: evt.maxAttempts + 1 } : {}),
            });
            return;
          }
          case "compaction_start": {
            closeCompaction(true);
            compactionItem = newId();
            emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", origin: "murage", itemId: compactionItem, title: "compact" });
            return;
          }
          case "compaction_end": {
            closeCompaction(!evt.errorMessage && evt.aborted !== true);
            // Only recovery can fail a turn; compaction after a finished reply never does.
            if (evt.errorMessage && evt.reason === "overflow" && evt.aborted !== true && lastAssistant?.stopReason !== "stop") recoveryFailure = String(evt.errorMessage);
            return;
          }
          case "agent_settled": {
            closeTurn(outcome(evt.aborted === true));
            return;
          }
          case "message_update": {
            const e = evt.assistantMessageEvent;
            if (!e) return;
            if (e.type === "text_delta" && typeof e.delta === "string") {
              attemptStreamed = true;
              assistantText += e.delta;
              emitTodoOutput(todo.push(e.delta));
            } else if (e.type === "thinking_delta" && typeof e.delta === "string") {
              attemptStreamed = true;
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
            if (PI_DIALOGS.has(String(evt.method))) {
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
                // PI1+: the cancel is a native write; a revoked binding refuses it, which is the turn's refusal (never a "non-JSON line")
                try { NotModelRequest("Pi session setup, model/effort selection, abort or extension UI reply; no prompt is submitted", send({ type: "extension_ui_response", id: reqId, cancelled: true })); }
                catch (error) {
                  const R = claimRefusal(error, "pi.answer.cancel");
                  if (!R) throw error;
                  if (R.closer === "driver") refusalOwner.closing = finishRefusal(R);
                }
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
              const timer: { clear: () => void } | null = questions && turn.unattendedAskNote
                ? wakeAwareTimeout(() => {
                    void pending.get(reqId)?.({behavior:'deny'}, 'retire', 'timeout');
                  }, QUESTION_TIMEOUT_MS)
                : null;
              if (timer) askTimers.add(timer);
              // Register BEFORE emitting: the harness may auto-approve from
              // inside its synchronous request.opened listener. Emitting first
              // made respondToRequest see no pending ask, return unavailable,
              // then fall back to a human card on every "Always allow" call.
              const mountRecords = piMountRecords(turn, mcpServers);
              // Murage's own gate, recognised by this turn's secret: the call it
              // carries is what the stop line and the card read.
              const gate = isGateAsk ? piGateAsk(typeof evt.prefill === "string" ? evt.prefill : "", mountRecords) : null;
              const slot: NativeAskSlot = {closed:false};
              // PIN: a refused answer write claims BEFORE commit(false) (native-ask runs refused first); the winner's close starts after
              // the commit (microtask) so closeTurn finds no pending entry to deny a second time. `writing` never awaits the close.
              const refusedAsk = (error: unknown): void => {
                const R = claimRefusal(error, "pi.ask");
                if (R && R.closer === "driver") queueMicrotask(() => { refusalOwner.closing = finishRefusal(R); });
              };
              pending.set(reqId, (decision, mode = 'answer', source = 'user') => {
                const response = (): Record<string,unknown> => {
                if (questions) {
                  // validated picks first; a one-string client (voice) still works
                  const value = decision.behavior !== "answer"
                    ? ""
                    : decision.answers?.length
                      ? toPiValue(questions, decision.answers)
                      : (decision.message ?? "").trim();
                  return value ? {type:"extension_ui_response",id:reqId,value} : {type:"extension_ui_response",id:reqId,cancelled:true};
                }
                if (isGateAsk) {
                  // Rule 73d: Allow echoes the input the gate sent (a rewrite,
                  // when the verdict makes one, replaces it); Deny carries the
                  // reason, which for a narrowing denial (Rule 72) is the
                  // verdict's own text. A call that reached this side cut, or
                  // with no input Murage can vouch for, has nothing to echo:
                  // Allow then tells the gate to run the call it holds.
                  const allowed = decision.behavior === "allow" && gate?.gateInput !== undefined && !gate.truncated;
                  const reply = allowed
                    ? { allow: true, input: (turn.permissionNow?.()??turn).noLimits===true?decision.updatedInput??gate!.gateInput:gate!.gateInput }
                    : decision.behavior === "allow"
                      ? { allow: true, keep: true }
                      : { deny: true, reason: decision.message?.trim() || "The owner did not allow this in Murage." };
                  const answer = (turn.releaseBinding ?? null) === null ? reply : piGateControlAnswer(decision);
                  return { type: "extension_ui_response", id: reqId, value: JSON.stringify(answer) };
                }
                return decision.behavior === 'deny' ? {type:'extension_ui_response',id:reqId,cancelled:true} : {type:'extension_ui_response',id:reqId,confirmed:true};
                };
                const frame=response();
                return deliverNative(slot,mode,JSON.stringify(frame),()=>send(frame),()=>child.stdin.writable && !child.stdin.destroyed,accepted=>{
                  pending.delete(reqId); const wasScoped=scopedRequests.delete(reqId);
                  timer?.clear(); if(timer) askTimers.delete(timer);
                  answerTransport.confirm(threadId,reqId,Promise.resolve(accepted));
                  emit({...base(threadId,turnId),requestId:reqId,type:'request.resolved',behavior:accepted?decision.behavior:'deny',source:accepted?source:'unavailable',...(wasScoped?{approvalScope:'local-computer' as const}:{})});
                },()=>decision.behavior!=='allow'||(turn.permissionNow?.()??turn).noLimits!==true||answerTransport.guardRelease(threadId,reqId,()=>guardEngineRelease({threadId,turnId,requestId:reqId,providerInstanceId:instanceId},decision.updatedInput)),undefined,refusedAsk);
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
              if (gate && !questions && (gate.tool === "Bash" || gate.tool === "PowerShell")) void execEnvNow(threadId, piCheckForm(gate.tool, shellForm), handed, botFolderOrThrow(turn)).then(open);
              else open(execEnvHanded(handed, botFolderOrThrow(turn), shellForm));
            }
            return;
          }
          // A turn_end is one model round and an agent_end can be followed by compaction recovery: neither ends a turn.
          case "turn_end": {
            const round = evt.usage ?? evt.message?.usage;
            if (round && !roundCounted) addUsage(round);
            roundCounted = false;
            return;
          }
          case "agent_end": {
            const round = evt.usage ?? evt.message?.usage;
            if (round && !turnUsage) addUsage(round);
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
            onEvent(registerBusyloopPayloadSite("read", JSON.parse(line)) as PiEvent, line.length);
          } catch (error) {
            // a fenced refusal thrown from a handler is the turn's refusal, never a malformed line (PI1+)
            const R = claimRefusal(error, "pi.stdout");
            if (R && R.closer === "driver") refusalOwner.closing = finishRefusal(R);
            /* otherwise: skip non-JSON line */
          }
        },
        onOverflow: (overflow) => {
          appendNative(threadId, { dir: "in", source: "pi.rpc", msg: { frameOverflow: overflow } });
          if (settled) return;
          const message = frameOverflowMessage("pi", overflow);
          // closed first so a pending handshake step sees the turn is over
          // and adds no second failure
          closeTurn(failed(message, { stopReason: FRAME_TOO_LARGE }));
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
      // stdout ends before exit on every recorded death, so ending here would lose the exit line; waiting on close alone could
      // hang on a close Node never reports. This timer can only lead to a failure.
      let stdoutEndTimer: NodeJS.Timeout | undefined;
      child.stdout.on("end", () => {
        if (settled) return;
        stdoutEndTimer = setTimeout(() => {
          if (settled) return;
          if ((turn.releaseBinding ?? null) !== null) { refuseBoundExit(); return; }
          closeTurn(failed(piClosedMessage(null, null)));
          rejectWaiters(new Error(`${ENGINE} stopped before replying.`));
        }, ROOT_CLOSE_GRACE_MS);
        stdoutEndTimer.unref?.();
      });
      registerIntake(threadId, child.stdout, child);
      child.on("error", (err) => {
        if ((turn.releaseBinding ?? null) !== null) { refuseBoundExit(); return; }
        const fail = describeSpawnFailure(err as NodeJS.ErrnoException, config.cli);
        // S4 power: a launch the block could not cover wrote no prompt (turn-attribution.ts notWritten).
        if ((err as NodeJS.ErrnoException).code === HOST_POWER_CODE) turn.notWritten?.();
        // closed first, as below: a pending handshake step adds no second failure, and a late error after the end adds nothing
        closeTurn(failed(fail.message, { setup: fail.setup }));
        rejectWaiters(new Error(fail.message));
      });
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(stdoutEndTimer);
        if ((turn.releaseBinding ?? null) !== null) { refuseBoundExit(); return; }
        // S4 power (design sections 2 and 8): bwrap or sandbox-exec refused before pi ran; nothing it was sent was delivered.
        if (!settled && hostPowerRefused(child)) {
          if (!sessionReady && !powerRetried && (turn.permissionNow?.() ?? turn).noLimits === true && noLimitsPowerFallbackActive(powerSession)) {
            retryingPower = true;
            rejectWaiters(new Error("power startup retry"));
            return;
          }
          turn.notWritten?.();
          closeTurn(failed(hostPowerMessage()));
          rejectWaiters(new Error(hostPowerMessage()));
          return;
        }
        // A close without a terminal event is a failed turn, never a hang, and never a silent one: a wrapper (bwrap,
        // sandbox-exec) holds stdin open until it exits, so no EPIPE fires first, and a pi that crashes after the first
        // write gets none either. Exactly one error, emitted and settled before the waiters are rejected, so a pending
        // handshake step (failBeforePrompt) sees the turn is over and adds no second one.
        closeTurn(failed(piClosedMessage(code, signal)));
        rejectWaiters(new Error(`${ENGINE} stopped before replying.`));
      });

      e.markStarted();

      /** Fail the turn before the prompt is dispatched: surface why, settle
       * ok:false and stop the child (settle kills it). A no-op once the turn
       * has already settled — e.g. the child exited, or the user cancelled. */
      const failBeforePrompt = (message: string) => { closeTurn(failed(message)); };

      // handshake: resume the remembered session or start a fresh one. The
      // harness persists session.started.sessionId as the resumeCursor and
      // hands it back next turn, so that id IS the resume handle — pi's
      // sessionFile, which switch_session expects as `sessionPath`.
      const sessionPath = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      let sessionFile = sessionPath;
      try {
        const command = sessionPath ? "switch_session" : "new_session";
        // E24 (upstream 4e6688954): no timeout. A prompt sent before pi answers runs on a session pi then replaces under it,
        // and that turn never ends. A slow answer is waited for, and after PI_SESSION_SLOW_MS the chat says so; Stop, a
        // refusal or pi closing still end the wait.
        const hsPromise = awaitResponse(command, Infinity);
        NotModelRequest("Pi session setup, model/effort selection, abort or extension UI reply; no prompt is submitted", send(sessionPath ? { type: "switch_session", sessionPath } : { type: "new_session" }));
        const slow = setTimeout(() => {
          if (settled || sessionWaitItem) return;
          sessionWaitItem = `pi-session-wait-${turnId}`;
          const line = piSessionSlowLine(ENGINE);
          emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", origin: "murage", itemId: sessionWaitItem, title: line, spoken: line, toolKind: "notice" });
        }, PI_SESSION_SLOW_MS);
        slow.unref?.();
        const hs = (await stopGate.step(e, hsPromise.finally(() => clearTimeout(slow)))) as { sessionFile?: string; sessionId?: string } | undefined;
        closeSessionWait(true);
        // a late answer to a turn that already ended (Stop, pi closing) announces nothing after its turn.completed
        if (settled) return { turnId };
        if (hs?.sessionFile) sessionFile = hs.sessionFile;
        sessionReady = true;
        emit({
          ...base(threadId, turnId),
          type: "session.started",
          sessionId: sessionFile ?? hs?.sessionId ?? null,
          model: turn.model ?? null,
        });
      } catch (err) {
        if (retryingPower) {
          const closed = await stopGate.step(e, teardown.wait(stopBudget(0)));
          if (closed.closeConfirmed) {
            active.delete(threadId); e.live = false; e.stopLive = undefined;
            return stopGate.step(e, runTurn(originalTurn, e, true));
          }
          console.warn(`${ENGINE} power fallback: refused startup could not be stopped`);
        }
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
          NotModelRequest("Pi session setup, model/effort selection, abort or extension UI reply; no prompt is submitted", send({ type: "set_model", provider: chosen.provider, modelId: chosen.modelId }));
          await stopGate.step(e, modelPromise);
        } catch (err) {
          // PIU: a fenced refusal of the set_model send is classified FIRST (it is not a model-selection failure)
          const refused = claimRefusal(err, "pi.setup.model");
          if (refused) { refusalOwner.closing = finishRefusal(refused); return { turnId }; }
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
          NotModelRequest("Pi session setup, model/effort selection, abort or extension UI reply; no prompt is submitted", send({ type: "set_thinking_level", level: piThinkingLevel(turn.effort) }));
          await stopGate.step(e, levelPromise);
        } catch (err) {
          const refused = claimRefusal(err, "pi.setup.effort");
          if (refused) { refusalOwner.closing = finishRefusal(refused); return { turnId }; }
          /* keep going on the engine default */
        }
      }
      // cancelled or exited while pinning: nothing left to prompt
      if (settled) return { turnId };

      const message = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
      // Keep the refused child addressable until the harness binds its lease
      // and performs exact-turn teardown. Never submit across this refusal.
      // D5: a refusal is recorded by the boundary itself (a first refusal withdraws; a refused retry never undoes an earlier write). Only a
      // caller with no attempt API still gets the legacy arg-less notWritten.
      let attempt: number | void;
      try { attempt = turn.beforeSubmit?.(); } catch (error) {
        if (!turn.attemptNotWritten) turn.notWritten?.();
        // PISUB-p: the prompt boundary refused before any write: kind submission, one terminal (no more unsettled `return {turnId}`)
        const refused = claimRefusal(error, "pi.prompt.prepare", "submission");
        // no await in the turn body (the gate's R1: every await here is a gate.step): the close is tracked on the owner
        if (refused) refusalOwner.closing = finishRefusal(refused);
        return { turnId };
      }
      if (settled) return { turnId };
      try {
        stopGate.launch(e, () => registerBusyloopRequestSite(fluxRouteFor(piRequestUrl(requestedModel, turnEnv)), send({ type: "prompt", message })));
        turn.attemptWritten?.(attempt);
      } catch (error) {
        if (turn.attemptNotWritten) turn.attemptNotWritten(attempt);
        // PISUB: the prompt send's own boundary entry refused (a second, still-unwritten attempt): kind submission, one terminal
        const refused = claimRefusal(error, "pi.prompt", "submission");
        if (refused) { refusalOwner.closing = finishRefusal(refused); return { turnId }; }
        failBeforePrompt(`${ENGINE} stopped before it took this message. Send your message again.`);
      }

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const probe = await probePi();
      if (!("version" in probe)) return { state: "unavailable", reason: probe.reason };
      const { version } = probe;
      // The update row, not a card that fails on every turn; the same check a turn makes.
      const belowTurnMin = piBelowTurnMin(version);
      if (belowTurnMin) return { state: "unavailable", version, reason: belowTurnMin };
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
      // ALL.eld250 B9: the spawn runs in its own macrotask, not in the task that asked (the start-up snapshot scan reached it before listen)
      await nextTask();
      const answer = await new Promise<{ err: Error | null; out: string }>((resolve) => {
        const child = spawnCli(config.cli, ["--version"], {
          cwd: probeFolder(),
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

    return withRequestDelivery({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      keepsNoSession: true,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        mcpToolSurface: PI_TOOL_SURFACE,
        capabilities: {
          // Every prompt write runs inside fencedSubmit: beforeSubmit passes, then the bytes are written, with no await between.
          fencedWrites: true,
          // model is set per turn via set_model before prompt
          sessionModelSwitch: "in-session",
          // Integrations arrive as stdio MCP servers mounted by the
          // pi-mcp-extension (pi core has no MCP client of its own).
          browserMcp: true,
          agentsMcp: true,
          consumingMcp: false,
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
          stopGate.ask(threadId, turnId);   // first, before any await: a starting turn ends as the stopped pair, a live one is stopped
          const result = await teardowns.wait(threadId, teardownId(turnId), piStopBudget());
          if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
          return result;
        },
        awaitTurnTeardown: (threadId, turnId) => teardowns.wait(threadId, teardownId(turnId), piStopBudget()),
        awaitTurnClose: (threadId, turnId) => teardowns.closed(threadId, teardownId(turnId)),
        respondToRequest: async (threadId, requestId, decision) => {
          const entry = active.get(threadId);
          const answer = entry?.pending.get(requestId);
          if (!entry || !answer) return "unavailable";
          if (!(await answer({ behavior: decision.behavior, message: decision.message, answers: decision.answers, source: decision.source, updatedInput:decision.updatedInput }))) return 'unavailable';
          return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          stopGate.ask();   // first, before any await: every starting turn ends as the stopped pair, every live one is stopped
          const result = await teardowns.waitAll(piStopBudget());
          if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        stopGate.close();
        for (const { stop } of active.values()) stop("closing");
        // every turn ends (closing) before the listeners can clear; an entry still open at the 5 s bound is settled closing
        const open = await stopGate.drain(providerCloseDeadlineMs());
        stopGate.settleOutstanding(open);
        const result = await teardowns.waitAll(piStopBudget());
        if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
        listeners.clear();
      },
    }, answerTransport);
  },
};
