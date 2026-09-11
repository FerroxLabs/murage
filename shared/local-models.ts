// Local models (0.1.52 LM1): the typed contract between the server that
// detects, stores and tests local model servers and the renderer (LM2) that
// shows them under Settings → Models → Local models and in the picker.
//
// Everything here is plain data plus pure functions, so the renderer can run
// the same address validation and preflight arithmetic the server enforces.
// The server stays the authority: every address is re-validated when it is
// read back from disk, before any engine config is written from it.

/** Which server software answers at an address. `openai` = some other
 *  OpenAI-compatible server Murage could not identify more precisely. */
export type LocalServerKind =
  | "ollama"
  | "lmstudio"
  | "llamacpp"
  | "vllm"
  | "sglang"
  | "omlx"
  | "exo"
  | "unsloth"
  | "openai";

export const LOCAL_SERVER_KINDS: readonly LocalServerKind[] = [
  "ollama",
  "lmstudio",
  "llamacpp",
  "vllm",
  "sglang",
  "omlx",
  "exo",
  "unsloth",
  "openai",
];

/** User-facing names. `openai` deliberately has no protocol jargon in it. */
export const LOCAL_SERVER_KIND_LABELS: Record<LocalServerKind, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  vllm: "vLLM",
  sglang: "SGLang",
  omlx: "oMLX",
  exo: "EXO",
  unsloth: "Unsloth",
  openai: "Local server",
};

export function isLocalServerKind(value: unknown): value is LocalServerKind {
  return typeof value === "string" && (LOCAL_SERVER_KINDS as readonly string[]).includes(value);
}

/** "llama.cpp on seanbeast" — the name a picker row and a card use. */
export function localServerDisplayLabel(kind: LocalServerKind, name: string): string {
  const trimmed = name.trim();
  if (kind === "openai") return trimmed || LOCAL_SERVER_KIND_LABELS.openai;
  return trimmed ? `${LOCAL_SERVER_KIND_LABELS[kind]} on ${trimmed}` : LOCAL_SERVER_KIND_LABELS[kind];
}

/** Where Murage looks on its own. The empty state lists exactly these, so
 *  "nothing answered" always says where Murage looked (spec V1). */
export interface LocalDetectionTarget {
  kind: LocalServerKind;
  /** host:port only — rendered as-is. */
  address: string;
}

export const LOCAL_DETECTION_TARGETS: readonly LocalDetectionTarget[] = [
  { kind: "ollama", address: "127.0.0.1:11434" },
  { kind: "lmstudio", address: "127.0.0.1:1234" },
  { kind: "llamacpp", address: "127.0.0.1:8080" },
  { kind: "vllm", address: "127.0.0.1:8000" },
  { kind: "sglang", address: "127.0.0.1:30000" },
  { kind: "exo", address: "127.0.0.1:52415" },
  { kind: "unsloth", address: "127.0.0.1:8888" },
];

// ── address validation (spec A1) ──────────────────────────────────────────

/** loopback / RFC1918 / tailnet (100.64.0.0/10) may use plain http; every
 *  other address must be https. A hostname other than `localhost` is
 *  `public`: without resolving it Murage cannot know where it points. */
export type LocalAddressClass = "loopback" | "private" | "tailnet" | "public";

function ipv4Octets(hostname: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return null;
  const octets = match.slice(1).map(Number) as [number, number, number, number];
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

export function classifyLocalHostname(hostname: string): LocalAddressClass {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host === "::1") return "loopback";
  const v4 = ipv4Octets(host);
  if (!v4) return "public";
  const [a, b] = v4;
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "tailnet";
  return "public";
}

export type LocalModelsErrorCode =
  | "invalid-address"
  | "https-required"
  | "credentials-in-address"
  | "unsupported-scheme"
  | "invalid-name"
  | "invalid-key"
  | "invalid-kind"
  | "invalid-model"
  | "invalid-request"
  | "duplicate-server"
  | "server-not-found"
  | "server-limit"
  | "not-ollama"
  | "busy"
  | "store-unavailable";

export const LOCAL_MODELS_ERROR_STATUS: Record<LocalModelsErrorCode, number> = {
  "invalid-address": 400,
  "https-required": 400,
  "credentials-in-address": 400,
  "unsupported-scheme": 400,
  "invalid-name": 400,
  "invalid-key": 400,
  "invalid-kind": 400,
  "invalid-model": 400,
  "invalid-request": 400,
  "duplicate-server": 409,
  "server-not-found": 404,
  "server-limit": 409,
  "not-ollama": 409,
  busy: 409,
  "store-unavailable": 503,
};

