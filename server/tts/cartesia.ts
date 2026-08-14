// Cartesia — the latency tier. Sonic's state-space architecture gives the
// lowest published time-to-first-byte of the hosted voices, at roughly a
// fifth of ElevenLabs' per-character cost, which makes it the one to pick
// for call mode when a bot is talking all turn.
//
// The API version is a dated header and the model ids are versioned
// (sonic-3.5, sonic-3, …). Both are config-overridable rather than baked:
// when Cartesia rolls either forward, a user can keep working by setting
// the new value, instead of waiting for a release. Same instinct as the
// unknown-driver shadow snapshot — drift should degrade, not brick.
import { providerMessage, safeJson, type TtsProvider, type TtsVoice } from "./types.ts";

const API = process.env.OMB_CARTESIA_API || "https://api.cartesia.ai";
const DEFAULT_VERSION = "2026-03-01";
const DEFAULT_MODEL = "sonic-3.5";

const headers = (key: string, version: string) => ({
  authorization: `Bearer ${key}`,
  "Cartesia-Version": version,
  "content-type": "application/json",
});

export const CartesiaProvider: TtsProvider = {
  id: "cartesia",
  displayName: "Cartesia",
  runsOn: "server",
  needsKey: true,
  blurb: "Fastest to first sound, and the cheapest hosted voice. Best for call mode.",

  async verifyKey(key) {
    try {
      const res = await fetch(`${API}/voices/?limit=1`, {
        headers: headers(key, DEFAULT_VERSION),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: "Cartesia rejected that key — copy a fresh one from your Cartesia dashboard." };
      }
      return { ok: false, message: providerMessage(res.status, "checking that key", await safeJson(res)) };
    } catch {
      return { ok: false, message: "Couldn't reach Cartesia to check that key — check your connection." };
    }
  },

  async listVoices(key) {
    const res = await fetch(`${API}/voices/?limit=100`, {
      headers: headers(key, DEFAULT_VERSION),
      signal: AbortSignal.timeout(20_000),
    });
    const body: any = await safeJson(res);
    if (!res.ok) throw new Error(providerMessage(res.status, "listing voices", body));
    // the listing is paginated ({data:[…]}) but has been a bare array too
    const rows: any[] = Array.isArray(body) ? body : (body?.data ?? body?.voices ?? []);
    return rows
      .map(
        (v: any): TtsVoice => ({
          id: String(v.id ?? ""),
          label: String(v.name ?? "Voice"),
          description: typeof v.description === "string" ? v.description.slice(0, 90) : undefined,
        }),
      )
      .filter((v) => v.id);
  },

  async synthesize({ text, voiceId, key, options }) {
    if (!voiceId) throw new Error("pick a voice in App Settings first");
    const res = await fetch(`${API}/tts/bytes`, {
      method: "POST",
      headers: headers(key, options?.version || DEFAULT_VERSION),
      body: JSON.stringify({
        model_id: options?.model || DEFAULT_MODEL,
        transcript: text,
        voice: { mode: "id", id: voiceId },
        output_format: { container: "mp3", sample_rate: 44100, bit_rate: 64000 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(providerMessage(res.status, "speaking", await safeJson(res)));
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: "audio/mpeg" };
  },
};
