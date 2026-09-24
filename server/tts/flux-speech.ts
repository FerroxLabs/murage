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

/** The voices Flux offers on `flux-voice-speak` (OpenAI's list). OpenAI does
 *  not publish genders; these are how each voice commonly sounds. */
export const FLUX_VOICES: Voice[] = ([
  ["marin", "Marin", "natural and warm", "female"],
  ["cedar", "Cedar", "natural and grounded", "male"],
  ["alloy", "Alloy", "even and balanced", "neutral"],
  ["ash", "Ash", "clear and confident", "male"],
  ["ballad", "Ballad", "soft and expressive", "male"],
  ["coral", "Coral", "bright and friendly", "female"],
  ["echo", "Echo", "calm and even", "male"],
  ["fable", "Fable", "British storyteller", "male"],
  ["nova", "Nova", "upbeat and energetic", "female"],
  ["onyx", "Onyx", "deep and steady", "male"],
  ["sage", "Sage", "measured and thoughtful", "female"],
  ["shimmer", "Shimmer", "light and clear", "female"],
  ["verse", "Verse", "expressive and lively", "male"],
] as const).map(([id, label, description, gender]) => ({ id, label, description, gender, provider: "openai" as const }));

const IDS = new Set(FLUX_VOICES.map((v) => v.id));

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
export async function synthesizeClip(text: string, voice: string, endpoint: VoiceEndpoint | null, streamed: boolean, call: typeof fetch = fetch): Promise<Clip> {
  if (!endpoint) throw new Error("Add a Flux key, or an OpenAI key, in Settings on the computer to turn on voice.");
  const provider = endpoint.via === "flux" ? "Flux" : "OpenAI";
  // An agent that still carries a voice from another engine gets Flux's
  // default rather than a 400 for a voice Flux has never heard of.
  // xAI's voices on Flux's xAI alias, OpenAI's everywhere else.
  const grok = endpoint.via === "flux" && endpoint.model === FLUX_GROK_MODEL;
  const chosen = grok ? (voice && XAI_IDS.has(voice) ? voice : "eve") : isFluxVoice(voice) ? voice : "marin";
  let res: Response;
  try {
    res = await call(`${baseFor(endpoint)}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: endpoint.model, input: text, voice: chosen, response_format: "mp3" }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error(`Couldn't reach ${provider} to speak. Check your connection.`);
  }
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
  if (res.status === 429) throw new Error((await said(res)) || `${provider} is rate-limiting this account. Wait a moment and try again.`);
  if (!res.ok) {
    const theirs = await said(res);
    throw new Error(theirs ? `Speaking failed: ${theirs}` : `Speaking failed (${res.status})`);
  }
  // A reply that is not audio (a proxy's error page, JSON sent with 200) must
  // never reach the player as if it were sound.
  const type = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "audio/mpeg";
  if (!type.startsWith("audio/")) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Speaking failed: ${provider} sent something other than audio.`);
  }
  return clipFrom(res, type, streamed);
}
