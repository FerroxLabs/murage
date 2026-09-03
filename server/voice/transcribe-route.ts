// The HTTP door onto Flux transcription: `POST /api/voice/transcribe`.
//
// WHY THIS IS A SEPARATE FILE AND NOT A BLOCK IN index.ts
// -------------------------------------------------------
// It is a registrar the dispatcher calls, in the same neighbourhood as the
// TTS routes, so `server/index.ts` grows one line rather than ninety. The
// signature is deliberately the four things the dispatcher already has in
// hand (`method`, `url`, `req`, `res`) and the return is "did I handle it",
// so an unmatched path falls through to every route below exactly as if this
// block were written inline.
//
// WHY THE BODY IS RAW AUDIO AND NOT MULTIPART
// -------------------------------------------
// The whole point of `MAX_AUDIO_BYTES` is that a phone on a slow uplink
// learns it is over the cap NOW, not after spending eight megabytes of
// uplink to be told. A raw body has a truthful `content-length` we can read
// before the first data event; a multipart envelope buries the audio's size
// inside a stream we would have to parse to measure. So the client PUTs the
// finished Blob straight up with its own MIME as the content-type, and the
// options ride in the query string — the same shape `POST /api/attachments`
// already uses for an image (`server/index.ts:6795`), and the reason that
// route can answer 413 without reading a byte.
//
// WHY THE CONTAINER NO LONGER PICKS THE MODEL
// -------------------------------------------
// `flux-voice.ts` warns that a Matroska (webm) clip cannot have its duration
// probed, so it always fell to the accuracy arm. That was only ever true for
// the `flux-voice` AUTO-PICKER, whose duration probe is the thing that cannot
// read the header. This route pins `flux-voice-fast` — the Groq
// whisper-large-v3-turbo arm — as the default, so the container stops
// deciding which model serves and a webm clip is a first-class path rather
// than a silent downgrade. `?model=` still lets a caller ask for
// `flux-voice-accurate` deliberately.
//
// MEASURED, NOT ASSUMED: `MediaRecorder.isTypeSupported("audio/ogg;codecs=
// opus")` is FALSE in both engines that matter. Chromium 143 headless
// (the Electron engine) and real Safari 26.3 / WebKit 605.1.15 both refuse
// ogg and both accept `audio/webm;codecs=opus`. See the container table
// below for what this route therefore has to accept.
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MAX_AUDIO_BYTES,
  TranscriptionUnavailable,
  transcribe as transcribeWithFlux,
  type TranscribeOptions,
  type Transcript,
  type TranscriptionFailure,
  type TranscriptionModel,
} from "./flux-voice.ts";

export const TRANSCRIBE_PATH = "/api/voice/transcribe";

/**
 * Containers Flux accepts, and the extension that tells it the truth.
 *
 * The filename is not decoration: `Recording.filename` is what the service
 * sniffs, so a `.webm` clip announced as `.ogg` is a guaranteed 400 after a
 * full upload. Deriving the extension from the content-type — rather than
 * trusting a name the client made up — is what keeps that honest.
 *
 * `audio/mp4` maps to `.m4a` rather than `.mp4`: both are the same container
 * and Safari's MediaRecorder emits `audio/mp4`, but `.m4a` is the spelling
 * that says "there is no video track in here" to anything that cares.
 */
const CONTAINERS: ReadonlyMap<string, string> = new Map([
  ["audio/ogg", "ogg"],
  ["audio/webm", "webm"],
  ["audio/mp4", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/m4a", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/wave", "wav"],
  ["audio/flac", "flac"],
  ["audio/x-flac", "flac"],
]);

/** What a person should be told they can send, when they sent something else. */
export const ACCEPTED_CONTAINERS = "ogg, webm, mp4/m4a, mp3, wav or flac";

/**
 * Reason value to HTTP status.
 *
 * The discipline the TTS routes established, driven off a value instead of a
 * parsed message. Three of these are the ones worth defending:
 *
 *  - `key` and `unavailable` are 409, not 502. Nothing failed. The workspace
 *    has no Flux key, or the Flux account has voice switched off, and the
 *    honest client response is to point at App Settings — the same split
 *    `POST /api/tts/speak` draws with `NoVoiceConfigured`.
 *
 *  - `premium` is 402 and is NOT collapsed into either of the above. The key
 *    is VALID and the plan does not cover transcription, so Settings has
 *    nothing to fix and a retry will never succeed. VERIFIED LIVE against
 *    api.fluxrouter.ai on this workspace's key: every arm answers
 *    `402 {"error":{"message":"audio transcription requires a paid plan",
 *    "code":"premium_locked"}}`. This is a reachable state today, not a
 *    branch written for completeness.
 *
 *  - `auth` is 401 and is distinct from `key`. A key that is present and
 *    rejected is a different sentence from no key at all — same live probe,
 *    a deliberately bad bearer answers `401 {"error":{"message":
 *    "unauthorized"}}`.
 */
const STATUS_FOR: Record<TranscriptionFailure, number> = {
  key: 409,
  unavailable: 409,
  premium: 402,
  auth: 401,
  too_large: 413,
  rate_limit: 429,
  format: 400,
  upstream: 502,
};

export function statusForFailure(reason: TranscriptionFailure): number {
  return STATUS_FOR[reason];
}

/** The three public aliases, as a runtime guard — an unknown `?model=` is a
 *  400 here rather than an undocumented synonym Flux could withdraw. */
const MODELS: ReadonlyArray<TranscriptionModel> = ["flux-voice", "flux-voice-accurate", "flux-voice-fast"];

