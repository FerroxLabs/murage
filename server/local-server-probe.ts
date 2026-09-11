// Address-level facts about one local server (0.1.52 LM1): what software it
// is (spec A1 auto-detect), how much context a model really gets (spec T2),
// and the Ollama "create a 64k copy" helper (spec T3).
//
// Every request uses `localRequestJson`, which refuses redirects so a key is
// only ever presented to the server's own origin.
import {
  AGENT_RECOMMENDED_CONTEXT_TOKENS,
  isValidLocalModelId,
  type LocalContextReading,
  type LocalServerKind,
  type OllamaContextCopyResult,
} from "../shared/local-models.ts";
import {
  anthropicBaseUrl,
  contextFromLlamaProps,
  contextWindowsFromLmStudio,
  contextWindowsFromModelRows,
  contextWindowsFromPs,
  decodeInjectId,
  isLlamaCppProps,
  localContextWindow,
  localHost,
  localModelIds,
  localRequestJson,
  rememberLocalContext,
  type LocalHost,
} from "./drivers/local-inject.ts";

type Env = Record<string, string | undefined>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** A throwaway host for an address that is not stored yet. */
export function probeHost(apiBase: string, apiKey: string | undefined, kind: LocalServerKind = "openai"): LocalHost {
  return { id: "probe", label: "Local server", kind, baseUrl: apiBase, apiKey: apiKey ?? "local" };
}

export interface LocalServerDetection {
  reachable: boolean;
  /** null = nothing answered. */
  kind: LocalServerKind | null;
  models: string[];
}

/**
 * What answers at this address. Order matters: each endpoint below is unique
 * to one server (Ollama `/api/version`, LM Studio `/api/v0/models`, llama.cpp
 * `/props`, SGLang `/get_model_info`, oMLX `/v1/models/status`); vLLM and
 * SGLang also mark their `/v1/models` rows with `owned_by`.
 */
export async function detectLocalServerKind(
  host: LocalHost,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalServerDetection> {
  const root = anthropicBaseUrl(host);
  const base = host.baseUrl.replace(/\/$/, "");
  const get = (url: string) => localRequestJson(url, env, host, fetchImpl, { timeoutMs: 2_500 });
  const [version, lmStudio, props, sglangInfo, models, omlxStatus, health] = await Promise.all([
    get(`${root}/api/version`),
    get(`${root}/api/v0/models`),
    get(`${root}/props`),
    get(`${root}/get_model_info`),
    get(`${base}/models`),
    get(`${root}/v1/models/status`),
    get(`${root}/health`),
  ]);
  const listed = models?.ok ? localModelIds(models.json) : [];
  const ownedBy = (name: string) =>
    Array.isArray(record(models?.json)?.data) &&
    (record(models?.json)!.data as unknown[]).some((row) => record(row)?.owned_by === name);
  const kind: LocalServerKind | null =
    version?.ok && typeof record(version.json)?.version === "string"
      ? "ollama"
      : lmStudio?.ok && Array.isArray(record(lmStudio.json)?.data)
        ? "lmstudio"
        : props?.ok && isLlamaCppProps(props.json)
          ? "llamacpp"
          : (sglangInfo?.ok && typeof record(sglangInfo.json)?.model_path === "string") || (models?.ok && ownedBy("sglang"))
            ? "sglang"
            : models?.ok && ownedBy("vllm")
              ? "vllm"
              : omlxStatus?.ok
                ? "omlx"
                : models?.ok || health?.ok
                  ? "openai"
                  : null;
  let names = listed;
  if (kind === "ollama" && !names.length) {
    const tags = await get(`${root}/api/tags`);
    names = tags?.ok ? localModelIds(tags.json) : [];
  }
  const reachable = [version, lmStudio, props, sglangInfo, models, omlxStatus, health].some((answer) => answer !== null);
  return { reachable, kind, models: names };
}

function ollamaNumCtx(parameters: unknown): number | undefined {
  if (typeof parameters !== "string") return undefined;
  const match = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(parameters);
  return match ? positiveInt(Number(match[1])) : undefined;
}

function ollamaMaxContext(modelInfo: unknown): number | undefined {
  const info = record(modelInfo);
  if (!info) return undefined;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(".context_length")) return positiveInt(value);
  }
  return undefined;
}

