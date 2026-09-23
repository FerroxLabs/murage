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
import type { Audio, Voice } from "./elevenlabs.ts";
import type { VoiceEndpoint } from "../voice/voice-routes.ts";

/** A test seam for the Flux base only; production uses the resolved route. */
function baseFor(endpoint: VoiceEndpoint): string {
  const stub = endpoint.via === "flux" ? process.env.MURAGE_FLUX_AUDIO_API : undefined;
  return (stub || endpoint.baseUrl).replace(/\/+$/, "");
}

/** The voices Flux offers on `flux-voice-speak` (OpenAI's list). */
export const FLUX_VOICES: Voice[] = [
  { id: "marin", label: "Marin", description: "Natural, warm" },
  { id: "cedar", label: "Cedar", description: "Natural, grounded" },
  { id: "alloy", label: "Alloy", description: "Neutral, balanced" },
  { id: "ash", label: "Ash", description: "Clear, confident" },
  { id: "ballad", label: "Ballad", description: "Soft, expressive" },
  { id: "coral", label: "Coral", description: "Bright, friendly" },
  { id: "echo", label: "Echo", description: "Calm, even" },
  { id: "fable", label: "Fable", description: "Storyteller, British" },
  { id: "nova", label: "Nova", description: "Upbeat, energetic" },
  { id: "onyx", label: "Onyx", description: "Deep, steady" },
  { id: "sage", label: "Sage", description: "Measured, thoughtful" },
  { id: "shimmer", label: "Shimmer", description: "Light, clear" },
  { id: "verse", label: "Verse", description: "Expressive, dynamic" },
];

const IDS = new Set(FLUX_VOICES.map((v) => v.id));

export function isFluxVoice(id: string | undefined): boolean {
  return Boolean(id && IDS.has(id));
}

async function said(res: Response): Promise<string> {
  try {
    const body: any = await res.json();
    const error = body?.error ?? body;
    return (typeof error?.message === "string" && error.message.trim()) || "";
  } catch {
    return "";
  }
}

export async function synthesize(text: string, voice: string, endpoint: VoiceEndpoint | null, call: typeof fetch = fetch): Promise<Audio> {
  if (!endpoint) throw new Error("Add a Flux key, or an OpenAI key, in Settings on the computer to turn on voice.");
  const provider = endpoint.via === "flux" ? "Flux" : "OpenAI";
  // An agent that still carries a voice from another engine gets Flux's
  // default rather than a 400 for a voice Flux has never heard of.
  const chosen = isFluxVoice(voice) ? voice : "marin";
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
  if (res.status === 404) throw new Error(`${provider} voices aren't switched on for this account yet.`);
  if (res.status === 401 || res.status === 403) throw new Error(`${provider} rejected the saved key. Paste a fresh one in Settings.`);
  if (res.status === 402) throw new Error(`${provider} voices need a paid plan. The key is fine; the plan does not cover it yet.`);
  if (res.status === 429) throw new Error((await said(res)) || `${provider} is rate-limiting this account. Wait a moment and try again.`);
  if (!res.ok) {
    const theirs = await said(res);
    throw new Error(theirs ? `Speaking failed: ${theirs}` : `Speaking failed (${res.status})`);
  }
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: "audio/mpeg" };
}
