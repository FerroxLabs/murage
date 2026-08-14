// Kokoro — the default voice, and the reason voice is not a paid feature.
//
// An 82M-parameter StyleTTS2-class model under Apache-2.0 that runs
// entirely in the app's own renderer on WebGPU (WASM fallback). It is not
// an OS voice: it topped TTS Arena and scores level with the hosted APIs
// on UTMOS. Its known weakness is a flat emotional range — which is
// exactly right for a digest read in the kitchen, and exactly why call
// mode is worth a hosted key if you want each bot to sound like someone.
//
// There is no server implementation here on purpose. Synthesis happens in
// src/lib/tts/local.ts; this record exists so the provider shows up in the
// registry, the settings panel and /api/tts/providers like any other, with
// runsOn:"client" telling the renderer to handle it itself.
import type { TtsProvider } from "./types.ts";

export const KokoroProvider: TtsProvider = {
  id: "kokoro",
  displayName: "Kokoro (on this computer)",
  runsOn: "client",
  needsKey: false,
  blurb: "Runs on your machine. No key, no cost, works offline after a one-time download.",
};
