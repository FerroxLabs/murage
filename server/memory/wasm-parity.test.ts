// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The pinned multilingual model gives the same vectors on ONNX Runtime WebAssembly (Intel macOS) as on the native
// binding. Two tests, one bar. Runs where the pinned model is prepared (CI prepares it before tests:
// scripts/qualify-memory-runtime.ts --prepare-model); scripts/memory-wasm-parity.ts is the fuller report.
//   - Regular suite: 20 varied chunks on WebAssembly against STORED native vectors (testdata/wasm-native-reference.json,
//     written by scripts/memory-wasm-reference.ts), so the suite does not run the native executor.
//   - Nightly (about a minute): 200 varied chunks, native and WebAssembly both run live.
//
// What "the same" can mean for this model: it is dynamically quantized (q8), so every model call picks its
// quantization scale from the whole batch it was given. The native executor itself moves a vector by more than
// 0.001 cosine when only its batch neighbours change (to 0.978 over this corpus). The executors are compared like
// for like (one window per call): mean cosine at least 0.999 and no vector below 0.99.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { MemoryEmbeddings, type ModelManifest } from "./embeddings.ts";
import { cosine, wasmParityCorpus, wasmParitySample } from "./wasm-parity-corpus.ts";

const manifest = JSON.parse(readFileSync(resolve("shared/memory-model-manifest.json"), "utf8")) as ModelManifest;
const directory = resolve(".planning/memory-evidence/model");
const prepared = manifest.files.every(file => existsSync(join(directory, file.path)));

async function vectors(backend: "native" | "wasm", windowBatch: number, corpus: string[]) {
  const model = new MemoryEmbeddings(directory, manifest, { backend, windowBatch });
  try {
    const out: number[][] = [];
    for (let i = 0; i < corpus.length; i += 16) out.push(...await model.embed(corpus.slice(i, i + 16)));
    expect(model.backend).toBe(backend);
    return out;
  } finally { await model.close(); }
}

function expectParity(native: number[][], wasm: number[][]) {
  const parity = native.map((vector, i) => cosine(vector, wasm[i]));
  const mean = parity.reduce((a, b) => a + b, 0) / parity.length;
  expect(mean).toBeGreaterThanOrEqual(0.999);
  expect(Math.min(...parity)).toBeGreaterThan(0.99);
  for (const vector of wasm) { expect(vector).toHaveLength(manifest.dimensions); expect(Math.abs(Math.hypot(...vector) - 1)).toBeLessThan(1e-5); }
}

it.runIf(prepared)("WebAssembly vectors match stored native ones over 20 varied chunks", { timeout: 120_000 }, async () => {
  const reference = JSON.parse(readFileSync(resolve("server/memory/testdata/wasm-native-reference.json"), "utf8"));
  const sample = wasmParitySample();
  expect(sample).toHaveLength(20);
  expect(reference).toMatchObject({ model: manifest.model, revision: manifest.revision, backend: "native", windowBatch: 1 });
  expect(reference.corpusSha256).toBe(createHash("sha256").update(JSON.stringify(sample)).digest("hex"));
  expect(reference.vectors).toHaveLength(20);
  expectParity(reference.vectors, await vectors("wasm", 1, sample));
});

it.runIf(prepared)("WebAssembly vectors match native ones over 200 varied chunks", { tags: ["nightly"], timeout: 900_000 }, async () => {
  const corpus = wasmParityCorpus(200);
  expect(new Set(corpus).size).toBe(200);
  expectParity(await vectors("native", 1, corpus), await vectors("wasm", 1, corpus));
});
