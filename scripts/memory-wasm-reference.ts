// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Writes server/memory/testdata/wasm-native-reference.json: the NATIVE executor's vectors (one window per model call)
// for the twenty-chunk sample the regular suite compares WebAssembly against. Run on a machine whose native binding
// loads, after preparing the model (scripts/qualify-memory-runtime.ts --prepare-model):
//
//   node scripts/memory-wasm-reference.ts [--model-directory <dir>]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryEmbeddings, type ModelManifest } from "../server/memory/embeddings.ts";
import { wasmParitySample } from "../server/memory/wasm-parity-corpus.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const at = args.indexOf("--model-directory");
const manifest = JSON.parse(readFileSync(join(repo, "shared/memory-model-manifest.json"), "utf8")) as ModelManifest;
const directory = resolve(at >= 0 ? args[at + 1] : join(repo, ".planning/memory-evidence/model"));
const sample = wasmParitySample();
const model = new MemoryEmbeddings(directory, manifest, { backend: "native", windowBatch: 1 });
try {
  const vectors: number[][] = [];
  for (let i = 0; i < sample.length; i += 16) vectors.push(...await model.embed(sample.slice(i, i + 16)));
  const round = (v: number[]) => v.map(n => Math.round(n * 1e6) / 1e6);
  writeFileSync(join(repo, "server/memory/testdata/wasm-native-reference.json"), JSON.stringify({
    model: manifest.model, revision: manifest.revision, backend: "native", windowBatch: 1, corpusSha256: createHash("sha256").update(JSON.stringify(sample)).digest("hex"), vectors: vectors.map(round),
  }) + "\n");
} finally { await model.close(); }
