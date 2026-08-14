// ElevenLabs — the quality tier. Flash v2.5 is the low-latency model
// (~75ms model inference); we ask for mp3 because the renderer plays it
// with a plain <audio> element and every browser decodes mp3.
//
// One utterance per request, not the streaming-input WebSocket: the client
// already splits into utterances and prefetches the next while the current
// one plays, which gets the same perceived latency with a fraction of the
// moving parts — and a socket held open across a turn is one more thing to
// leak when a turn is interrupted.
import { providerMessage, safeJson, type TtsProvider, type TtsVoice } from "./types.ts";

const API = process.env.OMB_ELEVENLABS_API || "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL = "eleven_flash_v2_5";
// 64kbps mono is indistinguishable for speech and a third of the bytes
const DEFAULT_FORMAT = "mp3_44100_64";

export const ElevenLabsProvider: TtsProvider = {
  id: "elevenlabs",
  displayName: "ElevenLabs",
  runsOn: "server",
  needsKey: true,
  blurb: "The most expressive voices. Needs an ElevenLabs key; billed per character.",

  async verifyKey(key) {
    try {
      const res = await fetch(`${API}/user`, {
        headers: { "xi-api-key": key },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return { ok: true };
      const body = await safeJson(res);
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          message: "ElevenLabs rejected that key — copy a fresh one from your ElevenLabs profile.",
        };
      }
      return { ok: false, message: providerMessage(res.status, "checking that key", body) };
    } catch {
      return { ok: false, message: "Couldn't reach ElevenLabs to check that key — check your connection." };
    }
  },

  async listVoices(key) {
    const res = await fetch(`${API}/voices`, {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(20_000),
    });
    const body: any = await safeJson(res);
    if (!res.ok) throw new Error(providerMessage(res.status, "listing voices", body));
    const voices: TtsVoice[] = (body?.voices ?? []).map((v: any) => ({
      id: String(v.voice_id ?? v.voiceId ?? ""),
      label: String(v.name ?? "Voice"),
      description: [v.labels?.accent, v.labels?.description].filter(Boolean).join(" · ") || undefined,
    }));
    return voices.filter((v) => v.id);
  },

  async synthesize({ text, voiceId, key, options }) {
    if (!voiceId) throw new Error("pick a voice in App Settings first");
    const model = options?.model || DEFAULT_MODEL;
    const format = options?.format || DEFAULT_FORMAT;
    const res = await fetch(
      `${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(format)}`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: model }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) throw new Error(providerMessage(res.status, "speaking", await safeJson(res)));
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: "audio/mpeg" };
  },
};
