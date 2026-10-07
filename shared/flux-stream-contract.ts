// shared/flux-stream-contract.ts
// Contract A (flux.stt.v1) of
// docs/superpowers/specs/2026-09-30-flux-streaming-transcription-design.md.
// One module for the page, the harness, the simulator and the conformance
// suite, so the four can never disagree about a field name or a close code.
// Plain types and functions: the harness runs under --experimental-strip-types.
import { z } from "zod";

export const SUBPROTOCOL = "flux.stt.v1";
/** Appended to a base that ends in /v1. */
export const STREAM_PATH = "/audio/transcriptions/stream";
export const DEFAULT_MODEL = "flux-voice-stream";
export const RESERVED_MODELS: readonly string[] = ["flux-voice-stream-multilingual"];
export const SAMPLE_RATES: readonly number[] = [8000, 16000, 24000];
export const LIMITS = { minFrameMs: 20, maxFrameMs: 1000, prestartBufferMs: 3000, burstMs: 3000, maxTextBytes: 16 * 1024 } as const;
export const MIN_BILLED_SECONDS = 10;
export const LEASE_MS = 60_000;
/** The `reason` on the `session.closed` message sent when a session reaches its
 *  maximum duration (`max_session_s`); the close code is 1000. */
export const MAX_SESSION_CLOSE_REASON = "max_duration";
/** Fleet-wide session starts a minute; over it 4503 service_unavailable with
 *  retry_after_ms (retryable). */
export const SESSION_STARTS_PER_MINUTE = 90;
export const USAGE_EVERY_MS = 60_000;
export const EXPIRING_NOTICE_MS = 30_000;
export const PING_EVERY_MS = 20_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const MAX_PROTOCOL_ERRORS = 5;
export const COALESCE_BYTES = 256 * 1024;
export const SLOW_CONSUMER_BYTES = 1024 * 1024;
export const COMMIT_DEADLINE_MS = 1000;
export const CLOSE_DEADLINE_MS = 2000;

export type Eagerness = "low" | "medium" | "high";
export type TurnDetection = "semantic" | "manual";

export interface StreamConfig {
  model: string;
  encoding: "pcm_s16le";
  sample_rate: number;
  channels: 1;
  language: string;
  partials: boolean;
  format: boolean;
  words: boolean;
  eagerness: Eagerness;
  min_silence_ms: number | null;
  max_silence_ms: number | null;
  turn_detection: TurnDetection;
  keyterms: string[];
  idle_timeout_s: number;
  max_session_s: number;
}

export const DEFAULT_CONFIG: StreamConfig = {
  model: DEFAULT_MODEL,
  encoding: "pcm_s16le",
  sample_rate: 16000,
  channels: 1,
  language: "en",
  partials: true,
  format: true,
  words: false,
  eagerness: "medium",
  min_silence_ms: null,
  max_silence_ms: null,
  turn_detection: "semantic",
  keyterms: [],
  idle_timeout_s: 30,
  max_session_s: 10_800,
};

export const IMMUTABLE: readonly string[] = ["model", "encoding", "sample_rate", "channels", "language", "format", "turn_detection", "idle_timeout_s", "max_session_s"];

export type ErrorType = "invalid_request_error" | "rate_limit_error" | "api_error";

export interface StreamError {
  code: string;
  type: ErrorType;
  message: string;
  fatal: boolean;
  close_code: number | null;
  retry_after_ms: number | null;
  param?: string;
}

/** 4000 plus the HTTP status Flux returns for the same condition (spec A.11). */
const HTTP_STATUS_FOR_CODE: Record<string, number> = {
  invalid_request_error: 400,
  unsupported_protocol: 400,
  invalid_audio_frame: 400,
  model_not_available: 400,
  language_not_available: 400,
  too_many_protocol_errors: 400,
  invalid_param: 400,
  unauthorized: 401,
  premium_locked: 402,
  billing_unavailable: 402,
  credit_unresolved: 402,
  credit_exhausted: 402,
  daily_cap: 402,
  monthly_cap: 402,
  forbidden: 403,
  not_found: 404,
  idle_timeout: 408,
  frame_too_large: 413,
  rate_limit_error: 429,
  concurrency_limit: 429,
  seconds_limit: 429,
  internal_error: 500,
  capability_unavailable: 502,
  service_unavailable: 503,
  slow_consumer: 503,
  upstream_timeout: 504,
};

export function closeCodeFor(code: string): number {
  const status = HTTP_STATUS_FOR_CODE[code];
  return status === undefined ? 4500 : 4000 + status;
}

