// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Native vs WebAssembly parity and throughput for the pinned local memory model, on a machine that has both
// (Linux x64, Apple Silicon, Windows x64). Same verified files, same MemoryEmbeddings code; only the executor differs.
//
//   node scripts/qualify-memory-runtime.ts --prepare-model --allow-download --destination "$PWD/.planning/memory-evidence/model"
//   node scripts/memory-wasm-parity.ts [--model-directory <dir>] [--out <file.json>]
//
// Two modes. "production": windows go through the model 16 at a time, exactly as the worker indexes. "isolated": one
// window per model call, so every vector depends on its own text only. The pinned model is dynamically quantized
// (q8): each call picks its quantization scale from the whole batch, so a vector moves with its batch neighbours, and
// the isolated mode is the like-for-like comparison of the two executors. The native executor's own batch effect
// (production vs isolated, native both times) is reported as the noise floor the comparison sits against.
//
// Exits 1 unless, in isolated mode, the mean cosine is at least 0.999 and no vector differs from its native twin by
// more than native differs from itself between the two batchings.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chunksFor } from "../server/memory/chunks.ts";
import { MemoryEmbeddings, type ModelManifest } from "../server/memory/embeddings.ts";
import { cosine, wasmParityCorpus } from "../server/memory/wasm-parity-corpus.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const manifest = JSON.parse(readFileSync(join(repo, "shared/memory-model-manifest.json"), "utf8")) as ModelManifest;
const directory = resolve(option("--model-directory", join(repo, ".planning/memory-evidence/model"))!);
const corpus = wasmParityCorpus();
const windows = corpus.reduce((sum, text) => sum + chunksFor(text, 0, 120).length, 0);

async function run(backend: "native" | "wasm", windowBatch: number) {
  const model = new MemoryEmbeddings(directory, manifest, { backend, windowBatch });
  try {
    await model.embed(["warm-up"]);
    if (model.backend !== backend) throw new Error(`asked for ${backend}, loaded ${model.backend}`);
    const vectors: number[][] = [];
    const started = performance.now();
    for (let i = 0; i < corpus.length; i += 16) vectors.push(...await model.embed(corpus.slice(i, i + 16)));
    const seconds = (performance.now() - started) / 1000;
    // One record per call: how long a waiting query can sit behind one index slice on this executor.
    const single: number[] = [];
    for (const text of corpus.slice(0, 80)) { const at = performance.now(); await model.embed([text]); single.push(performance.now() - at); }
    single.sort((a, b) => a - b);
    return { vectors, timing: { seconds, chunksPerSecond: corpus.length / seconds, windowsPerSecond: windows / seconds,
      oneRecordMs: { median: single[Math.floor(single.length / 2)], p95: single[Math.floor(single.length * 0.95)], max: single.at(-1)! } } };
  } finally { await model.close(); }
}
const compare = (a: number[][], b: number[][]) => {
  const values = a.map((vector, i) => cosine(vector, b[i]));
  return { values, min: Math.min(...values), mean: values.reduce((x, y) => x + y, 0) / values.length, below0999: values.filter(v => !(v >= 0.999)).length };
};
const summary = ({ values: _values, ...rest }: ReturnType<typeof compare>) => rest;

const nativeProduction = await run("native", 16), wasmProduction = await run("wasm", 16);
const nativeIsolated = await run("native", 1), wasmIsolated = await run("wasm", 1);
const production = compare(nativeProduction.vectors, wasmProduction.vectors);
const isolated = compare(nativeIsolated.vectors, wasmIsolated.vectors);
const nativeBatchEffect = compare(nativeProduction.vectors, nativeIsolated.vectors);
const withinNoise = isolated.values.every(v => v >= nativeBatchEffect.min);
const result = {
  model: `${manifest.model}@${manifest.revision}`, node: process.version, platform: process.platform, arch: process.arch, cpus: cpus().length,
  chunks: corpus.length, distinct: new Set(corpus).size, modelWindows: windows,
  bytes: { min: Math.min(...corpus.map(t => Buffer.byteLength(t))), max: Math.max(...corpus.map(t => Buffer.byteLength(t))) },
  parity: { isolated: summary(isolated), production: summary(production), nativeBatchEffect: summary(nativeBatchEffect), isolatedWithinNativeNoise: withinNoise },
  throughput: { native: nativeProduction.timing, wasm: wasmProduction.timing, nativeIsolated: nativeIsolated.timing, wasmIsolated: wasmIsolated.timing,
    wasmSlowdown: nativeProduction.timing.chunksPerSecond / wasmProduction.timing.chunksPerSecond },
};
const out = option("--out");
if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(resolve(out), JSON.stringify(result, null, 2) + "\n"); }
console.log(JSON.stringify(result, null, 2));
if (corpus.length < 200 || isolated.mean < 0.999 || !withinNoise) process.exitCode = 1;
