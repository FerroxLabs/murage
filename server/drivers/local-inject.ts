// Shared local-host inject — the sidecar workflow, inside the picker.
// Probe Ollama / LM Studio / llama.cpp / vLLM / SGLang / oMLX / EXO /
// Unsloth plus the servers the user added under Settings → Models → Local
// models, list whatever they serve under Custom on every agent, and decode a
// pick back into a host + API id the selected driver can inject.
//
// TRUST BOUNDARY: `decodeInjectId` only accepts a host that is either one of
// the fixed loopback entries below or a user-added server that passes the
// add-time address rule again on this read (server/local-servers.ts). Every
// engine writer starts from `decodeInjectId`/`localHost`, so an address that
// fails validation never reaches a CLI config.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog } from "../contracts.ts";
import {
  LOCAL_ENGINE_SURFACE,
  localServerDisplayLabel,
  type LocalContextReading,
  type LocalServerKind,
} from "../../shared/local-models.ts";
import { cachedLocalToolTest, readLocalServers, userLocalServer, type StoredLocalServer } from "../local-servers.ts";

export interface LocalHost {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  kind: LocalServerKind;
  /** "added" = user-added in Settings; absent = one of the fixed loopback entries. */
  source?: "added";
  /** User-given name (added servers only). */
  name?: string;
}