export function errorTypeFor(close: number): ErrorType {
  if (close === 4429) return "rate_limit_error";
  if (close >= 4500) return "api_error";
  return "invalid_request_error";
}

export function fatal(code: string, message: string, extra: { param?: string; retry_after_ms?: number } = {}): StreamError {
  const close = closeCodeFor(code);
  return { code, type: errorTypeFor(close), message, fatal: true, close_code: close, retry_after_ms: extra.retry_after_ms ?? null, ...(extra.param ? { param: extra.param } : {}) };
}

export function notice(code: string, message: string, param?: string): StreamError {
  return { code, type: "invalid_request_error", message, fatal: false, close_code: null, retry_after_ms: null, ...(param ? { param } : {}) };
}

// ── config fields ─────────────────────────────────────────────────────────
type Check = { value: unknown } | { error: StreamError };
const bad = (param: string, message: string): Check => ({ error: fatal("invalid_param", message, { param }) });

function scalar(raw: unknown): unknown {
  return Array.isArray(raw) ? raw[raw.length - 1] : raw;
}
function asInt(param: string, raw: unknown, lo: number, hi: number): Check {
  const v = scalar(raw);
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= lo && n <= hi ? { value: n } : bad(param, `${param} must be an integer from ${lo} to ${hi}`);
}
function asBool(param: string, raw: unknown): Check {
  const v = scalar(raw);
  if (v === true || v === "true" || v === "1") return { value: true };
  if (v === false || v === "false" || v === "0") return { value: false };
  return bad(param, `${param} must be true or false`);
}
function oneOf(param: string, raw: unknown, allowed: readonly string[]): Check {
  const v = scalar(raw);
  return typeof v === "string" && allowed.includes(v) ? { value: v } : bad(param, `${param} must be one of ${allowed.join(", ")}`);
}

const FIELDS: Record<string, (raw: unknown) => Check> = {
  model: (raw) => {
    const v = scalar(raw);
    if (v === DEFAULT_MODEL) return { value: v };
    if (typeof v === "string" && RESERVED_MODELS.includes(v)) return { error: fatal("model_not_available", `${v} is not served yet`, { param: "model" }) };
    return bad("model", `model must be ${DEFAULT_MODEL}`);
  },
  encoding: (raw) => oneOf("encoding", raw, ["pcm_s16le"]),
  sample_rate: (raw) => {
    const n = asInt("sample_rate", raw, 1, 192_000);
    return "value" in n && SAMPLE_RATES.includes(n.value as number) ? n : bad("sample_rate", "sample_rate must be 8000, 16000 or 24000");
  },
  channels: (raw) => asInt("channels", raw, 1, 1),
  language: (raw) => {
    const v = scalar(raw);
    if (v === "en") return { value: v };
    if (typeof v === "string" && /^[a-z]{2}$/.test(v)) return { error: fatal("language_not_available", `${v} is not served yet`, { param: "language" }) };
    return bad("language", "language must be an ISO-639-1 code");
  },
  partials: (raw) => asBool("partials", raw),
  format: (raw) => asBool("format", raw),
  words: (raw) => asBool("words", raw),
  eagerness: (raw) => oneOf("eagerness", raw, ["low", "medium", "high"]),
  min_silence_ms: (raw) => asInt("min_silence_ms", raw, 100, 5000),
  max_silence_ms: (raw) => asInt("max_silence_ms", raw, 300, 10_000),
  turn_detection: (raw) => oneOf("turn_detection", raw, ["semantic", "manual"]),
  keyterms: (raw) => {
    const list = (Array.isArray(raw) ? raw : [raw])
      .flatMap((item) => (typeof item === "string" ? item.split(",") : [item]))
      .map((item) => (typeof item === "string" ? item.trim() : item))
      .filter((item) => item !== "" && item !== undefined && item !== null);
    if (list.length > 100 || list.some((t) => typeof t !== "string" || t.length > 50)) return bad("keyterms", "keyterms takes up to 100 terms of up to 50 characters");
    return { value: list };
  },
  idle_timeout_s: (raw) => asInt("idle_timeout_s", raw, 5, 300),
  max_session_s: (raw) => asInt("max_session_s", raw, 60, 10_800),
};

const FORBIDDEN_QUERY: readonly string[] = ["api_key", "apikey", "key", "authorization", "access_token"];
const TRANSPORT_QUERY: readonly string[] = ["client_token", "flux_test_fault"];

