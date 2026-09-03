// Speech to text, on the Flux key the workspace already has.
//
// WHY THIS FILE EXISTS, AND WHAT FLUX ACTUALLY OFFERS
// ---------------------------------------------------
// Flux Router exposes exactly one audio capability: TRANSCRIPTION, at
// `POST /v1/audio/transcriptions` (flux-router `src/audio_route.py:90`,
// mounted by `src/audio_route_registrar.py:113`). There is NO synthesis
// endpoint. No `/v1/audio/speech`, no ElevenLabs passthrough, no voice ids
// of any kind anywhere in that service. So this file does not, and must
// not, grow a `speak()`: the ElevenLabs path in `../tts/elevenlabs.ts`
// stays the only way Murage turns text into audio, on the user's own key.
//
// What it DOES buy is the half Murage cannot do today. Dictation is a
// native macOS helper (`electron/resources/Murage Speech.app`, driven from
// `electron/main.mjs`), so a phone browser pointed at the harness has no
// microphone path at all. Transcription that runs on the SERVER works for
// every remote surface at once, and it rides `cfg.flux.apiKey` rather than
// asking for the separate AssemblyAI credential the skill recorder needs.
//
// Batch, not streaming. Flux is explicit that `stream: true` is rejected
// because the backing engine is batch only, so this is push to talk: record,
// release, then one round trip returns the whole utterance. It is not the
// word-at-a-time partial stream the native recognizer gives on the desktop.
//
// Runs on the HARNESS, never the renderer, for the same reason ElevenLabs
// does: the key must not leave the server. `fluxKey()` is the one reader of
// that credential and this file is a caller of it, never a second copy.
import { fluxKey } from "../flux-config.ts";

/** OpenAI-compatible base. Read per call, NOT captured at module load: a
 *  module-level const is resolved before a test's `beforeAll` can point it
 *  at a stub, which silently sends the suite at the real service and turns
 *  every assertion into a 401 from production. Found exactly that way. */
function apiBase(): string {
  return process.env.MURAGE_FLUX_AUDIO_API || "https://api.fluxrouter.ai/v1";
}

/**
 * Flux's in-app body cap. Rejecting here rather than uploading eight
 * megabytes to be told no is the whole point: a phone on a slow uplink
 * should learn immediately, not after the upload finishes.
 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/**
 * The three public aliases. `flux-voice` picks per clip on duration and is
 * the right default; the other two pin an arm. Deliberately NOT the backing
 * engine names, which Flux accepts as undocumented synonyms and could
 * withdraw without notice.
 */
export type TranscriptionModel = "flux-voice" | "flux-voice-accurate" | "flux-voice-fast";

export interface Transcript {
  text: string;
  /** Detected (or requested) language, when the service reports one. */
  language?: string;
  /** Clip length in seconds, as the service measured it. */
  duration?: number;
  /** Which public arm served, from `x-flux-routed-model`. */
  model?: string;
  /** Audio seconds billed for this call, from `x-flux-billed-seconds`.
   *  Surfaced so a caller can show cost honestly rather than guessing. */
  billedSeconds?: number;
}

/**
 * Why transcription could not happen, as a value rather than a string to
 * match on. `premium` is the one that must never be collapsed into a
 * generic failure: it means the key is VALID and the plan is not, so the
 * answer is an upgrade prompt and never a retry.
 */
export type TranscriptionFailure =
  | "key"
  | "unavailable"
  | "auth"
  | "premium"
  | "too_large"
  | "rate_limit"
  | "format"
  | "upstream";

export class TranscriptionUnavailable extends Error {
  // a plain field, not a constructor parameter property: the harness runs
  // under `node --experimental-strip-types`, which is strip-ONLY, so a
  // parameter property is rejected at load time even though it typechecks
  readonly reason: TranscriptionFailure;
  /** True when trying the identical request again could plausibly work. */
  readonly retryable: boolean;

  constructor(reason: TranscriptionFailure, message: string) {
    super(message);
    this.reason = reason;
    this.retryable = reason === "rate_limit" || reason === "upstream";
  }
}

/** Whether the workspace has a Flux key at all. Never returns the key
 *  itself: a renderer bundle is readable by anyone who installs the app. */
export function transcriptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return fluxKey(env) !== null;
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Prefer the service's own words where it gives usable ones, the same rule
 *  `elevenlabs.message` follows, but never let it invent the ACTION. */
function theirWords(body: any): string {
  const error = body?.error ?? body;
  const said =
    (typeof error?.message === "string" && error.message.trim()) ||
    (typeof body?.detail === "string" && body.detail.trim()) ||
    "";
  return said;
}

/**
 * HTTP status to a reason plus the sentence a person should read.
 *
 * The status table is Flux's, verified against its own integration contract:
 * 402 `premium_locked` is the one code no other transcription service
 * returns, and 404 means the capability is dark rather than missing.
 */