// Placeholder keys: local servers started without --api-key accept any bearer.
export const LOCAL_HOSTS: LocalHost[] = [
  { id: "omlx", label: "oMLX", kind: "omlx", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "omlx" },
  // llama-server's default port is also 8080. Which of the two answers is
  // decided by fingerprint (`/props` vs `/v1/models/status`), so llama.cpp is
  // never labelled "oMLX". Kept after `omlx` so older `omlx::` picks decode.
  { id: "llamacpp", label: "llama.cpp", kind: "llamacpp", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "local" },
  { id: "ollama", label: "Ollama", kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
  { id: "local_ollama", label: "Ollama", kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
  { id: "exo", label: "EXO", kind: "exo", baseUrl: "http://127.0.0.1:52415/v1", apiKey: "exo" },
  { id: "lmstudio", label: "LM Studio", kind: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "lm-studio" },
  { id: "unsloth", label: "Unsloth", kind: "unsloth", baseUrl: "http://127.0.0.1:8888/v1", apiKeyEnv: "UNSLOTH_STUDIO_AUTH_TOKEN" },
  { id: "unsloth_api", label: "Unsloth", kind: "unsloth", baseUrl: "http://127.0.0.1:8888/v1", apiKeyEnv: "UNSLOTH_STUDIO_AUTH_TOKEN" },
  { id: "vllm", label: "vLLM", kind: "vllm", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "local" },
  { id: "sglang", label: "SGLang", kind: "sglang", baseUrl: "http://127.0.0.1:30000/v1", apiKey: "local" },
];

export const INJECT_SEP = "::";

const HOST_BY_ID = new Map(LOCAL_HOSTS.map((host) => [host.id, host]));
const MODEL_ID = /^[\w][\w./:+-]*$/;

function hostFromStored(server: StoredLocalServer): LocalHost {
  return {
    id: server.id,
    label: localServerDisplayLabel(server.kind, server.name),
    kind: server.kind,
    baseUrl: server.apiBase,
    // Keyless servers still get a harmless placeholder: several CLIs refuse
    // an empty key. The stored key is only ever written for this origin.
    apiKey: server.apiKey ?? "local",
    source: "added",
    name: server.name,
  };
}

/** Built-in loopback hosts plus every valid user-added server. */
export function allLocalHosts(): LocalHost[] {
  return [...LOCAL_HOSTS, ...readLocalServers().map(hostFromStored)];
}

// Loaded-context readings (spec T2), keyed host+model. Filled by every probe
// and by the Local models test; read synchronously by the engine writers that
// size a model's window (Pi, Kimi, Fuigo) instead of hardcoding one.
const contextReadings = new Map<string, LocalContextReading>();

function contextKey(hostId: string, model: string): string {
  return `${hostId}${INJECT_SEP}${model}`;
}

export function rememberLocalContext(hostId: string, model: string, reading: LocalContextReading): void {
  contextReadings.set(contextKey(hostId, model), reading);
}

export function cachedLocalContext(hostId: string, model: string): LocalContextReading | undefined {
  return contextReadings.get(contextKey(hostId, model));
}

/** The probed window for an inject pick, when Murage has read one. */
export function localContextWindow(hostId: string, model: string): number | undefined {
  const reading = cachedLocalContext(hostId, model);
  return reading?.contextWindow;
}

export function clearLocalContextCacheForTests(): void {
  contextReadings.clear();
}

export interface InjectedModel {
  id: string;
  host: string;
  model: string;
  label: string;
  /** In VRAM / running on the host right now — Custom pins these first. */
  loaded?: boolean;
  /** the host's own word on the model's context window (Ollama reports it
   * for running models in /api/ps) — sizes the model-facing rebuild instead
   * of guessing from the name */
  contextWindow?: number;
}

/** Ollama's /api/ps lists running models with their context_length; a
 * small model's real window matters more than a big one's — an 8k model
 * guessed at 32k gets a rebuild it cannot hold. */
export function contextWindowsFromPs(extra: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const rec = extra && typeof extra === "object" ? (extra as { models?: unknown }) : null;
  if (!rec || !Array.isArray(rec.models)) return out;
  for (const m of rec.models) {
    if (!m || typeof m !== "object") continue;
    const row = m as { name?: unknown; model?: unknown; context_length?: unknown };
    const id = typeof row.model === "string" ? row.model : typeof row.name === "string" ? row.name : null;
    const ctx = typeof row.context_length === "number" && Number.isFinite(row.context_length) && row.context_length > 0 ? row.context_length : null;
    if (id && ctx) {
      out.set(id, ctx);
      const baseId = id.split(":")[0]!;
      const current = out.get(baseId);
      out.set(baseId, current === undefined ? ctx : Math.min(current, ctx));
    }
  }
  return out;
}

export function encodeInjectId(host: string, model: string): string {
  return `${host}${INJECT_SEP}${model}`;
}

export function decodeInjectId(id: string | null | undefined): { host: string; model: string } | null {
  if (!id) return null;
  const sep = id.indexOf(INJECT_SEP);
  if (sep <= 0) return null;
  const host = id.slice(0, sep);
  const model = id.slice(sep + INJECT_SEP.length);
  if (!MODEL_ID.test(model) || !localHost(host)) return null;
  return { host, model };
}

/** A fixed loopback host, or a user-added server re-validated on this read. */
export function localHost(id: string): LocalHost | undefined {
  const builtIn = HOST_BY_ID.get(id);
  if (builtIn) return builtIn;
  const stored = userLocalServer(id);
  return stored ? hostFromStored(stored) : undefined;
}

export function injectedApiModel(id: string | null | undefined): string | null {
  return decodeInjectId(id)?.model ?? null;
}

/**
 * Map a picker / leftover API id onto a live `host::model` inject id.
 * Claude Code's settings.model is the last slug it used (e.g.
 * `orcarouter/Qwen3.8-27B-Uncensored-GGUF`) and is not host-encoded, so a
 * Custom pick of that leftover would otherwise skip inject and demand /login.
 */
export function resolveInjectId(
  modelId: string | null | undefined,
  extras: readonly InjectedModel[],
): string | null | undefined {
  if (!modelId) return modelId;
  if (decodeInjectId(modelId)) return modelId;
  const matches = extras.filter((row) => row.id === modelId || row.model === modelId);
  const match = matches.find((row) => row.loaded) ?? matches[0];
  return match?.id ?? modelId;
}

/** Anthropic-compatible base (Claude Code wants this without a trailing /v1). */
export function anthropicBaseUrl(host: LocalHost): string {
  return host.baseUrl.replace(/\/v1\/?$/, "");
}

export function hostApiKey(host: LocalHost, env: Record<string, string | undefined> = process.env): string {
  if (host.apiKeyEnv && env[host.apiKeyEnv]) return env[host.apiKeyEnv]!;
  if (host.apiKey) return host.apiKey;
  if (host.id === "unsloth" || host.id === "unsloth_api") {
    const fromFile = readUnslothKey(env);
    if (fromFile) return fromFile;
  }
  return "local";
}

const CODEX_RESERVED_PROVIDERS = new Set(["openai", "ollama", "lmstudio"]);

/**
 * Configure the custom local providers on the Codex app-server without
 * rewriting the user's config.toml. Provider secrets ride in the child
 * environment; argv only contains the corresponding environment key name.
 */
export function codexLocalProviderArgs(
  env: Record<string, string | undefined>,
  modelId: string | null | undefined,
): string[] {
  const inject = decodeInjectId(modelId);
  if (!inject || CODEX_RESERVED_PROVIDERS.has(inject.host)) return [];
  const host = localHost(inject.host);
  if (!host) return [];
  const envKey = `MURAGE_LOCAL_${host.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
  env[envKey] = hostApiKey(host, env);
  return [
    "-c",
    `model_providers.${host.id}.name=${JSON.stringify(host.label)}`,
    "-c",
    `model_providers.${host.id}.base_url=${JSON.stringify(host.baseUrl)}`,
    "-c",
    `model_providers.${host.id}.env_key=${JSON.stringify(envKey)}`,
  ];
}

function firstUnslothToken(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const rec = row as { minted?: unknown; saved?: unknown; api_key?: unknown };
  for (const bucket of [rec.minted, rec.saved]) {
    if (typeof bucket === "string" && bucket) return bucket;
    if (Array.isArray(bucket)) {
      const token = bucket.find((value) => typeof value === "string" && value);
      if (typeof token === "string") return token;
    }
  }
  if (typeof rec.api_key === "string" && rec.api_key) return rec.api_key;
  return null;
}

function readUnslothKey(env: Record<string, string | undefined>): string | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  try {
    const raw = JSON.parse(readFileSync(join(home, ".unsloth", "studio", "auth", "agent_api_key.json"), "utf8")) as {
      api_key?: unknown;
      servers?: unknown;
    };
    // Older Studio wrote `{ api_key }`. Current Studio writes
    // `{ servers: { "http://127.0.0.1:8888": { minted: ["sk-unsloth-…"] } } }`.
    // Prefer the localhost minted token so a stale mixed-format file cannot
    // win; keep the top-level key as fallback.
    if (raw.servers && typeof raw.servers === "object") {
      const servers = raw.servers as Record<string, unknown>;
      for (const url of ["http://127.0.0.1:8888", "http://localhost:8888"]) {
        const token = firstUnslothToken(servers[url]);
        if (token) return token;
      }
      for (const row of Object.values(servers)) {
        const token = firstUnslothToken(row);
        if (token) return token;
      }
    }
    if (typeof raw.api_key === "string" && raw.api_key) return raw.api_key;
    return null;
  } catch {
    return null;
  }
}

/** Chat model ids from a /v1/models, /api/tags or status payload (embeddings dropped). */
export function localModelIds(payload: unknown): string[] {
  return idsFromModelsPayload(payload);
}

function idsFromModelsPayload(payload: unknown): string[] {
  const records = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : payload && typeof payload === "object" && Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : [];
  return records.flatMap((record) => {
    if (typeof record === "string") return MODEL_ID.test(record) ? [record] : [];
    if (!record || typeof record !== "object") return [];
    const id = (record as { id?: unknown; name?: unknown }).id ?? (record as { name?: unknown }).name;
    if (typeof id !== "string" || !MODEL_ID.test(id)) return [];
    const low = id.toLowerCase();
    if (low.includes("embed") || low.includes("bge-") || low.includes("nomic")) return [];
    return [id];
  });
}

export interface LocalJsonAnswer {
  ok: boolean;
  status: number;
  /** Parsed body, or null when it was not JSON. */
  json: unknown;
}

/**
 * One JSON request to a local server. `redirect: "error"` on purpose: the key
 * in the Authorization header belongs to this origin only, and a redirect is
 * the one way a server could forward it somewhere else. Null = no answer
 * (network error, timeout, refused redirect).
 */
export async function localRequestJson(
  url: string,
  env: Record<string, string | undefined>,
  host: LocalHost,
  fetchImpl: typeof fetch,
  init: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
): Promise<LocalJsonAnswer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 1200);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: init.method ?? "GET",
      signal: controller.signal,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${hostApiKey(host, env)}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, json };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function timedJson(
  url: string,
  env: Record<string, string | undefined>,
  host: LocalHost,
  fetchImpl: typeof fetch,
): Promise<unknown | null> {
  const answer = await localRequestJson(url, env, host, fetchImpl);
  return answer?.ok ? answer.json : null;
}

/** Which of this host's models are actually in memory / running. */
export function loadedIdsFromPayloads(_host: LocalHost, catalog: unknown, extra: unknown): Set<string> {
  const loaded = new Set<string>();
  const catalogIds = new Set(idsFromModelsPayload(catalog));
  const add = (id: string) => {
    const base = id.split(":")[0]!;
    if (catalogIds.size && !catalogIds.has(id) && !catalogIds.has(base)) return;
    if (!MODEL_ID.test(id)) return;
    loaded.add(id);
    if (catalogIds.has(base)) loaded.add(base);
  };

  if (extra && typeof extra === "object") {
    const rec = extra as {
      default_model?: unknown;
      models?: unknown;
      data?: unknown;
    };
    const running = Array.isArray(rec.models)
      ? rec.models
      : Array.isArray(rec.data)
        ? rec.data
        : [];
    // oMLX /v1/models/status lists every model with loaded:true/false.
    // /health only has default_model, which is the configured default — not
    // necessarily what is in memory. Prefer explicit flags when present.
    const hasLoadedFlags = running.some(
      (row) => row && typeof row === "object" && ("loaded" in row || "state" in row),
    );
    if (!hasLoadedFlags && typeof rec.default_model === "string") add(rec.default_model);
    for (const row of running) {
      if (typeof row === "string") {
        if (!hasLoadedFlags) add(row);
        continue;
      }
      if (!row || typeof row !== "object") continue;
      const item = row as { name?: unknown; model?: unknown; id?: unknown; state?: unknown; loaded?: unknown };
      const id =
        (typeof item.name === "string" && item.name) ||
        (typeof item.model === "string" && item.model) ||
        (typeof item.id === "string" && item.id) ||
        "";
      if (!id) continue;
      const state = typeof item.state === "string" ? item.state.toLowerCase() : "";
      if (item.loaded === false || state === "not-loaded" || state === "unloaded") continue;
      if (item.loaded === true || state === "loaded" || state === "idle" || !hasLoadedFlags) {
        add(id);
      }
    }
  }

  if (!loaded.size && catalog && typeof catalog === "object") {
    const rec = catalog as { default_model?: unknown; data?: unknown };
    if (typeof rec.default_model === "string") add(rec.default_model);
    const records = Array.isArray(rec.data) ? rec.data : [];
    for (const row of records) {
      if (!row || typeof row !== "object") continue;
      const item = row as { id?: unknown; state?: unknown; loaded?: unknown };
      if (typeof item.id !== "string") continue;
      const state = typeof item.state === "string" ? item.state.toLowerCase() : "";
      if (item.loaded === true || state === "loaded") add(item.id);
    }
  }

  return loaded;
}

function loadedProbeUrl(host: LocalHost): string | null {
  const origin = anthropicBaseUrl(host);
  if (host.kind === "omlx") return `${origin}/v1/models/status`;
  if (host.kind === "ollama") return `${origin}/api/ps`;
  if (host.kind === "lmstudio") return `${origin}/api/v0/models`;
  if (host.kind === "llamacpp") return `${origin}/props`;
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** llama-server's `/props` — the one endpoint oMLX and other servers do not have. */
export function isLlamaCppProps(payload: unknown): boolean {
  const rec = record(payload);
  if (!rec) return false;
  return (
    record(rec.default_generation_settings) !== null ||
    positiveInt(rec.n_ctx) !== undefined ||
    typeof rec.model_path === "string" ||
    typeof rec.build_info === "string" ||
    positiveInt(rec.total_slots) !== undefined
  );
}

/** Per-slot context llama-server was started with (`-c`, divided across `-np`). */
export function contextFromLlamaProps(payload: unknown): number | undefined {
  const rec = record(payload);
  if (!rec) return undefined;
  return positiveInt(record(rec.default_generation_settings)?.n_ctx) ?? positiveInt(rec.n_ctx);
}

function modelRows(payload: unknown): Array<Record<string, unknown>> {
  const rec = record(payload);
  const rows = Array.isArray(payload) ? payload : Array.isArray(rec?.data) ? rec.data : Array.isArray(rec?.models) ? rec.models : [];
  return rows.map(record).filter((row): row is Record<string, unknown> => row !== null);
}

function rowId(row: Record<string, unknown>): string | null {
  const id = row.id ?? row.model ?? row.name;
  return typeof id === "string" && MODEL_ID.test(id) ? id : null;
}

/** vLLM (`max_model_len`), SGLang and other servers that put the window on /v1/models rows. */
export function contextWindowsFromModelRows(payload: unknown): Map<string, LocalContextReading> {
  const out = new Map<string, LocalContextReading>();
  for (const row of modelRows(payload)) {
    const id = rowId(row);
    const window =
      positiveInt(row.max_model_len) ??
      positiveInt(row.context_length) ??
      positiveInt(row.context_window) ??
      positiveInt(row.max_context_length);
    if (id && window) out.set(id, { contextWindow: window, source: "models-endpoint" });
  }
  return out;
}

/** LM Studio `/api/v0/models`: the loaded instance's context, plus the model maximum. */
export function contextWindowsFromLmStudio(payload: unknown): Map<string, LocalContextReading> {
  const out = new Map<string, LocalContextReading>();
  for (const row of modelRows(payload)) {
    const id = rowId(row);
    if (!id) continue;
    const loaded = typeof row.state === "string" && row.state.toLowerCase() === "loaded";
    const loadedWindow = positiveInt(row.loaded_context_length);
    const max = positiveInt(row.max_context_length);
    if (!loadedWindow && !max) continue;
    out.set(id, {
      ...(loadedWindow ? { contextWindow: loadedWindow } : {}),
      ...(max ? { maxContextWindow: max } : {}),
      source: "lmstudio",
      loaded,
    });
  }
  return out;
}

/** llama-server single-model mode serves exactly its loaded model; router mode
 *  marks each row `status.value`. vLLM / SGLang serve what they loaded. */
function servedModelIds(host: LocalHost, catalog: unknown): Set<string> {
  const out = new Set<string>();
  if (host.kind !== "llamacpp" && host.kind !== "vllm" && host.kind !== "sglang") return out;
  for (const row of modelRows(catalog)) {
    const id = rowId(row);
    if (!id) continue;
    const status = record(row.status)?.value ?? row.status;
    if (typeof status === "string" && status.toLowerCase() !== "loaded") continue;
    out.add(id);
  }
  return out;
}

export interface LocalHostPage {
  /** The host these rows belong to (fingerprinted when two share an address). */
  host: LocalHost;
  /** Every host id at this address (aliases such as `local_ollama`). */
  aliases: string[];
  reachable: boolean;
  ids: string[];
  loaded: Set<string>;
  contexts: Map<string, LocalContextReading>;
}

/**
 * Probe one address. Where oMLX and llama.cpp share :8080 the answer decides
 * the label: llama-server has `/props`, oMLX has `/v1/models/status`. A server
 * that has neither but still answers on 8080 is most likely llama-server, whose
 * default port that is.
 */
async function probeHostGroup(
  group: LocalHost[],
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<LocalHostPage> {
  let host = group[0]!;
  const root = anthropicBaseUrl(host);
  const catalogUrl = `${host.baseUrl.replace(/\/$/, "")}/models`;
  const llama = group.find((row) => row.kind === "llamacpp");
  const omlx = group.find((row) => row.kind === "omlx");
  let catalog: unknown | null;
  let extra: unknown | null;
  if (llama && omlx) {
    const [listed, props, status] = await Promise.all([
      timedJson(catalogUrl, env, host, fetchImpl),
      timedJson(`${root}/props`, env, host, fetchImpl),
      timedJson(`${root}/v1/models/status`, env, host, fetchImpl),
    ]);
    catalog = listed;
    if (isLlamaCppProps(props)) [host, extra] = [llama, props];
    else if (status !== null) [host, extra] = [omlx, status];
    else [host, extra] = [llama, null];
  } else {
    const extraUrl = loadedProbeUrl(host);
    [catalog, extra] = await Promise.all([
      timedJson(catalogUrl, env, host, fetchImpl),
      extraUrl ? timedJson(extraUrl, env, host, fetchImpl) : Promise.resolve(null),
    ]);
    // Ollama older than the /v1 surface, or one with it disabled, still lists
    // its models on the native API.
    if (catalog === null && host.kind === "ollama") catalog = await timedJson(`${root}/api/tags`, env, host, fetchImpl);
  }
  const catalogIds = catalog ? idsFromModelsPayload(catalog) : [];
  const extraIds = extra && host.kind !== "llamacpp" ? idsFromModelsPayload(extra) : [];
  const loaded = host.kind === "llamacpp" || host.kind === "vllm" || host.kind === "sglang"
    ? servedModelIds(host, catalog)
    : loadedIdsFromPayloads(host, catalog ?? extra, extra);
  const ids = [...new Set([...catalogIds, ...extraIds, ...loaded])];

  const contexts = new Map<string, LocalContextReading>(contextWindowsFromModelRows(catalog));
  if (host.kind === "ollama") {
    for (const [id, window] of contextWindowsFromPs(extra)) contexts.set(id, { contextWindow: window, source: "ollama-ps", loaded: true });
  } else if (host.kind === "lmstudio") {
    for (const [id, reading] of contextWindowsFromLmStudio(extra)) contexts.set(id, reading);
  } else if (host.kind === "llamacpp") {
    const window = contextFromLlamaProps(extra);
    if (window) for (const id of loaded) contexts.set(id, { contextWindow: window, source: "llamacpp-props", loaded: true });
  }
  const aliases = group.filter((row) => row.kind === host.kind).map((row) => row.id);
  for (const [id, reading] of contexts) for (const alias of aliases) rememberLocalContext(alias, id, reading);
  return { host, aliases, reachable: catalog !== null || extra !== null, ids, loaded, contexts };
}

/** Probe a single host (a server just added or edited). */
export function probeLocalHost(
  host: LocalHost,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalHostPage> {
  return probeHostGroup([host], env, fetchImpl);
}

/** Every local address, built-in and user-added, probed in parallel. */
export async function probeLocalHosts(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalHostPage[]> {
  const groups = new Map<string, LocalHost[]>();
  for (const host of allLocalHosts()) {
    const key = host.baseUrl.replace(/\/$/, "");
    const group = groups.get(key);
    if (group) group.push(host);
    else groups.set(key, [host]);
  }
  return Promise.all([...groups.values()].map((group) => probeHostGroup(group, env, fetchImpl)));
}

/** Live models from the same local hosts the sidecar probed. */
export async function probeLocalInjects(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<InjectedModel[]> {
  const found: InjectedModel[] = [];
  for (const { host, ids, loaded, contexts } of await probeLocalHosts(env, fetchImpl)) {
    for (const model of ids) {
      const contextWindow = contexts.get(model)?.contextWindow;
      found.push({
        id: encodeInjectId(host.id, model),
        host: host.id,
        model,
        label: `${model} (${host.label})`,
        loaded: loaded.has(model),
        ...(contextWindow ? { contextWindow } : {}),
      });
    }
  }
  return found;
}

/** Host ids whose tool tests count for this host: an added server is itself;
 *  a built-in address counts its aliases (ollama / local_ollama). */
function testHostIds(host: LocalHost): string[] {
  if (host.source === "added") return [host.id];
  return LOCAL_HOSTS.filter((row) => row.baseUrl === host.baseUrl).map((row) => row.id);
}

/** The last Local models test for this pick, if it still matches the address. */
export function cachedLocalTestFor(hostId: string, model: string) {
  const host = localHost(hostId);
  if (!host) return undefined;
  for (const id of testHostIds(host)) {
    const test = cachedLocalToolTest(id, host.baseUrl, model);
    if (test) return test;
  }
  return undefined;
}

/** Append live local models as custom rows. Official rows stay first. */
export async function mergeLocalInject(
  catalog: ModelCatalog,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  mergeOptions: { driver?: string } = {},
): Promise<ModelCatalog> {
  const vitest = env.VITEST ?? process.env.VITEST;
  const probe = env.MURAGE_PROBE_LOCAL_INJECT ?? process.env.MURAGE_PROBE_LOCAL_INJECT;
  if (vitest === "true" && probe !== "1") return catalog;
  let extras = await probeLocalInjects(env, fetchImpl);
  // No dead ends (spec E3): Codex needs a working /v1/responses and Claude
  // Code a working /v1/messages. Only a model whose Local models test passed
  // that surface is offered to them; chat engines see every live model.
  const surface = mergeOptions.driver ? LOCAL_ENGINE_SURFACE[mergeOptions.driver] : undefined;
  if (surface && surface !== "chat") {
    extras = extras.filter((extra) => cachedLocalTestFor(extra.host, extra.model)?.surfaces[surface] === true);
  }
  if (!extras.length) return catalog;
  const liveApiIds = new Set(extras.map((extra) => extra.model));
  // A settings leftover that is just the API id of a live inject is not a
  // second model — Custom should only offer the host:: row.
  const options = catalog.options
    .filter((option) => decodeInjectId(option.id) || !option.custom || !liveApiIds.has(option.id))
    .map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    const existing = options.find((option) => option.id === extra.id);
    if (existing) {
      if (extra.loaded) existing.loaded = true;
      if (extra.contextWindow) existing.contextWindow = extra.contextWindow;
      continue;
    }
    seen.add(extra.id);
    options.push({
      id: extra.id,
      label: extra.label,
      custom: true,
      ...(extra.loaded ? { loaded: true } : {}),
      ...(extra.contextWindow ? { contextWindow: extra.contextWindow } : {}),
    });
  }
  return { default: catalog.default, options };
}

/** Point an OpenAI-compatible CLI at the injected host. */
export function applyOpenAIInject(
  env: Record<string, string | undefined>,
  modelId: string | null | undefined,
): { model: string | null; injected: boolean } {
  const inject = decodeInjectId(modelId);
  if (!inject) return { model: modelId ?? null, injected: false };
  const host = localHost(inject.host);
  if (!host) return { model: modelId ?? null, injected: false };
  const key = hostApiKey(host, env);
  env.OPENAI_BASE_URL = host.baseUrl;
  env.OPENAI_API_KEY = key;
  return { model: inject.model, injected: true };
}

/** Point Claude Code at the injected host instead of Anthropic cloud. */
export function applyClaudeInject(
  env: Record<string, string | undefined>,
  modelId: string | null | undefined,
): { model: string | null; injected: boolean } {
  const inject = decodeInjectId(modelId);
  if (!inject) return { model: modelId ?? null, injected: false };
  const host = localHost(inject.host);
  if (!host) return { model: modelId ?? null, injected: false };
  const key = hostApiKey(host, env);
  env.ANTHROPIC_BASE_URL = anthropicBaseUrl(host);
  env.ANTHROPIC_AUTH_TOKEN = key;
  env.ANTHROPIC_API_KEY = key;
  env.ANTHROPIC_MODEL = inject.model;
  // Local Messages gateways (serving research §3): beta tool fields such as
  // `strict` / `defer_loading` get a 400 unless the gateway forwards them, and
  // a per-request attribution header invalidates the server's KV cache.
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  return { model: inject.model, injected: true };
}
