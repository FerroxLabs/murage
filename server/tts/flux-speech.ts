// Speech through Flux Router, or an owner's own OpenAI key.
//
// Voice is Flux by default: a workspace with a Flux key needs no second
// account to give its bots a voice. ElevenLabs (elevenlabs.ts) and the
// built-in system voices stay as options for owners who prefer them.
//
// Flux's `POST /v1/audio/speech` is OpenAI-shaped: `flux-voice-speak` is
// backed by gpt-4o-mini-tts and billed per character, and Flux streams the
// audio as it is made. One request per utterance, the same shape as
// ElevenLabs here: the client already splits text into sentences and fetches
// the next while the current one plays.
//
// Without Flux, an owner's own OpenAI key serves the very same request with
// `gpt-4o-mini-tts`, the model `flux-voice-speak` is backed by: same voices,
// same sound, billed to their OpenAI account instead.
//
// Runs on the HARNESS only: the key must not leave the server.
import { clipFrom, type Audio, type Clip, type Voice } from "./elevenlabs.ts";
import { RateLimitedError, retryAfterMs } from "./rate-limit.ts";
import { notPermitted, VoiceUnavailable, type VoiceEndpoint } from "../voice/voice-routes.ts";
import { XAI_VOICES } from "./xai-speech.ts";

/** Flux's alias for xAI's voices (2026-09-23): the same Flux request, xAI's
 *  voice names. Flux translates it to xAI's own schema. */
export const FLUX_GROK_MODEL = "flux-voice-speak-grok";
const XAI_IDS = new Set(XAI_VOICES.map((v) => v.id));

/** A test seam for the Flux base only; production uses the resolved route. */
function baseFor(endpoint: VoiceEndpoint): string {
  const stub = endpoint.via === "flux" ? process.env.MURAGE_FLUX_AUDIO_API : undefined;
  return (stub || endpoint.baseUrl).replace(/\/+$/, "");
}

/** The voices Flux offers on `flux-voice-speak` (OpenAI's list). `id` is
 *  OpenAI's own and is what gets stored and sent; `label` is the name Murage
 *  shows, described from six listens per voice (2026-09-24). OpenAI does
 *  not publish genders; these are how each voice commonly sounds. */
export const FLUX_VOICES: Voice[] = ([
  ["marin", "Nora", "Warm, natural, American", "female"],
  ["cedar", "Owen", "Grounded, friendly, American", "male"],
  ["alloy", "Quinn", "Balanced, even", "neutral"],
  ["ash", "Ryan", "Confident, friendly, American", "male"],
  ["ballad", "Oliver", "Soft, expressive, British", "male"],
  ["coral", "Zoe", "Bright, energetic, American", "female"],
  ["echo", "Noah", "Calm, even, American", "male"],
  ["fable", "Rupert", "Storyteller, crisp, British", "male"],
  ["nova", "Kira", "Upbeat, confident, American", "female"],
  ["onyx", "Marcus", "Deep, steady, American", "male"],
  ["sage", "Tessa", "Crisp, cheerful, American", "female"],
  ["shimmer", "Chloe", "Light, bright, American", "female"],
  ["verse", "Mateo", "Expressive, friendly, American", "male"],
] as const).map(([id, label, description, gender]) => ({ id, label, description, gender, provider: "openai" as const }));

const IDS = new Set(FLUX_VOICES.map((v) => v.id));

/** A clip this short is a sentence or two (the splitter's cap is 320). */
export const SHORT_CLIP_CHARS = 340;
export const SHORT_CLIP_TIMEOUT_MS = 20_000;
export const LONG_CLIP_TIMEOUT_MS = 60_000;
/** Pause before the one retry after a network error or a 5xx. */
export const TTS_RETRY_MS = 400;
/** A failure that took longer than this is not retried: a slow failure
 *  twice over is a wait nobody should sit through. */
export const RETRY_ONLY_IF_WITHIN_MS = 8_000;
/** No audio bytes for this long ends the body. */
export const BODY_STALL_MS = 10_000;

/** One `[tts]` line per provider failure: status, who, what and how long,
 *  never the text, the key or a URL. */
export function logTtsFailure(f: { status: number | string; provider: string; model: string; voice: string; length: number; ms: number }): void {
  console.warn(`[tts] failed status=${f.status} provider=${f.provider} model=${f.model} voice=${f.voice} length=${f.length} after=${f.ms}ms`);
}

export function isFluxVoice(id: string | undefined): boolean {
  return Boolean(id && IDS.has(id));
}

/** The provider answered, but speech is not switched on for this account
 *  (Flux while its speech capability is dark). The next source can take over. */
export class SpeechUnavailable extends VoiceUnavailable {}

async function refusal(res: Response): Promise<{ message: string; code: string }> {
  try {
    const body: any = await res.json();
    const error = body?.error ?? body;
    return {
      message: (typeof error?.message === "string" && error.message.trim()) || "",
      code: (typeof error?.code === "string" && error.code) || "",
    };
  } catch {
    return { message: "", code: "" };
  }
}
const said = async (res: Response) => (await refusal(res)).message;

export async function synthesize(text: string, voice: string, endpoint: VoiceEndpoint | null, call: typeof fetch = fetch): Promise<Audio> {
  return (await synthesizeClip(text, voice, endpoint, false, call)) as Audio;
}

/** `streamed`: hand the audio on as it arrives (both Flux and OpenAI send
 *  it as it is made). */
