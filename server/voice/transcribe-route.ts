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

/**
 * The route's OWN clip ceiling, deliberately tighter than Flux's 8MB.
 *
 * 8MB is Flux's body limit, not a bound on cost: Opus at the bitrates a
 * MediaRecorder actually emits puts roughly forty minutes of audio inside it,
 * and transcription is billed by the second on the workspace's key. So the
 * shipped "one clip, 8MB" check bounded the UPLOAD and left the BILL open.
 *
 * The client stops itself at two minutes (`PushToTalk.MAX_CLIP_MS`), and the
 * most generous realistic MediaRecorder audio bitrate is 128kbps — so the
 * largest clip a real person can produce is about 1.9MB. Four megabytes is
 * more than double that: no normal user can reach it, and it halves what a
 * single accepted request can possibly cost.
 */
export const MAX_CLIP_BYTES = 4 * 1024 * 1024;

/**
 * How many clips may be in flight at once.
 *
 * Push to talk is a human holding a button: one person speaks once at a time.
 * Two rather than one is slack for the case where the client has already
 * given up on a slow request (`PushToTalk.CLIP_TIMEOUT_MS`) and the person
 * presses again while the abandoned one is still upstream. A person cannot
 * trip this. Fifty concurrent POSTs from a stolen pairing token trips it
 * forty-eight times, BEFORE their bodies are read — which is also what stops
 * the harness holding fifty eight-megabyte buffers at once.
 */
export const MAX_CONCURRENT_CLIPS = 2;

/** The rolling window the budget below is measured over. */
export const BUDGET_WINDOW_MS = 60 * 60_000;

/**
 * Billed audio seconds allowed per window.
 *
 * One hour of audio per rolling hour. A person cannot exceed this: it would
 * require speaking into the button without pause for the entire hour, which
 * is more dictation than the wall clock contains. An attacker reaches it in
 * two requests and is then refused for the rest of the window — which turns
 * "roughly thirty hours of billed audio in one burst" into a bounded, and
 * frankly generous, ceiling.
 */
export const BUDGET_MAX_BILLED_SECONDS = 60 * 60;

/**
 * Requests allowed per window, regardless of how little each one cost.
 *
 * The seconds budget is the bound on money; this is the bound on everything
 * else — sockets, uploads, and upstream calls. 240 an hour is one utterance
 * every fifteen seconds sustained for a full hour, which no dictation session
 * approaches, and 240 one-second clips cost four minutes of audio, so it can
 * never be the cap that bites a real user first.
 */
export const BUDGET_MAX_REQUESTS = 240;

/**
 * Audio seconds a clip of this size could possibly be.
 *
 * Used only when the provider told us nothing — an error path. Opus at 24kbps
 * (3000 bytes a second) is the CHEAPEST bitrate anything in the wild emits,
 * so dividing by it yields the LONGEST clip those bytes could hold. Guessing
 * high is the right direction for a budget: it over-charges a failure, which
 * is rare, rather than under-charging an attack, which is not.
 */
export function estimateBilledSeconds(bytes: number): number {
  return Math.ceil(bytes / 3000);
}

/**
 * The bound on a billable route a phone can reach.
 *
 * Shaped after `createSignInLimiter` (`companion/src/browser.ts:1041`) on
 * purpose rather than invented: in-memory, one per door, living as long as
 * the door does, and driven on an injectable clock so a test can roll the
 * window without waiting an hour. The difference is what it counts — that
 * limiter counts failed sign-ins, and nothing in the tree counted spend.
 */
export interface VoiceBudget {
  /** Reserve a slot, or say how long to wait and why. */
  begin(
    now?: number,
  ):
    | { ok: true; done: (billedSeconds: number, now?: number) => void }
    | { ok: false; retryAfterMs: number; reason: "busy" | "budget" };
}