export function isTranscriptionModel(value: string): value is TranscriptionModel {
  return (MODELS as ReadonlyArray<string>).includes(value);
}

/**
 * Pinned, not auto.
 *
 * Every Flux STT arm is Groq (`flux-router` dispatches `model=f"groq/{arm}"`);
 * the alias only chooses WHICH whisper. `flux-voice-fast` is
 * whisper-large-v3-turbo — the fast, cheap, accurate one — and pinning it
 * makes dictation deterministic instead of dependent on a duration probe
 * that a webm header defeats.
 */
export const DEFAULT_MODEL: TranscriptionModel = "flux-voice-fast";

/** The content-type, stripped of its codecs parameter and lowercased. */
export function containerOf(contentType: string | string[] | undefined): string | null {
  const raw = Array.isArray(contentType) ? contentType[0] : contentType;
  if (!raw) return null;
  const base = raw.split(";")[0]?.trim().toLowerCase();
  return base || null;
}

/** `audio/webm;codecs=opus` -> `clip.webm`, and nothing else gets a name. */
export function filenameFor(container: string): string | null {
  const extension = CONTAINERS.get(container);
  return extension ? `clip.${extension}` : null;
}

/** Injected by the test; production passes nothing. */
export interface TranscribeRouteDeps {
  transcribe?: (recording: { bytes: Uint8Array; filename: string; mime?: string }, options?: TranscribeOptions) => Promise<Transcript>;
  env?: NodeJS.ProcessEnv;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(data);
}

/**
 * Read the body, refusing early and refusing again.
 *
 * Twice on purpose. `content-length` is the cheap refusal a phone gets before
 * it uploads anything, and it is also a number the client chose — so the
 * running total is checked as well, and a chunked upload that lies about its
 * size is cut at the cap rather than after it.
 */
function readAudio(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const fail = (status: number, message: string) => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(message), { status }));
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.byteLength;
      if (received > MAX_AUDIO_BYTES) {
        return fail(413, "That recording is too long. Keep it under 8MB.");
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    req.on("error", (error) => fail(400, error instanceof Error ? error.message : String(error)));
  });
}

/**
 * Handle `POST /api/voice/transcribe`, or say you did not.
 *
 * Returns true when the response has been written and the dispatcher should
 * stop; false when this is somebody else's request. Never throws for a
 * refusal — every refusal is a status and a sentence, because the caller is a
 * phone with a held-down button and no console.
 */
export async function handleTranscribeRoute(
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  deps: TranscribeRouteDeps = {},
): Promise<boolean> {
  if (url.pathname !== TRANSCRIBE_PATH) return false;
  if (method !== "POST") {
    // The path exists and this verb does not, which is a different answer
    // from "no such route" and the one that stops a client retrying a GET.
    res.setHeader("allow", "POST");
    json(res, 405, { error: "POST audio to this route" });
    return true;
  }

  const container = containerOf(req.headers["content-type"]);
  if (!container) {
    req.resume();
    json(res, 400, { error: "content-type is required and must name the audio container" });
    return true;
  }
  const filename = filenameFor(container);
  if (!filename) {
    // 415, not 400: the request is well-formed and the container is the one
    // thing wrong with it. Draining first so the client sees the answer
    // instead of a reset socket mid-upload.
    req.resume();
    json(res, 415, {
      error: `That audio format isn't supported. Send ${ACCEPTED_CONTAINERS}.`,
      accepted: ACCEPTED_CONTAINERS,
    });
    return true;
  }

  // The cheap refusal, before a single byte of audio arrives.
  const rawLength = Array.isArray(req.headers["content-length"])
    ? req.headers["content-length"][0]
    : req.headers["content-length"];
  if (rawLength !== undefined) {
    const declared = Number(rawLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      req.resume();
      json(res, 400, { error: "content-length must be a non-negative integer" });
      return true;
    }
    if (declared > MAX_AUDIO_BYTES) {
      req.resume();
      json(res, 413, { error: "That recording is too long. Keep it under 8MB.", reason: "too_large" });
      return true;
    }
  }

  const requestedModel = url.searchParams.get("model");
  if (requestedModel !== null && !isTranscriptionModel(requestedModel)) {
    req.resume();
    json(res, 400, { error: `model must be one of ${MODELS.join(", ")}` });
    return true;
  }

  let bytes: Uint8Array;
  try {
    bytes = await readAudio(req);
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    json(res, status, {
      error: error instanceof Error ? error.message : String(error),
      reason: status === 413 ? "too_large" : undefined,
    });
    return true;
  }

  if (bytes.byteLength === 0) {
    json(res, 400, { error: "That recording was empty.", reason: "format" });
    return true;
  }

  const language = url.searchParams.get("language") ?? undefined;
  const prompt = url.searchParams.get("prompt") ?? undefined;
  const run = deps.transcribe ?? transcribeWithFlux;
  try {
    const transcript = await run(
      { bytes, filename, mime: container },
      {
        model: (requestedModel as TranscriptionModel | null) ?? DEFAULT_MODEL,
        language: language || undefined,
        prompt: prompt || undefined,
        env: deps.env,
      },
    );
    json(res, 200, transcript);
    return true;
  } catch (error) {
    if (error instanceof TranscriptionUnavailable) {
      // The reason travels in the body as well as in the status, so a client
      // branches on a value rather than re-deriving one from a number that
      // several reasons could share.
      json(res, statusForFailure(error.reason), {
        error: error.message,
        reason: error.reason,
        retryable: error.retryable,
      });
      return true;
    }
    json(res, 502, { error: error instanceof Error ? error.message : String(error), reason: "upstream" });
    return true;
  }
}