export interface NormalizedLocalAddress {
  ok: true;
  /** OpenAI-style base every engine writer uses, always ending in `/v1`. */
  apiBase: string;
  /** apiBase without `/v1`: native endpoints (`/props`, `/api/ps`, `/health`)
   *  and the Anthropic-style base Claude Code wants hang off this. */
  root: string;
  origin: string;
  addressClass: LocalAddressClass;
}

/**
 * Normalize what a user typed ("192.168.1.20:8080", "http://127.0.0.1:18080/v1",
 * "https://gpu.example.com/proxy") into one canonical `…/v1` base, or say why not.
 * A missing scheme means http, which is then held to the same address rule.
 */
export function normalizeLocalServerAddress(
  raw: unknown,
): NormalizedLocalAddress | { ok: false; code: LocalModelsErrorCode } {
  if (typeof raw !== "string") return { ok: false, code: "invalid-address" };
  const typed = raw.trim();
  if (!typed || typed.length > 2048 || /\s/.test(typed)) return { ok: false, code: "invalid-address" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `http://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, code: "invalid-address" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, code: "unsupported-scheme" };
  if (url.username || url.password) return { ok: false, code: "credentials-in-address" };
  if (url.search || url.hash || !url.hostname) return { ok: false, code: "invalid-address" };
  const addressClass = classifyLocalHostname(url.hostname);
  if (url.protocol === "http:" && addressClass === "public") return { ok: false, code: "https-required" };
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/v1$/i, "");
  if (path && !/^(\/[A-Za-z0-9._~-]+)+$/.test(path)) return { ok: false, code: "invalid-address" };
  if (path.split("/").some((part) => part === "." || part === "..")) return { ok: false, code: "invalid-address" };
  const root = `${url.origin}${path}`;
  return { ok: true, apiBase: `${root}/v1`, root, origin: url.origin, addressClass };
}

export const LOCAL_SERVER_NAME_MAX = 60;
export const LOCAL_SERVER_KEY_MAX = 512;
export const LOCAL_SERVERS_MAX = 32;
/** Same shape `decodeInjectId` accepts for the model half of `host::model`. */
export const LOCAL_MODEL_ID = /^[\w][\w./:+-]*$/;

export function isValidLocalServerName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= LOCAL_SERVER_NAME_MAX &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** Printable ASCII, no whitespace: it lands in TOML/YAML/JSON configs and env. */
export function isValidLocalServerKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= LOCAL_SERVER_KEY_MAX && /^[\x21-\x7e]+$/.test(value);
}

export function isValidLocalModelId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && LOCAL_MODEL_ID.test(value);
}

/** Id of a user-added server. Prefixed so it can never collide with a built-in
 *  host id, and restricted so it is safe as a TOML key, YAML key and env name. */
export const USER_LOCAL_SERVER_ID = /^srv_[a-z0-9]{8,24}$/;

/**
 * llama-server names the model it loaded by the path it was handed. On Windows
 * that is `D:\Qwen\models\Qwen3.8-27B-UD-Q4_K_M.gguf`, which is not a usable
 * model id: the backslashes fail `LOCAL_MODEL_ID`, so `host::model` never
 * decodes and the server ends up listed with zero models — detected but
 * unusable. (Observed live on llama.cpp b1-192067b, 2026-09-11.)
 *
 * A single-model llama-server ignores the `model` field of a request: the same
 * build answered a request naming `totally-made-up` from the loaded model. The
 * file's own name therefore addresses exactly the same model and is safe in a
 * picker id, a TOML key and an engine argv. Returns undefined when nothing
 * usable is left, so the caller keeps the honest "no models" state rather than
 * inventing one.
 */
export function llamaCppModelId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const base = raw.trim().split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/\.gguf$/i, "")
    .replace(/[^\w./:+-]+/g, "-")
    .replace(/^[^\w]+/, "");
  return isValidLocalModelId(cleaned) && cleaned.length > 0 ? cleaned : undefined;
}

// ── context (spec T2/T3) ──────────────────────────────────────────────────

/** Below this, agent system prompts plus tool schemas do not fit. */
export const AGENT_MIN_CONTEXT_TOKENS = 32_768;
/** What the Ollama helper creates and what the docs recommend. */
export const AGENT_RECOMMENDED_CONTEXT_TOKENS = 65_536;
/** Warn when the prompt Murage sends takes more than this share of the window. */
export const CONTEXT_PREFLIGHT_RATIO = 0.7;

export type LocalContextSource =
  | "llamacpp-props"
  | "ollama-ps"
  | "ollama-show"
  | "lmstudio"
  | "models-endpoint"
  | "sglang-server-info"
  | "unknown";

export interface LocalContextReading {
  /** The context the server will actually give this model (loaded / configured). */
  contextWindow?: number;
  /** The model's own maximum, when the server reports it separately. */
  maxContextWindow?: number;
  source: LocalContextSource;
  /** The model is in memory right now. */
  loaded?: boolean;
}

/**
 * Rough prompt size an engine puts in front of every local turn: its own
 * system prompt plus Murage's MCP tool schemas (agents, memory, computer,
 * connected apps). Conservative estimates, not measurements of a particular
 * install — the 41-tool probe alone measured 7,780 prompt tokens on llama.cpp,
 * and Claude Code sends every tool schema up front (often 25k–40k tokens).
 * A caller that knows the real size passes it to `contextPreflight` instead.
 */
export const ENGINE_PROMPT_TOKEN_ESTIMATE: Record<string, number> = {
  claudeAgent: 30_000,
  codex: 20_000,
  fuigoAgent: 16_000,
  piAgent: 12_000,
  opencodeGo: 16_000,
  qwenAgent: 16_000,
  hermesAgent: 16_000,
  droidAgent: 16_000,
  kimiAgent: 16_000,
  grokAgent: 16_000,
};
export const DEFAULT_PROMPT_TOKEN_ESTIMATE = 16_000;

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export type LocalContextPreflightStatus = "ok" | "tight" | "too-small" | "unknown";

export interface LocalContextPreflight {
  status: LocalContextPreflightStatus;
  contextWindow?: number;
  promptTokens: number;
  /** promptTokens / contextWindow, when the window is known. */
  ratio?: number;
  minimum: number;
}

/**
 * "Will this fit?" before dispatch. `too-small`: the window is under the agent
 * minimum or the prompt alone would fill it. `tight`: the prompt takes more
 * than 70% of the window, leaving little room for the conversation.
 */
export function contextPreflight(input: { contextWindow?: number; promptTokens: number }): LocalContextPreflight {
  const promptTokens = Math.max(0, Math.round(input.promptTokens));
  const window = input.contextWindow;
  if (!window || !Number.isFinite(window) || window <= 0) {
    return { status: "unknown", promptTokens, minimum: AGENT_MIN_CONTEXT_TOKENS };
  }
  const ratio = promptTokens / window;
  const status: LocalContextPreflightStatus =
    window < AGENT_MIN_CONTEXT_TOKENS || ratio >= 1 ? "too-small" : ratio > CONTEXT_PREFLIGHT_RATIO ? "tight" : "ok";
  return { status, contextWindow: window, promptTokens, ratio, minimum: AGENT_MIN_CONTEXT_TOKENS };
}

// ── tool-calling test (spec T1) ───────────────────────────────────────────

/** The seven checks of the SeanBeast probe (0152-LOCAL-MODELS-PROBE-SEANBEAST.md). */
export const LOCAL_TOOL_CHECKS = [
  "chat.auto",
  "chat.required",
  "chat.stream",
  "chat.roundtrip",
  "chat.manyTools",
  "messages.toolUse",
  "responses.functionCall",
] as const;
export type LocalToolCheckName = (typeof LOCAL_TOOL_CHECKS)[number];

export type LocalToolCheckStatus = "pass" | "fail" | "skipped";

/** Why a check came out the way it did, as a code — never raw server text. */
export type LocalToolCheckDetail =
  | "ok"
  | "text-instead-of-tool"
  | "wrong-tool-call"
  | "bad-arguments"
  | "tools-rejected"
  | "context-exceeded"
  | "model-not-found"
  | "no-endpoint"
  | "http-error"
  | "network"
  | "timeout"
  | "redirect-refused"
  | "no-first-call";

export interface LocalToolCheck {
  name: LocalToolCheckName;
  status: LocalToolCheckStatus;
  detail: LocalToolCheckDetail;
  httpStatus?: number;
  ms?: number;
  /** `arguments` came back as a JSON object instead of a string (llama.cpp #20198). */
  argumentsType?: "string" | "object";
  /** usage.prompt_tokens, reported for the 41-tool check. */
  promptTokens?: number;
}

/** One plain-language outcome per test (spec T1). */
export type LocalToolTestOutcome =
  /** "Tools work — ready for agents" */
  | "tools-work"
  /** Tool calls work, but some of streaming / round trip / many tools failed. */
  | "tools-partial"
  /** "This model answers but can't use tools (came back as text)" */
  | "text-instead-of-tools"
  /** "Context too small for agents (loaded 4k; agents need 32k+)" */
  | "context-too-small"
  /** "Server rejects tools — enable them: <exact flag>" */
  | "server-rejects-tools"
  | "model-not-found"
  | "unreachable";

export interface LocalToolFix {
  kind: "server-flag" | "raise-context" | "ollama-context-copy" | "pick-tool-model";
  /** The exact flag or setting, e.g. "--jinja" or
   *  "--enable-auto-tool-choice --tool-call-parser <parser>". */
  value?: string;
}

export interface LocalToolSurfaces {
  /** OpenAI chat completions with tool calls (Fuigo, Pi, OpenCode, Qwen, Hermes, Droid, Kimi). */
  chat: boolean;
  /** OpenAI Responses function calls — Codex needs this. */
  responses: boolean;
  /** Anthropic Messages tool_use — Claude Code needs this. */
  messages: boolean;
}

export interface LocalToolTestResult {
  serverId: string;
  /** The `…/v1` base the test ran against; a changed address invalidates it. */
  apiBase: string;
  model: string;
  outcome: LocalToolTestOutcome;
  checks: LocalToolCheck[];
  surfaces: LocalToolSurfaces;
  context?: LocalContextReading;
  fix?: LocalToolFix;
  testedAt: number;
  durationMs: number;
}

export function isLocalToolTestResult(value: unknown): value is LocalToolTestResult {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<LocalToolTestResult>;
  return (
    typeof row.serverId === "string" &&
    typeof row.apiBase === "string" &&
    typeof row.model === "string" &&
    typeof row.outcome === "string" &&
    Array.isArray(row.checks) &&
    !!row.surfaces &&
    typeof row.surfaces.chat === "boolean" &&
    typeof row.surfaces.responses === "boolean" &&
    typeof row.surfaces.messages === "boolean" &&
    typeof row.testedAt === "number"
  );
}

// ── engines (spec E1–E4, V4) ──────────────────────────────────────────────

/** Which API surface an engine needs from a local server. */
export type LocalEngineSurface = keyof LocalToolSurfaces;

/** Engines that run tools themselves against a local server. Absent engines
 *  (Antigravity, Cursor, Gemini, customAcp, openai-compat, grok API) are not
 *  offered local server rows at all — no dead ends (spec UX rule). */
export const LOCAL_ENGINE_SURFACE: Record<string, LocalEngineSurface> = {
  fuigoAgent: "chat",
  piAgent: "chat",
  opencodeGo: "chat",
  qwenAgent: "chat",
  hermesAgent: "chat",
  droidAgent: "chat",
  kimiAgent: "chat",
  grokAgent: "chat",
  codex: "responses",
  claudeAgent: "messages",
};

/** Each engine under the name the rest of the app already shows for it, so a
 *  card can say "Fuigo, pi, OpenCode" without waiting for the instance list. */
export const LOCAL_ENGINE_LABELS: Record<string, string> = {
  fuigoAgent: "Fuigo",
  piAgent: "pi",
  opencodeGo: "OpenCode",
  qwenAgent: "Qwen",
  hermesAgent: "Hermes",
  droidAgent: "Droid",
  kimiAgent: "Kimi",
  grokAgent: "Grok",
  codex: "Codex",
  claudeAgent: "Claude",
};

export function localEngineLabel(driver: string): string {
  return LOCAL_ENGINE_LABELS[driver] ?? driver;
}

export type LocalEngineSupport =
  /** Runs tools on local models (with a matching surface). */
  | "tools"
  /** Can talk to a local server but only chats: no tools, no agents. */
  | "chat-only"
  /** Cannot use a local server. */
  | "none";

/** Chat-only drivers: they reach a server but never send tools (spec E4). */
export const CHAT_ONLY_DRIVERS: readonly string[] = ["openai-compat", "grok"];

export function localEngineSupport(driver: string): LocalEngineSupport {
  if (LOCAL_ENGINE_SURFACE[driver]) return "tools";
  if (CHAT_ONLY_DRIVERS.includes(driver)) return "chat-only";
  return "none";
}

/**
 * The engines that can use one server+model, given its last test (or none).
 * Chat engines are listed unless the server could not be reached; Codex only
 * after /v1/responses passed and Claude Code only after /v1/messages passed
 * (spec E3) — an untested model is not offered to them.
 */
export function localEnginesFor(test: LocalToolTestResult | undefined): string[] {
  return Object.entries(LOCAL_ENGINE_SURFACE)
    .filter(([, surface]) => {
      if (surface === "chat") return test?.outcome !== "unreachable";
      return test?.surfaces[surface] === true;
    })
    .map(([driver]) => driver);
}

// ── HTTP contract ─────────────────────────────────────────────────────────

export const LOCAL_MODELS_ROUTE_PREFIX = "/api/local-models";

export const LOCAL_MODELS_ROUTES = {
  /** GET: detect + list every server (always answers, even when nothing runs). */
  list: LOCAL_MODELS_ROUTE_PREFIX,
  /** POST AddLocalServerRequest */
  servers: `${LOCAL_MODELS_ROUTE_PREFIX}/servers`,
  /** PATCH UpdateLocalServerRequest / DELETE */
  server: (id: string) => `${LOCAL_MODELS_ROUTE_PREFIX}/servers/${encodeURIComponent(id)}`,
  /** POST LocalToolTestRequest → LocalToolTestResult */
  test: (id: string) => `${LOCAL_MODELS_ROUTE_PREFIX}/servers/${encodeURIComponent(id)}/test`,
  /** POST OllamaContextCopyRequest → OllamaContextCopyResult */
  ollamaContextCopy: (id: string) => `${LOCAL_MODELS_ROUTE_PREFIX}/servers/${encodeURIComponent(id)}/ollama-context-copy`,
  /** GET ?model=<host::model>&engine=<driver>[&promptTokens=n] → LocalContextPreflight */
  preflight: `${LOCAL_MODELS_ROUTE_PREFIX}/preflight`,
} as const;

export interface AddLocalServerRequest {
  address: string;
  /** Omit or "auto" to detect via /api/version, /props, /health, /v1/models. */
  kind?: LocalServerKind | "auto";
  apiKey?: string;
  name?: string;
}

export interface UpdateLocalServerRequest {
  name?: string;
  kind?: LocalServerKind;
  address?: string;
  /** A new key; `null` or "" removes the stored key. */
  apiKey?: string | null;
}

export interface LocalToolTestRequest {
  model: string;
}

export interface LocalToolTestResponse {
  test: LocalToolTestResult;
  /** Engines that can use this model after the test (see localEnginesFor). */
  engines: string[];
}

export interface OllamaContextCopyRequest {
  model: string;
  /** Defaults to AGENT_RECOMMENDED_CONTEXT_TOKENS. */
  numCtx?: number;
}

export type OllamaContextCopyResult =
  | { status: "created"; model: string; numCtx: number; verified: true }
  | {
      status: "instructions";
      reason: "old-version" | "create-failed" | "not-verified" | "unreachable";
      model: string;
      numCtx: number;
      /** Modelfile contents for `ollama create <model> -f Modelfile`. */
      modelfile: string;
      command: string;
      /** Server-wide alternative: `OLLAMA_CONTEXT_LENGTH=<n>` before starting Ollama. */
      environment: string;
      ollamaVersion?: string;
    };

export type LocalServerSource = "detected" | "added";
export type LocalServerStatus = "running" | "not-answering";

export interface LocalModelView {
  /** Picker id (`host::model`). */
  id: string;
  model: string;
  loaded: boolean;
  context?: LocalContextReading;
  test?: LocalToolTestResult;
  /** Engines that can use this model right now (see localEnginesFor). */
  engines: string[];
}

export interface LocalServerView {
  id: string;
  name: string;
  /** "llama.cpp on seanbeast" */
  label: string;
  kind: LocalServerKind;
  /** The `…/v1` base. */
  address: string;
  source: LocalServerSource;
  /** Only user-added servers can be edited or removed. */
  editable: boolean;
  hasKey: boolean;
  status: LocalServerStatus;
  checkedAt: number;
  models: LocalModelView[];
}

export interface LocalModelsListResponse {
  servers: LocalServerView[];
  /** Where automatic detection looked (V1 empty state). */
  looked: readonly LocalDetectionTarget[];
  checkedAt: number;
}

export interface LocalServerCleanupReport {
  engine: string;
  status: "removed" | "absent" | "refused";
  /** Short, secret-free message when refused. */
  message?: string;
}

export interface RemoveLocalServerResponse {
  removed: string;
  cleanup: LocalServerCleanupReport[];
}

export interface LocalModelsErrorBody {
  error: string;
  code: LocalModelsErrorCode;
}