/**
 * The context this model will actually run with, read from the server that
 * serves it (spec T2). Unknown stays unknown: a guess is what made Pi and Kimi
 * believe they had 131k/262k on a 4k Ollama.
 */
export async function readLoadedContext(
  host: LocalHost,
  model: string,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalContextReading> {
  const root = anthropicBaseUrl(host);
  const base = host.baseUrl.replace(/\/$/, "");
  const get = (url: string) => localRequestJson(url, env, host, fetchImpl, { timeoutMs: 5_000 });
  let reading: LocalContextReading = { source: "unknown" };
  switch (host.kind) {
    case "ollama": {
      const ps = await get(`${root}/api/ps`);
      const windows = ps?.ok ? contextWindowsFromPs(ps.json) : new Map<string, number>();
      const running = windows.get(model) ?? windows.get(model.split(":")[0]!);
      if (running) {
        reading = { contextWindow: running, source: "ollama-ps", loaded: true };
        break;
      }
      // Not loaded: the model's own `num_ctx` parameter is what it will get;
      // without one Ollama's server default applies, which this API cannot
      // report (it depends on VRAM and OLLAMA_CONTEXT_LENGTH).
      const show = await localRequestJson(`${root}/api/show`, env, host, fetchImpl, { method: "POST", body: { model }, timeoutMs: 5_000 });
      const shown = show?.ok ? record(show.json) : null;
      const configured = ollamaNumCtx(shown?.parameters);
      const max = ollamaMaxContext(shown?.model_info);
      reading = {
        ...(configured ? { contextWindow: configured } : {}),
        ...(max ? { maxContextWindow: max } : {}),
        source: "ollama-show",
        loaded: false,
      };
      break;
    }
    case "lmstudio": {
      const answer = await get(`${root}/api/v0/models`);
      reading = (answer?.ok ? contextWindowsFromLmStudio(answer.json).get(model) : undefined) ?? { source: "unknown" };
      break;
    }
    case "llamacpp": {
      const answer = await get(`${root}/props`);
      const window = answer?.ok ? contextFromLlamaProps(answer.json) : undefined;
      reading = window ? { contextWindow: window, source: "llamacpp-props", loaded: true } : { source: "unknown" };
      break;
    }
    default: {
      const answer = await get(`${base}/models`);
      const fromRows = answer?.ok ? contextWindowsFromModelRows(answer.json).get(model) : undefined;
      if (fromRows) {
        reading = fromRows;
        break;
      }
      if (host.kind === "sglang") {
        const info = await get(`${root}/get_server_info`);
        const window = info?.ok ? positiveInt(record(info.json)?.context_length) : undefined;
        if (window) reading = { contextWindow: window, source: "sglang-server-info", loaded: true };
      }
    }
  }
  if (reading.contextWindow || reading.maxContextWindow) rememberLocalContext(host.id, model, reading);
  return reading;
}

/**
 * Before an engine writer sizes a local model, make sure Murage has read its
 * real window at least once this session. Best effort and bounded by the
 * reader's short timeouts; a failure leaves the writer's fallback in place.
 * Vitest skips it unless a test opts in, like the catalog probe.
 */
export async function primeLocalContext(
  modelId: string | null | undefined,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const inject = decodeInjectId(modelId);
  if (!inject) return;
  const vitest = env.VITEST ?? process.env.VITEST;
  const probe = env.MURAGE_PROBE_LOCAL_INJECT ?? process.env.MURAGE_PROBE_LOCAL_INJECT;
  if (vitest === "true" && probe !== "1") return;
  if (localContextWindow(inject.host, inject.model)) return;
  const host = localHost(inject.host);
  if (!host) return;
  try {
    await readLoadedContext(host, inject.model, env, fetchImpl);
  } catch {
    // The writer falls back to its default window.
  }
}

// ── Ollama "create a 64k copy" (spec T3) ──────────────────────────────────

/** `qwen3:8b` → `qwen3:8b-64k`; `llama3.2` / `llama3.2:latest` → `llama3.2:64k`. */
export function ollamaContextCopyName(model: string, numCtx: number): string {
  const suffix = `${Math.round(numCtx / 1024)}k`;
  const slash = model.lastIndexOf("/");
  const colon = model.lastIndexOf(":");
  const tagAt = colon > slash ? colon : -1;
  const name = tagAt >= 0 ? model.slice(0, tagAt) : model;
  const tag = tagAt >= 0 ? model.slice(tagAt + 1) : "latest";
  return tag === "latest" ? `${name}:${suffix}` : `${name}:${tag}-${suffix}`;
}

/** First Ollama release whose /api/create takes `from` + `parameters`
 *  instead of a Modelfile string. Verification below is the real authority:
 *  a create that does not produce the parameter falls back to instructions. */
const OLLAMA_CREATE_FROM_MIN: readonly [number, number, number] = [0, 5, 5];

function versionAtLeast(version: string, min: readonly [number, number, number]): boolean {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!parts) return false;
  const actual = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  for (let i = 0; i < 3; i++) {
    if (actual[i]! > min[i]!) return true;
    if (actual[i]! < min[i]!) return false;
  }
  return true;
}

