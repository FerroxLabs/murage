// Speech with xAI's own voices (Grok voices), on an owner's xAI key.
//
// xAI's text-to-speech (POST /v1/tts) returns mp3 for one piece of text in
// one of its voices: measured 2026-09-23, first audio in 0.27 s and a
// 90-character sentence in 1.1 s, $15 per million characters. One request
// per sentence, the same shape as the other voice services here.
//
// Runs on the HARNESS only: the key must not leave the server.
import { clipFrom, type Audio, type Clip, type Voice } from "./elevenlabs.ts";

export interface XaiSpeechEndpoint {
  baseUrl: string;
  key: string;
}

/** xAI's built-in voices (GET /v1/tts/voices, 2026-09-23). The list is
 *  static so the settings panel needs no network call to show it. */
export const XAI_VOICES: Voice[] = [
  "eve", "ara", "leo", "rex", "sal", "altair", "atlas", "aurora", "carina", "castor", "celeste", "cosmo", "helios", "helix",
  "iris", "kepler", "liora", "lumen", "luna", "lux", "naksh", "orion", "perseus", "rigel", "sirius", "ursa", "zagan", "zenith",
].map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));

const IDS = new Set(XAI_VOICES.map((v) => v.id));

export async function synthesize(text: string, voice: string | undefined, endpoint: XaiSpeechEndpoint | null, call: typeof fetch = fetch): Promise<Audio> {
  return (await synthesizeClip(text, voice, endpoint, false, call)) as Audio;
}

/** `streamed`: hand the audio on as it arrives; xAI sends it as it is made. */
export async function synthesizeClip(text: string, voice: string | undefined, endpoint: XaiSpeechEndpoint | null, streamed: boolean, call: typeof fetch = fetch): Promise<Clip> {
  if (!endpoint) throw new Error("Connect an xAI key in Settings on the computer to use xAI voices.");
  // a voice from another service falls back to xAI's default voice
  const chosen = voice && IDS.has(voice) ? voice : "eve";
  let res: Response;
  try {
    res = await call(`${endpoint.baseUrl.replace(/\/+$/, "")}/tts`, {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.key}`, "content-type": "application/json" },
      body: JSON.stringify({ text, voice_id: chosen, language: "en" }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("Couldn't reach xAI to speak. Check your connection.");
  }
  if (res.status === 401 || res.status === 403) throw new Error("xAI rejected the saved key. Paste a fresh one in Settings.");
  if (res.status === 429) throw new Error("xAI is rate-limiting this account. Wait a moment and try again.");
  if (!res.ok) throw new Error(`Speaking failed (${res.status})`);
  return clipFrom(res, res.headers.get("content-type") || "audio/mpeg", streamed);
}