/** The first key-like query parameter, spelled as the client sent it. */
export function forbiddenQueryName(query: URLSearchParams): string | null {
  for (const name of query.keys()) if (FORBIDDEN_QUERY.includes(name.toLowerCase())) return name;
  return null;
}

/** Each eagerness preset's silences (spec A.4; medium resolves to 400/1280,
 *  which are sent explicitly like the others). Flux's adapter sends these; the contract validates the
 *  RESOLVED values, so an explicit value that crosses a preset is refused
 *  (Astra 2 I16: `eagerness=low&max_silence_ms=500` would resolve to 1500/500). */
export const SILENCE_PRESETS: Record<Eagerness, { min: number; max: number }> = {
  low: { min: 1500, max: 3000 },
  medium: { min: 400, max: 1280 },
  high: { min: 160, max: 800 },
};
export const MANUAL_MAX_SILENCE_MS = 10_000;

/** The silences a config runs with: explicit values, else the preset's (a
 *  preset maximum is raised to an explicit minimum). Manual mode ends only on
 *  commit or the maximum, so both are the maximum. */
export function resolveSilences(config: StreamConfig): { min: number; max: number } {
  if (config.turn_detection === "manual") {
    const max = config.max_silence_ms ?? MANUAL_MAX_SILENCE_MS;
    return { min: max, max };
  }
  const preset = SILENCE_PRESETS[config.eagerness];
  const min = config.min_silence_ms ?? preset.min;
  return { min, max: config.max_silence_ms ?? Math.max(min, preset.max) };
}

function silenceOrder(config: StreamConfig): StreamError | null {
  const { min, max } = resolveSilences(config);
  if (max < min) return fatal("invalid_param", "max_silence_ms must be at least min_silence_ms (after the eagerness preset)", { param: "max_silence_ms" });
  return null;
}

export type ConnectParse = { ok: true; config: StreamConfig; ignored: string[] } | { ok: false; error: StreamError };

export function parseConnectQuery(query: URLSearchParams, extraKnown: readonly string[] = []): ConnectParse {
  const forbidden = forbiddenQueryName(query);
  if (forbidden) return { ok: false, error: fatal("invalid_param", "send the key in the Authorization header, never the URL", { param: forbidden }) };
  const config: Record<string, unknown> = { ...DEFAULT_CONFIG };
  const ignored: string[] = [];
  for (const name of new Set(query.keys())) {
    if (TRANSPORT_QUERY.includes(name) || extraKnown.includes(name)) continue;
    const field = Object.hasOwn(FIELDS, name) ? FIELDS[name] : undefined;
    if (!field) {
      ignored.push(name);
      continue;
    }
    const checked = field(name === "keyterms" ? query.getAll(name) : query.get(name));
    if ("error" in checked) return { ok: false, error: checked.error };
    config[name] = checked.value;
  }
  const parsed = config as unknown as StreamConfig;
  const order = silenceOrder(parsed);
  return order ? { ok: false, error: order } : { ok: true, config: parsed, ignored };
}

export function applyUpdate(current: StreamConfig, patch: Record<string, unknown>): { config: StreamConfig; problem: StreamError | null } {
  for (const name of Object.keys(patch)) {
    if (IMMUTABLE.includes(name)) return { config: current, problem: notice("config_immutable", `${name} cannot change after connect`, name) };
  }
  const next: Record<string, unknown> = { ...current };
  for (const [name, raw] of Object.entries(patch)) {
    const field = Object.hasOwn(FIELDS, name) ? FIELDS[name] : undefined;
    if (!field) return { config: current, problem: notice("invalid_param", `unknown config field ${name}`, name) };
    const checked = field(raw);
    if ("error" in checked) return { config: current, problem: { ...checked.error, fatal: false, close_code: null } };
    next[name] = checked.value;
  }
  const order = silenceOrder(next as unknown as StreamConfig);
  if (order) return { config: current, problem: { ...order, fatal: false, close_code: null } };
  return { config: next as unknown as StreamConfig, problem: null };
}

export function frameMs(bytes: number, sampleRate: number): number {
  return (bytes / 2 / sampleRate) * 1000;
}

export function frameProblem(bytes: number, sampleRate: number): StreamError | null {
  if (bytes % 2 !== 0) return fatal("invalid_audio_frame", "audio frames are 16-bit samples: the byte count must be even");
  const ms = frameMs(bytes, sampleRate);
  if (ms < LIMITS.minFrameMs) return fatal("invalid_audio_frame", `a frame holds at least ${LIMITS.minFrameMs} ms of audio`);
  if (ms > LIMITS.maxFrameMs) return fatal("frame_too_large", `a frame holds at most ${LIMITS.maxFrameMs} ms of audio`);
  return null;
}