export function createVoiceBudget(): VoiceBudget {
  let inFlight = 0;
  /** [when it happened, what it cost in billed seconds] */
  let spent: Array<[number, number]> = [];

  const forget = (now: number): void => {
    const from = now - BUDGET_WINDOW_MS;
    if (spent.length && spent[0][0] <= from) spent = spent.filter(([at]) => at > from);
  };

  return {
    begin(now = Date.now()) {
      forget(now);
      if (inFlight >= MAX_CONCURRENT_CLIPS) {
        // Seconds, not the window: the thing to wait for is the clip in front
        // of you finishing, and that is a moment away, not an hour.
        return { ok: false, retryAfterMs: 5_000, reason: "busy" };
      }
      let seconds = 0;
      for (const [, cost] of spent) seconds += cost;
      if (spent.length >= BUDGET_MAX_REQUESTS || seconds >= BUDGET_MAX_BILLED_SECONDS) {
        const oldest = spent[0]?.[0] ?? now;
        return { ok: false, retryAfterMs: Math.max(1_000, oldest + BUDGET_WINDOW_MS - now), reason: "budget" };
      }
      inFlight += 1;
      let closed = false;
      return {
        ok: true,
        done: (billedSeconds, at = Date.now()) => {
          // Idempotent: the handler has several exits and one of them is a
          // catch, and a slot released twice would let the count drift below
          // zero and quietly disable the concurrency cap.
          if (closed) return;
          closed = true;
          inFlight -= 1;
          spent.push([at, Math.max(0, billedSeconds)]);
        },
      };
    },
  };
}

/** One sentence for the size refusal, in the two places that can give it. */
const TOO_LARGE = "That recording is too long. Keep it under 4MB, or about two minutes.";

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
  /** Injectable so a test gets a fresh window; production shares the one
   *  below, which lives as long as the process — the same arrangement the
   *  sign-in limiter makes, for the same reason. */
  budget?: VoiceBudget;
}

/** One budget per harness, created once. */
const processBudget = createVoiceBudget();

/**
 * Cut the upload once the answer is on the wire.
 *
 * Destroying `req` destroys the socket beneath it, so this must wait for the
 * response to flush — otherwise the refusal is written into a socket that is
 * torn down before the bytes leave, and the client gets a reset with no
 * status at all.
 */
