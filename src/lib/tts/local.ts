// The local voice — Kokoro-82M, in this window.
//
// It lives in the renderer rather than the harness for two reasons. There
// is no key to protect, so the server-side rule that exists for hosted
// voices does not apply; and electron-builder ships the app with
// `!**/node_modules/**`, so anything the main process or the compiled
// server imports has to survive that exclusion — while the renderer's
// dependencies are bundled by Vite into dist/, which is shipped whole as
// Resources/ui. The model is the one dependency that cannot walk into the
// packaging trap.
//
// Everything here is behind a dynamic import: kokoro-js pulls in
// transformers.js and an ONNX runtime, which is a large chunk nobody who
// never presses "speak" should pay for. Vite splits it automatically.

/** ~86MB of weights at fp32; q8 is a quarter of that and, for a narrator
 * voice at 24kHz, indistinguishable in listening. */
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8";

export interface LocalVoice {
  id: string;
  label: string;
  description?: string;
}

export type LoadProgress = { status: "downloading"; percent: number } | { status: "ready" } | { status: "failed"; error: string };

type Kokoro = {
  generate(text: string, opts?: { voice?: string; speed?: number }): Promise<{ toBlob(): Blob }>;
  voices: Record<string, { name?: string; language?: string; gender?: string; traits?: string; overallGrade?: string }>;
};

let loading: Promise<Kokoro> | null = null;
let loaded: Kokoro | null = null;
const watchers = new Set<(p: LoadProgress) => void>();

function announce(progress: LoadProgress) {
  for (const watcher of [...watchers]) watcher(progress);
}

/** Subscribe to first-run model download progress. */
export function onLocalVoiceProgress(fn: (p: LoadProgress) => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

export function localVoiceReady(): boolean {
  return loaded !== null;
}

/** WebGPU is 2-10x faster than the WASM fallback, but it is not everywhere
 * and a failed device is worse than a slow one — so it is a preference,
 * not a requirement. */
async function pickDevice(): Promise<"webgpu" | "wasm"> {
  try {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu && (await gpu.requestAdapter())) return "webgpu";
  } catch {
    /* fall through to wasm */
  }
  return "wasm";
}

/**
 * Load the model once per window.
 *
 * The weights come from the Hugging Face hub on first use and are cached by
 * transformers.js in the browser Cache API — so it is one download, then
 * offline forever. That is the honest cost of not shipping an OS voice, and
 * why callers get progress to show rather than a spinner that lies.
 */
export function loadLocalVoice(): Promise<Kokoro> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= (async () => {
    try {
      const { KokoroTTS } = await import("kokoro-js");
      const device = await pickDevice();
      const model = (await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: DTYPE,
        device,
        progress_callback: (p: { status?: string; progress?: number }) => {
          if (p?.status === "progress" && typeof p.progress === "number") {
            announce({ status: "downloading", percent: Math.round(p.progress) });
          }
        },
      })) as unknown as Kokoro;
      loaded = model;
      announce({ status: "ready" });
      return model;
    } catch (e) {
      // a failed load must not poison the singleton — the next attempt
      // (a better network, a working GPU) deserves a clean try
      loading = null;
      const error = e instanceof Error ? e.message : String(e);
      announce({ status: "failed", error });
      throw new Error(`couldn't load the local voice: ${error}`);
    }
  })();
  return loading;
}

/**
 * The voices the local model ships.
 *
 * Held here rather than read from the package because kokoro-js exports
 * only `KokoroTTS`, `TextSplitterStream` and `env` from its entry point —
 * its VOICES table is a private submodule. Which is just as well: the
 * picker has to list voices BEFORE the weights are fetched (you choose a
 * voice, then it downloads), and this is metadata, not a model. Once the
 * model is loaded its own catalog wins, so a version that adds voices is
 * not capped by this list.
 *
 * The ids come from the installed package's own type declarations.
 */
const LOCAL_VOICES: Array<[string, string, string]> = [
  ["af_heart", "Heart", "American · female · the default"],
  ["af_bella", "Bella", "American · female"],
  ["af_nicole", "Nicole", "American · female · soft"],
  ["af_aoede", "Aoede", "American · female"],
  ["af_kore", "Kore", "American · female"],
  ["af_sarah", "Sarah", "American · female"],
  ["af_sky", "Sky", "American · female"],
  ["af_nova", "Nova", "American · female"],
  ["af_alloy", "Alloy", "American · female"],
  ["af_jessica", "Jessica", "American · female"],
  ["af_river", "River", "American · female"],
  ["am_michael", "Michael", "American · male"],
  ["am_fenrir", "Fenrir", "American · male"],
  ["am_puck", "Puck", "American · male"],
  ["am_adam", "Adam", "American · male"],
  ["am_echo", "Echo", "American · male"],
  ["am_eric", "Eric", "American · male"],
  ["am_liam", "Liam", "American · male"],
  ["am_onyx", "Onyx", "American · male"],
  ["am_santa", "Santa", "American · male"],
  ["bf_emma", "Emma", "British · female"],
  ["bf_isabella", "Isabella", "British · female"],
  ["bf_alice", "Alice", "British · female"],
  ["bf_lily", "Lily", "British · female"],
  ["bm_george", "George", "British · male"],
  ["bm_fable", "Fable", "British · male"],
  ["bm_daniel", "Daniel", "British · male"],
  ["bm_lewis", "Lewis", "British · male"],
];

/** Cheap on purpose: listing voices must never pull the model in. */
export function listLocalVoices(): LocalVoice[] {
  if (loaded?.voices) {
    const live = Object.entries(loaded.voices);
    if (live.length) {
      return live.map(([id, v]) => ({
        id,
        label: v.name ?? id,
        description: [v.language, v.gender, v.traits].filter(Boolean).join(" · ") || undefined,
      }));
    }
  }
  return LOCAL_VOICES.map(([id, label, description]) => ({ id, label, description }));
}

/** Kokoro's default and best-graded voice. */
export const DEFAULT_LOCAL_VOICE = "af_heart";

export async function synthesizeLocal(text: string, voiceId?: string): Promise<Blob> {
  const model = await loadLocalVoice();
  const voice = voiceId && voiceId in model.voices ? voiceId : DEFAULT_LOCAL_VOICE;
  const audio = await model.generate(text, { voice });
  return audio.toBlob();
}