export function billedSeconds(sessionMs: number): number {
  return Math.max(MIN_BILLED_SECONDS, Math.ceil(Math.max(0, sessionMs) / 1000));
}

/** Billable seconds from session start through `elapsedMs`: whole seconds at
 *  a lease renewal, the ceiling with the floor at the close. Each lease bills
 *  settledThrough(now) minus what earlier leases billed (spec A.14). */
export function settledThrough(elapsedMs: number, final: boolean): number {
  return final ? billedSeconds(elapsedMs) : Math.floor(Math.max(0, elapsedMs) / 1000);
}

export function streamUrl(base: string, query: URLSearchParams): string {
  const q = query.toString();
  return `${base.replace(/\/+$/, "")}${STREAM_PATH}${q ? `?${q}` : ""}`;
}

// ── messages ──────────────────────────────────────────────────────────────
const base = { seq: z.number().int().positive(), received_audio_ms: z.number().int().nonnegative() };
const turn = z.number().int().nonnegative();
const span = { audio_start_ms: z.number().nonnegative(), audio_end_ms: z.number().nonnegative() };
const lag = { server_lag_ms: z.number().int().nonnegative() };
const word = z.object({ text: z.string(), start_ms: z.number(), end_ms: z.number(), confidence: z.number().nullable() });
/** Billing as three distinct amounts (spec A.14, Astra 2 I2): billed_seconds
 *  is what the session has accrued under the billing rule (what it will be
 *  charged); confirmed_seconds is the part the ledger had recorded when the
 *  message was sent; pending_seconds is the rest, still being recorded, and
 *  settled exactly once after the message if need be. */
const usage = {
  session_seconds: z.number().nonnegative(),
  audio_seconds: z.number().nonnegative(),
  billed_seconds: z.number().int().nonnegative(),
  confirmed_seconds: z.number().int().nonnegative(),
  pending_seconds: z.number().int().nonnegative(),
  unit: z.literal("session_second"),
};
const errorBody = z.object({
  code: z.string(),
  type: z.enum(["invalid_request_error", "rate_limit_error", "api_error"]),
  message: z.string(),
  fatal: z.boolean(),
  close_code: z.number().int().nullable(),
  retry_after_ms: z.number().int().nullable(),
  param: z.string().optional(),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.started"),
    ...base,
    session_id: z.string(),
    model: z.string(),
    config: z.record(z.string(), z.unknown()),
    limits: z.object({ min_frame_ms: z.number(), max_frame_ms: z.number(), prestart_buffer_ms: z.number(), burst_ms: z.number() }),
    ignored_params: z.array(z.string()),
    expires_at: z.number(),
  }),
  z.object({ type: z.literal("session.updated"), ...base, config: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("speech.started"), ...base, turn, audio_ms: z.number().nonnegative() }),
  z.object({ type: z.literal("transcript.partial"), ...base, turn, text: z.string(), ...span }),
  z.object({ type: z.literal("transcript.final"), ...base, turn, text: z.string(), turn_text: z.string(), ...span, ...lag, words: z.array(word).optional() }),
  z.object({
    type: z.literal("turn.end"),
    ...base,
    turn,
    text: z.string().min(1),
    reason: z.enum(["endpoint", "forced", "session_end"]),
    confidence: z.number().min(0).max(1).nullable(),
    ...span,
    ...lag,
    words: z.array(word).optional(),
  }),
  z.object({ type: z.literal("turn.cancelled"), ...base, turn }),
  z.object({ type: z.literal("turn.committed"), ...base, turn: turn.nullable() }),
  z.object({ type: z.literal("usage"), ...base, ...usage }),
  z.object({ type: z.literal("error"), ...base, error: errorBody }),
  z.object({
    type: z.literal("warning"), ...base, code: z.string(), message: z.string(), dropped_ms: z.number().optional(), at_audio_ms: z.number().optional(),
    // every contiguous dropped range since the last warning, in order (Astra 3 I9); dropped_ms is their sum, at_audio_ms the first's
    ranges: z.array(z.object({ at_audio_ms: z.number(), dropped_ms: z.number() })).optional(),
  }),
  z.object({ type: z.literal("session.expiring"), ...base, closes_in_ms: z.number() }),
  z.object({ type: z.literal("session.closed"), ...base, reason: z.string(), usage: z.object(usage) }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;
/** A server message before `seq` and `received_audio_ms` are stamped on. */
export type Outbound = ServerMessage extends infer M ? (M extends ServerMessage ? Omit<M, "seq" | "received_audio_ms"> : never) : never;

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const parsed = serverMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type ClientMessage =
  | { type: "session.update"; config: Record<string, unknown> }
  | { type: "turn.commit" }
  | { type: "keepalive" }
  | { type: "session.close" };

export function parseClientMessage(raw: string): ClientMessage | { invalid: "invalid_json" | "unknown_message_type" } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { invalid: "invalid_json" };
  }
  const type = (value as { type?: unknown } | null)?.type;
  if (type === "turn.commit" || type === "keepalive" || type === "session.close") return { type };
  if (type === "session.update") {
    const config = (value as { config?: unknown }).config;
    if (config && typeof config === "object" && !Array.isArray(config)) return { type, config: config as Record<string, unknown> };
    return { invalid: "invalid_json" };
  }
  return { invalid: "unknown_message_type" };
}

