// Speech through Flux Router, on the workspace's own Flux key.
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
// Runs on the HARNESS only: the key must not leave the server.
import { fluxKey } from "../flux-config.ts";
import type { Audio, Voice } from "./elevenlabs.ts";

function apiBase(): string {
  return (process.env.MURAGE_FLUX_AUDIO_API || "https://api.fluxrouter.ai/v1").replace(/\/+$/, "");
}

const MODEL = "flux-voice-speak";

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

export async function synthesize(text: string, voice: string, env: NodeJS.ProcessEnv = process.env, call: typeof fetch = fetch): Promise<Audio> {
  const key = fluxKey(env);
  if (!key) throw new Error("Add a Flux key in Settings on the computer to turn on voice.");
  // An agent that still carries a voice from another engine gets Flux's
  // default rather than a 400 for a voice Flux has never heard of.
  const chosen = isFluxVoice(voice) ? voice : "marin";
  let res: Response;
  try {
    res = await call(`${apiBase()}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: text, voice: chosen, response_format: "mp3" }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("Couldn't reach Flux to speak. Check your connection.");
  }
  if (res.status === 404) throw new Error("Flux voices aren't switched on for this account yet.");
  if (res.status === 401 || res.status === 403) throw new Error("Flux rejected the workspace key. Paste a fresh one in Settings.");
  if (res.status === 402) throw new Error("Flux voices need a paid Flux plan. The key is fine; the plan does not cover it yet.");
  if (res.status === 429) throw new Error((await said(res)) || "Flux is rate-limiting this account. Wait a moment and try again.");
  if (!res.ok) {
    const theirs = await said(res);
    throw new Error(theirs ? `Speaking failed: ${theirs}` : `Speaking failed (${res.status})`);
  }
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: "audio/mpeg" };
}