function failureFor(status: number, body: any): TranscriptionUnavailable {
  const said = theirWords(body);
  if (status === 404) {
    return new TranscriptionUnavailable(
      "unavailable",
      "Voice typing is not switched on for this Flux account yet.",
    );
  }
  if (status === 401 || status === 403) {
    return new TranscriptionUnavailable(
      "auth",
      "Flux rejected that key. Paste a fresh one in Settings on the computer.",
    );
  }
  if (status === 402) {
    return new TranscriptionUnavailable(
      "premium",
      "Voice typing needs a paid Flux plan. The key is fine; the plan does not cover it yet.",
    );
  }
  if (status === 413) {
    return new TranscriptionUnavailable("too_large", "That recording is too long. Keep it under 8MB.");
  }
  if (status === 429) {
    return new TranscriptionUnavailable(
      "rate_limit",
      said || "Flux is rate-limiting this account. Wait a moment and try again.",
    );
  }
  if (status === 400) {
    return new TranscriptionUnavailable("format", said || "That audio format was not recognized.");
  }
  return new TranscriptionUnavailable("upstream", said ? `Transcribing failed: ${said}` : `Transcribing failed (${status})`);
}

export interface Recording {
  bytes: Uint8Array;
  /** Used for the container sniff, so the extension has to be honest.
   *  Prefer `.ogg` over `.webm`: the duration auto-pick cannot read a
   *  Matroska header, so all-webm clips always take the accuracy arm. */
  filename: string;
  /** Optional content type for the upload part. */
  mime?: string;
}

export interface TranscribeOptions {
  model?: TranscriptionModel;
  /** ISO-639-1. Omit to let the service detect it. */
  language?: string;
  /** Vocabulary hint for names and jargon. Truncated to the documented cap
   *  so an oversized prompt is a shorter prompt, never a 400. */
  prompt?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; production omits it. */
  fetchImpl?: typeof fetch;
}

const PROMPT_MAX_CHARS = 2000;
const TIMEOUT_MS = 60_000;

/**
 * THE one entry point. Every caller resolves the credential, the limits and
 * the failure vocabulary here, so a route, a CLI and a future phone client
 * cannot disagree about what "not available" means.
 *
 * Throws `TranscriptionUnavailable` for every refusal, including the local
 * ones, so callers branch on `.reason` and never on a parsed message.
 */
export async function transcribe(recording: Recording, options: TranscribeOptions = {}): Promise<Transcript> {
  const key = fluxKey(options.env ?? process.env);
  if (!key) {
    throw new TranscriptionUnavailable(
      "key",
      "Add a Flux key in Settings on the computer to turn on voice typing.",
    );
  }
  if (recording.bytes.byteLength === 0) {
    throw new TranscriptionUnavailable("format", "That recording was empty.");
  }
  // Checked before the upload starts, not after: the service would reject it
  // anyway, and a phone should not spend the uplink to find that out.
  if (recording.bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new TranscriptionUnavailable("too_large", "That recording is too long. Keep it under 8MB.");
  }

  const form = new FormData();
  // The Blob part is built from a plain ArrayBuffer rather than the view:
  // the server tsconfig has no DOM lib, so `BlobPart` is not a name this
  // file may say, and a copied buffer is the portable spelling.
  const copy = new Uint8Array(recording.bytes.byteLength);
  copy.set(recording.bytes);
  const part = new Blob([copy], { type: recording.mime || "application/octet-stream" });
  form.append("file", part, recording.filename);
  form.append("model", options.model ?? "flux-voice");
  // verbose_json is what carries `duration` and `language`; the flat `json`
  // shape would drop both and we would be guessing at the cost we report.
  form.append("response_format", "verbose_json");
  if (options.language) form.append("language", options.language);
  if (options.prompt?.trim()) form.append("prompt", options.prompt.trim().slice(0, PROMPT_MAX_CHARS));

  const call = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await call(`${apiBase()}/audio/transcriptions`, {
      method: "POST",
      // Bearer, not a vendor header: this is the same key the chat surfaces
      // use, and it must never be logged or echoed back to a renderer.
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new TranscriptionUnavailable("upstream", "Couldn't reach Flux to transcribe that. Check your connection.");
  }

  if (!res.ok) throw failureFor(res.status, await safeJson(res));

  const body = await safeJson(res);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  return {
    text,
    language: typeof body?.language === "string" ? body.language : undefined,
    duration: Number.isFinite(body?.duration) ? Number(body.duration) : undefined,
    model: res.headers.get("x-flux-routed-model") ?? undefined,
    billedSeconds: numberOrUndefined(res.headers.get("x-flux-billed-seconds")),
  };
}

function numberOrUndefined(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
