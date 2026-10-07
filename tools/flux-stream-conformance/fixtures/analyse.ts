// tools/flux-stream-conformance/fixtures/analyse.ts
// Speech timing for fixture audio: where the voice starts and stops, in ms.
// Energy only (10 ms windows, RMS over 0.01): fixtures are clean synthetic
// speech, and the numbers must be reproducible on any machine.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RATE = 16_000;
const WINDOW = 160; // 10 ms
const THRESHOLD = 0.01;
const JOIN_GAP_MS = 300;

export function speechSegments(pcm: Int16Array, rate = RATE): Array<[number, number]> {
  const window = Math.round((WINDOW * rate) / RATE);
  const ms = (samples: number) => Math.round((samples * 1000) / rate);
  const segments: Array<[number, number]> = [];
  let start = -1;
  let lastVoiced = -1;
  for (let i = 0; i < pcm.length; i += window) {
    let sum = 0;
    const end = Math.min(pcm.length, i + window);
    for (let j = i; j < end; j += 1) sum += (pcm[j] / 32768) ** 2;
    const voiced = Math.sqrt(sum / (end - i)) > THRESHOLD;
    if (voiced) {
      if (start < 0) start = i;
      else if (ms(i - lastVoiced) > JOIN_GAP_MS) {
        segments.push([ms(start), ms(lastVoiced)]);
        start = i;
      }
      lastVoiced = end;
    }
  }
  if (start >= 0) segments.push([ms(start), ms(lastVoiced)]);
  return segments;
}

/** The PCM payload of a WAV file, found by walking its RIFF chunks. */
export function wavData(buf: Buffer): { rate: number; channels: number; bits: number; data: Buffer } {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === "data") {
      if (!fmt) throw new Error("WAV data chunk before its fmt chunk");
      if (fmt.format !== 1) throw new Error(`WAV is not PCM (format ${fmt.format})`);
      return { rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, data: buf.subarray(body, Math.min(buf.length, body + size)) };
    }
    at = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** Test helper: 440 Hz tone and digital silence, in ms. */
export function toneAndSilence(parts: Array<["tone" | "silence", number]>, rate = RATE): Int16Array {
  const total = parts.reduce((n, [, d]) => n + Math.round((d * rate) / 1000), 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const [kind, d] of parts) {
    const n = Math.round((d * rate) / 1000);
    if (kind === "tone") for (let i = 0; i < n; i += 1) out[at + i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * 32767);
    at += n;
  }
  return out;
}

export interface Fixture {
  id: string;
  text: string;
  segments_text: string[];
  expected_turns: number;
  class: "plain" | "pause" | "long" | "silence";
  speech_segments: Array<[number, number]>;
  speech_end_ms: number;
  duration_ms: number;
  sha256: string;
  keyterms?: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export function loadFixtures(dir = here): Array<Fixture & { pcm: Buffer }> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Fixture[];
  return manifest.map((f) => {
    const pcm = readFileSync(join(dir, `${f.id}.pcm`));
    if (sha(pcm) !== f.sha256) throw new Error(`fixture ${f.id} does not match its manifest hash`);
    return { ...f, pcm };
  });
}

// CLI:
//   analyse.ts <file.pcm>                  prints the segments
//   analyse.ts --extract <in.wav> <out.pcm> writes the PCM and prints the segments
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2]) {
  let raw: Buffer;
  if (process.argv[2] === "--extract") {
    const wav = wavData(readFileSync(process.argv[3]));
    if (wav.rate !== RATE || wav.channels !== 1 || wav.bits !== 16 || wav.data.length % 2) throw new Error(`unexpected WAV layout ${JSON.stringify({ ...wav, data: wav.data.length })}`);
    raw = Buffer.from(wav.data);
    writeFileSync(process.argv[4], raw);
  } else {
    raw = readFileSync(process.argv[2]);
  }
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const segments = speechSegments(pcm);
  process.stdout.write(`${JSON.stringify({ segments, speech_end_ms: segments.at(-1)?.[1] ?? 0, duration_ms: Math.round((pcm.length * 1000) / RATE), sha256: sha(raw) })}\n`);
}