export const OLLAMA_CONTEXT_MIN = 8_192;
export const OLLAMA_CONTEXT_MAX = 262_144;

export function isValidOllamaContextRequest(model: unknown, numCtx: unknown): boolean {
  return (
    isValidLocalModelId(model) &&
    (numCtx === undefined ||
      (typeof numCtx === "number" && Number.isInteger(numCtx) && numCtx >= OLLAMA_CONTEXT_MIN && numCtx <= OLLAMA_CONTEXT_MAX))
  );
}

/**
 * Ollama's OpenAI surface cannot raise num_ctx per request, so offer a copy
 * of the model with the context baked in: POST /api/create {model, from,
 * parameters:{num_ctx}}, then read it back with /api/show. Anything short of a
 * verified copy returns the exact Modelfile, command and env var instead.
 */
export async function createOllamaContextCopy(
  host: LocalHost,
  model: string,
  numCtx: number = AGENT_RECOMMENDED_CONTEXT_TOKENS,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<OllamaContextCopyResult> {
  const root = anthropicBaseUrl(host);
  const copy = ollamaContextCopyName(model, numCtx);
  const instructions = (reason: "old-version" | "create-failed" | "not-verified" | "unreachable", ollamaVersion?: string): OllamaContextCopyResult => ({
    status: "instructions",
    reason,
    model: copy,
    numCtx,
    modelfile: `FROM ${model}\nPARAMETER num_ctx ${numCtx}\n`,
    command: `ollama create ${copy} -f Modelfile`,
    environment: `OLLAMA_CONTEXT_LENGTH=${numCtx}`,
    ...(ollamaVersion ? { ollamaVersion } : {}),
  });

  const versionAnswer = await localRequestJson(`${root}/api/version`, env, host, fetchImpl, { timeoutMs: 5_000 });
  const version = versionAnswer?.ok ? record(versionAnswer.json)?.version : undefined;
  if (typeof version !== "string") return instructions("unreachable");
  if (!versionAtLeast(version, OLLAMA_CREATE_FROM_MIN)) return instructions("old-version", version);

  const created = await localRequestJson(`${root}/api/create`, env, host, fetchImpl, {
    method: "POST",
    body: { model: copy, from: model, parameters: { num_ctx: numCtx }, stream: false },
    timeoutMs: 120_000,
  });
  const createdStatus = record(created?.json)?.status;
  if (!created?.ok || record(created.json)?.error || (createdStatus !== undefined && createdStatus !== "success")) {
    return instructions("create-failed", version);
  }
  const shown = await localRequestJson(`${root}/api/show`, env, host, fetchImpl, { method: "POST", body: { model: copy }, timeoutMs: 10_000 });
  if (!shown?.ok || ollamaNumCtx(record(shown.json)?.parameters) !== numCtx) return instructions("not-verified", version);
  rememberLocalContext(host.id, copy, { contextWindow: numCtx, source: "ollama-show", loaded: false });
  return { status: "created", model: copy, numCtx, verified: true };
}
