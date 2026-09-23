// Speech, not just sound: Silero VAD on the call's microphone.
//
// A call used to count anything loud enough as the owner talking, so a
// TradingView alert beep stopped the bot mid-sentence. Silero VAD is a small
// model (2 MB) trained to tell speech from everything else; LiveKit Agents
// and Pipecat both run it for exactly this. The model file is Silero's
// (github.com/snakers4/silero-vad, MIT). How it is run follows Pipecat's
// SileroOnnxModel (pipecat audio/vad/silero.py, BSD-2-Clause): 512-sample
// chunks at 16 kHz with the previous 64 samples prepended, the recurrent
// state carried from chunk to chunk, and reset every few seconds of silence
// so it cannot drift. Measured here: a 1 kHz beep 0.03, white noise 0.03,
// silence 0.00, a spoken sentence up to 1.00 (77% of chunks at or above the
// 0.7 threshold, the rest the gaps between words).
import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import mjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";

const CHUNK = 512;
const CONTEXT = 64;
const RATE = 16_000;
/** Pipecat's VAD_CONFIDENCE. */
export const SPEECH_CONFIDENCE = 0.7;
/** Pipecat resets the model state every 5 s; here after that much quiet. */
const RESET_AFTER_QUIET_CHUNKS = Math.round((5 * RATE) / CHUNK);

export class SileroVad {
  private state = new Float32Array(2 * 128);
  private context = new Float32Array(CONTEXT);
  private pending = new Float32Array(0);
  private quiet = 0;

  private constructor(private readonly session: ort.InferenceSession) {}

  /** Null when the model cannot run here; the caller keeps its level gate. */
  static async load(modelUrl = "/vad/silero_vad.onnx"): Promise<SileroVad | null> {
    try {
      // single-threaded: threads need cross-origin isolation this app does
      // not have, and one 32 ms chunk takes well under a millisecond
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
      const model = await fetch(modelUrl).then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`${res.status}`))));
      const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ["wasm"] });
      console.info("[call] speech detector ready (Silero VAD)");
      return new SileroVad(session);
    } catch (error) {
      // the call carries on with its loudness gate; say so where it can be seen
      console.warn(`[call] speech detector unavailable, using loudness: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** Speech probability for 16 kHz mono audio of any length: the highest
   *  of the whole chunks it completes (a partial chunk waits for the next
   *  call). */
  async push(samples: Float32Array): Promise<number> {
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    let best = 0;
    let at = 0;
    for (; at + CHUNK <= all.length; at += CHUNK) best = Math.max(best, await this.chunk(all.subarray(at, at + CHUNK)));
    this.pending = all.slice(at);
    return best;
  }

  private async chunk(chunk: Float32Array): Promise<number> {
    const input = new Float32Array(CONTEXT + CHUNK);
    input.set(this.context);
    input.set(chunk, CONTEXT);
    const out = await this.session.run({
      input: new ort.Tensor("float32", input, [1, CONTEXT + CHUNK]),
      state: new ort.Tensor("float32", this.state, [2, 1, 128]),
      sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(RATE)]), []),
    });
    this.state = new Float32Array(out.stateN.data as Float32Array);
    this.context = input.slice(CHUNK);
    const p = (out.output.data as Float32Array)[0] ?? 0;
    this.quiet = p < SPEECH_CONFIDENCE ? this.quiet + 1 : 0;
    if (this.quiet > RESET_AFTER_QUIET_CHUNKS) this.reset();
    return p;
  }

  reset() {
    this.state = new Float32Array(2 * 128);
    this.context = new Float32Array(CONTEXT);
    this.quiet = 0;
  }
}