function cutWhenAnswered(req: IncomingMessage, res: ServerResponse): void {
  const cut = () => {
    // Stop reading first, so nothing more is buffered while the close runs.
    req.pause();
    const socket = res.socket ?? req.socket;
    if (!socket || socket.destroyed) return;
    // `end()` and not `destroy()`. MEASURED: a hard destroy with unread
    // request bytes still in flight sends a TCP RST, and an RST discards the
    // peer's receive buffer — so the 413 we just wrote is thrown away and the
    // client sees a reset connection with no status at all. Caught exactly
    // that way, by a control that then read an empty status line. A FIN
    // flushes what we wrote and still stops the upload.
    socket.end();
    // Backstop for a peer that keeps its half of the connection open and
    // keeps sending: the FIN was the polite ask, this is the answer.
    setTimeout(() => {
      if (!socket.destroyed) socket.destroy();
    }, 1_000).unref();
  };
  if (res.writableFinished) return cut();
  res.once("finish", cut);
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
function readAudio(req: IncomingMessage, limit: number): Promise<Uint8Array> {
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
      if (received > limit) return fail(413, TOO_LARGE);
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    req.on("error", (error) => fail(400, error instanceof Error ? error.message : String(error)));
    // MEASURED, not assumed: on Node 22.23 a peer that vanishes mid-body
    // emits `data, aborted, error:ECONNRESET, close` in that order, so the
    // "error" listener above is what settles the ordinary disconnect today —
    // both for a reset and for a clean half-close. These two are here because
    // nothing in Node's contract PROMISES that ECONNRESET, and the cost of
    // being wrong is asymmetric: a promise that settles twice is free, and
    // one that never settles holds a request object, its buffered chunks and
    // a socket for the life of the process, once per abandoned upload.
    req.on("aborted", () => fail(499, "The upload was abandoned."));
    req.on("close", () => fail(499, "The upload was abandoned."));
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
    if (declared > MAX_CLIP_BYTES) {
      req.resume();
      json(res, 413, { error: TOO_LARGE, reason: "too_large" });
      return true;
    }
  }

  // `?model=` may name the PINNED arm and nothing else.
  //
  // It used to admit all three aliases, which handed a caller on a remote,
  // billable surface the choice of the more expensive engine —
  // `flux-voice-accurate` directly, and `flux-voice` by the back door, since
  // its duration probe cannot read a Matroska header and so falls to the
  // accurate arm for exactly the webm clips both phone engines produce.
  // Nothing in the tree has ever sent this parameter; the only caller it
  // served was one choosing to spend more of somebody else's money.
  const requestedModel = url.searchParams.get("model");
  if (requestedModel !== null && requestedModel !== DEFAULT_MODEL) {
    req.resume();
    json(res, 400, {
      error: isTranscriptionModel(requestedModel)
        ? `this route serves ${DEFAULT_MODEL} only`
        : `model must be ${DEFAULT_MODEL}`,
    });
    return true;
  }

  // The slot is taken BEFORE the body is read, which is the half that
  // matters: a refused request costs one response and no buffer at all.
  const budget = deps.budget ?? processBudget;
  const slot = budget.begin();
  if (!slot.ok) {
    // Before `json`, which writes the head — a header set after that is a
    // header nobody receives.
    res.setHeader("retry-after", String(Math.ceil(slot.retryAfterMs / 1000)));
    json(res, 429, {
      error:
        slot.reason === "busy"
          ? "Still working on the last recording. Try again in a moment."
          : "Voice typing has used its hourly allowance. Try again later.",
      reason: slot.reason,
      retryAfterMs: slot.retryAfterMs,
    });
    // The caller may be mid-upload; do not sit and drain a body that has
    // already been refused.
    cutWhenAnswered(req, res);
    return true;
  }

  let bytes: Uint8Array;
  try {
    bytes = await readAudio(req, MAX_CLIP_BYTES);
  } catch (error) {
    // Nothing was sent upstream, so nothing was billed. Releasing at zero
    // keeps a workspace that is simply misconfigured — every request a 409 —
    // from burning its own allowance on refusals and then being told, untruly,
    // that it is over budget.
    slot.done(0);
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    // 499 is our own marker for "the peer is gone". There is nobody left to
    // write to, and writing anyway is how a handler turns a disconnect into
    // an ERR_STREAM_WRITE_AFTER_END in the logs.
    if (status !== 499 && !res.writableEnded) {
      json(res, status, {
        error: error instanceof Error ? error.message : String(error),
        reason: status === 413 ? "too_large" : undefined,
      });
    }
    // Then cut the upload. Without this a chunked client that is still
    // sending keeps feeding a discard loop until Node's default 300-second
    // `requestTimeout` notices — five minutes of the harness's uplink spent
    // on bytes that were already refused, per request.
    //
    // AFTER the response has flushed, not before. Destroying the request
    // destroys the socket under it, and doing that synchronously throws the
    // 413 away unsent: the client sees a reset connection and no reason at
    // all. Caught exactly that way, by a control that then read an empty
    // status line.
    cutWhenAnswered(req, res);
    return true;
  }

  if (bytes.byteLength === 0) {
    slot.done(0);
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
    // Charged from what Flux says it billed, never from a guess, whenever it
    // says anything at all.
    slot.done(transcript.billedSeconds ?? transcript.duration ?? estimateBilledSeconds(bytes.byteLength));
    json(res, 200, transcript);
    return true;
  } catch (error) {
    if (error instanceof TranscriptionUnavailable) {
      // Which refusals actually cost anything. `key`, `unavailable`, `auth`
      // and `premium` are answered before a single second is transcribed;
      // `format` and `too_large` are the payload being rejected. The two that
      // may have spent something upstream are charged the conservative
      // estimate, so a retry storm against a failing provider still runs out.
      slot.done(
        error.reason === "upstream" || error.reason === "rate_limit"
          ? estimateBilledSeconds(bytes.byteLength)
          : 0,
      );
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
    // Nobody planned for this one, so assume it reached the meter.
    slot.done(estimateBilledSeconds(bytes.byteLength));
    json(res, 502, { error: error instanceof Error ? error.message : String(error), reason: "upstream" });
    return true;
  }
}