export async function synthesizeClip(text: string, voice: string, endpoint: VoiceEndpoint | null, streamed: boolean, call: typeof fetch = fetch, retryMs = TTS_RETRY_MS): Promise<Clip> {
  if (!endpoint) throw new Error("Add a Flux key, or an OpenAI key, in Settings on the computer to turn on voice.");
  const provider = endpoint.via === "flux" ? "Flux" : "OpenAI";
  // An agent that still carries a voice from another engine gets Flux's
  // default rather than a 400 for a voice Flux has never heard of.
  // xAI's voices on Flux's xAI alias, OpenAI's everywhere else.
  const grok = endpoint.via === "flux" && endpoint.model === FLUX_GROK_MODEL;
  const chosen = grok ? (voice && XAI_IDS.has(voice) ? voice : "eve") : isFluxVoice(voice) ? voice : "marin";
  // A clip of a sentence or two that takes 20 s to START is already a failed
  // conversation; only longer clips (up to the route's 500) get 60 s. The
  // limit is for the response headers only: audio that is arriving is never
  // cut by it. The body has its own stall guard below.
  const short = text.length <= SHORT_CLIP_CHARS;
  const headerMs = short ? SHORT_CLIP_TIMEOUT_MS : LONG_CLIP_TIMEOUT_MS;
  const fail = (status: number | string, ms: number) =>
    logTtsFailure({ status, provider, model: endpoint.model, voice: chosen, length: text.length, ms });
  const unreachable = () => new Error(`Couldn't reach ${provider} to speak. Check your connection.`);
  const control = new AbortController();
  let res: Response | undefined;
  const requestedAt = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    const timer = setTimeout(() => control.abort(), headerMs);
    let retry = false;
    try {
      res = await call(`${baseFor(endpoint)}/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${endpoint.key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: endpoint.model, input: text, voice: chosen, response_format: "mp3" }),
        signal: control.signal,
      });
      clearTimeout(timer);
      if (res.status >= 500 && res.status !== 501) {
        fail(res.status, Date.now() - started);
        // one retry, and only for a failure that came back fast: the total
        // wait stays bounded
        retry = attempt === 0 && Date.now() - started <= RETRY_ONLY_IF_WITHIN_MS;
        if (retry) await res.body?.cancel().catch(() => undefined);
      }
    } catch (error) {
      clearTimeout(timer);
      const timedOut = control.signal.aborted;
      fail(timedOut ? "timeout" : "network", Date.now() - started);
      retry = attempt === 0 && !timedOut && Date.now() - started <= RETRY_ONLY_IF_WITHIN_MS;
      if (!retry) throw unreachable();
      res = undefined;
    }
    if (!retry) break;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  if (!res) throw unreachable();
  // 4xx and the rest: one line each, status only (never their words). 5xx
  // were logged where they happened.
  if (!res.ok && (res.status < 500 || res.status === 501)) fail(res.status, 0);
  if (res.status === 404) throw new SpeechUnavailable(`${provider} voices aren't switched on for this account yet.`);
  if (res.status === 403) {
    const theirs = await said(res);
    if (notPermitted(theirs)) throw new SpeechUnavailable(`${provider} voices aren't switched on for this key yet.`);
    throw new Error(`${provider} rejected the saved key. Paste a fresh one in Settings.`);
  }
  if (res.status === 401) throw new Error(`${provider} rejected the saved key. Paste a fresh one in Settings.`);
  if (res.status === 402) {
    // Flux: premium_locked is a plan without voices; any other 402 is the
    // balance or a budget on the key, which a plan change would not fix.
    const { message, code } = await refusal(res);
    if (endpoint.via !== "flux" || code === "premium_locked") throw new Error(`${provider} voices need a paid plan. The key is fine; the plan does not cover it yet.`);
    throw new Error(`${provider} couldn't charge for speech${message ? `: ${message}` : ""}. Check the account's balance and the key's budget.`);
  }
  if (res.status === 429) throw new RateLimitedError((await said(res)) || `${provider} is rate-limiting this account. Wait a moment and try again.`, retryAfterMs(res.headers.get("retry-after")));
  if (!res.ok) {
    const theirs = await said(res);
    throw new Error(theirs ? `Speaking failed: ${theirs}` : `Speaking failed (${res.status})`);
  }
  // A reply that is not audio (a proxy's error page, JSON sent with 200) must
  // never reach the player as if it were sound.
  const type = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "audio/mpeg";
  if (!type.startsWith("audio/")) {
    fail("not-audio", 0);
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Speaking failed: ${provider} sent something other than audio.`);
  }
  const headersMs = Date.now() - requestedAt;
  const reported = Number(res.headers.get("x-flux-ttfb-ms"));
  const clip = await clipFrom(guardBody(res, control, () => fail("body-stall", BODY_STALL_MS)), type, streamed);
  // the gateway's own first-byte time, next to ours (it is only trusted as a number)
  clip.timing = { headersMs, ...(endpoint.via === "flux" && res.headers.has("x-flux-ttfb-ms") && Number.isFinite(reported) && reported >= 0 ? { fluxTtfbMs: reported } : {}) };
  return clip;
}

/** The audio body, abandoned if no bytes arrive for BODY_STALL_MS. Time
 *  already spent waiting for headers does not count, and neither does a
 *  clip that simply takes long to play out: only silence on the wire. */
function guardBody(res: Response, control: AbortController, onStall: () => void): Response {
  const source = res.body;
  if (!source) return res;
  const reader = source.getReader();
  const guarded = new ReadableStream<Uint8Array>({
    async pull(out) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<"stalled">((resolve) => {
        timer = setTimeout(() => resolve("stalled"), BODY_STALL_MS);
      });
      try {
        const next = await Promise.race([reader.read(), stalled]);
        if (next === "stalled") {
          onStall();
          control.abort();
          void reader.cancel().catch(() => undefined);
          out.error(new Error("the voice service stopped sending audio"));
          return;
        }
        if (next.done) out.close();
        else out.enqueue(next.value);
      } catch (error) {
        out.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return new Response(guarded, { status: res.status, headers: res.headers });
}