// ── spoken forms (turn.end agreement, Astra 3 I1; owner scoring, Astra 3 I10) ──
// The provider bake-off's normalization (stt-spike lib.mjs `normalize`), ported
// verbatim so the mapper and the owner scorer read "4:30", "25", "3rd" and
// "Dr." exactly as the bake-off did.
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ORDINALS: Record<string, string> = { "1st": "first", "2nd": "second", "3rd": "third", "4th": "fourth", "5th": "fifth",
  "6th": "sixth", "7th": "seventh", "8th": "eighth", "9th": "ninth", "10th": "tenth" };

function numberWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`;
  if (n < 10000 && n % 100 !== 0) return `${numberWords(Math.floor(n / 100))} ${numberWords(n % 100)}`; // 1945: nineteen forty five
  return String(n).split("").map((d) => ONES[Number(d)]).join(" ");
}

/** Lower-case spoken words: numbers, times, ordinals and "Dr." read aloud, punctuation gone. */
export function spokenWords(text: string): string[] {
  let t = String(text || "").toLowerCase();
  t = t.replace(/cancelled/g, "canceled").replace(/([a-z])(\d)/g, "$1 $2");
  t = t.replace(/(\d+):(\d\d)/g, (_, h: string, m: string) => `${h} ${m}`);
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/g, (m) => ORDINALS[m] || m);
  t = t.replace(/\b0(\d)/g, "oh $1");
  t = t.replace(/\d+/g, (d) => (d.length > 4 ? d.split("").map((c) => ONES[Number(c)]).join(" ") : numberWords(Number(d))));
  t = t.replace(/\bzero\b/g, "oh").replace(/\bdr\b\.?/g, "doctor").replace(/'/g, "").replace(/-/g, " ");
  t = t.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.split(" ") : [];
}

/** A text-only end of turn against the finals already sent (spec A.8, Astra 3
 *  I1). Finals are immutable: the text must begin with them in spoken form
 *  ("twenty five" and "25" agree), and only its words after that prefix are a
 *  new final. A text that contradicts them does not rewrite them: the finals
 *  stand, nothing new is finalized, and the end carries the finals' text, so
 *  the finals and the end always agree; the adapter counts the conflict. */
export function reconcileTextEnd(finalized: string, text: string): { newFinal: string | null; endText: string; conflict: boolean } {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!spokenWords(finalized).length) return { newFinal: tokens.length ? tokens.join(" ") : null, endText: text.trim(), conflict: false };
  const cut = splitAfterFinals(finalized, tokens);
  if (!cut) return { newFinal: null, endText: finalized.trim(), conflict: true };
  const rest = [...cut.carry, ...tokens.slice(cut.k)].join(" ");
  return { newFinal: rest && spokenWords(rest).length ? rest : null, endText: text.trim(), conflict: false };
}

/** Where an end of turn's tokens (its words, or its text split on spaces)
 *  pass the finals already sent, in spoken form (Astra 3 I1, Astra 4 I4):
 *  tokens from `k` on are new, and `carry` is the spoken words of token k-1
 *  past the finals when one formatted token covers both ("25" after the final
 *  "twenty" carries ["five"]). Null when the tokens contradict the finals. */
export function splitAfterFinals(finalized: string, tokens: string[]): { k: number; carry: string[] } | null {
  const done = spokenWords(finalized);
  if (!done.length) return { k: 0, carry: [] };
  for (let k = 1; k <= tokens.length; k += 1) {
    const said = spokenWords(tokens.slice(0, k).join(" "));
    if (said.length < done.length) continue;
    if (done.every((w, i) => w === said[i])) return { k, carry: said.slice(done.length) };
    return null;
  }
  return null;
}
