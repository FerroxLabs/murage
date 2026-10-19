// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Backend selection for the local memory model: native where the pinned binding ships, ONNX Runtime WebAssembly
// where it does not (Intel macOS), and the same vectors from both. Real inference on the tiny local fixture model.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { MemoryEmbeddings, supportsNativeMemoryModel } from "./embeddings.ts";
import { nativeBindingShipped, wasmRuntimeAvailable, wasmRuntimeDirectory } from "./embedding-runtime.ts";
import { writeTinyModel } from "./tiny-model-fixture.ts";
import type { ModelManifest } from "./embeddings.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
let root = "", manifest: ModelManifest;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "murage-embed-backend-")); manifest = writeTinyModel(join(root, "model")); });
afterAll(() => removeTempDirSync(root));
afterEach(() => vi.unstubAllGlobals());
const cosine = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0) / Math.sqrt(a.reduce((s, v) => s + v * v, 0) * b.reduce((s, v) => s + v * v, 0));
const texts = ["How are backups made?", "database recovery every night", "save copies frequently", "unknown words only here"];

it("reports the model as runnable wherever the native binding ships or the WebAssembly runtime is present", () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["linux", "x64"], ["win32", "x64"]] as const) {
    expect(nativeBindingShipped(platform, arch)).toBe(true);
    expect(supportsNativeMemoryModel(platform, arch, () => false)).toBe(true);
  }
  expect(nativeBindingShipped("darwin", "x64")).toBe(false);
  expect(supportsNativeMemoryModel("darwin", "x64", () => true)).toBe(true);
  // Keyword-only remains only where neither executor exists.
  expect(supportsNativeMemoryModel("darwin", "x64", () => false)).toBe(false);
  // A checkout carries the pinned onnxruntime-web, so the WebAssembly path is available here.
  expect(wasmRuntimeDirectory()).not.toBeNull();
  expect(wasmRuntimeAvailable()).toBe(true);
});

it("runs native where the binding ships, WebAssembly on request, and both give the same vectors", async () => {
  const native = new MemoryEmbeddings(join(root, "model"), manifest);
  const wasm = new MemoryEmbeddings(join(root, "model"), manifest, { backend: "wasm" });
  try {
    expect(native.backend).toBe("native");
    const a = await native.embed(texts), b = await wasm.embed(texts);
    expect(native.backend).toBe("native");
    expect(wasm.backend).toBe("wasm");
    expect(b).toHaveLength(texts.length);
    for (let i = 0; i < texts.length; i++) {
      expect(b[i]).toHaveLength(manifest.dimensions);
      expect(cosine(a[i], b[i])).toBeGreaterThanOrEqual(0.999999);
    }
  } finally { await native.close(); await wasm.close(); }
});

it("on Intel macOS goes straight to WebAssembly and never imports the native runtime", async () => {
  const actual = process;
  vi.stubGlobal("process", new Proxy(actual, { get(target, key) { return key === "platform" ? "darwin" : key === "arch" ? "x64" : Reflect.get(target, key, target); } }));
  const intel = new MemoryEmbeddings(join(root, "model"), manifest);
  try {
    expect(intel.backend).toBe("wasm");
    const [vector] = await intel.embed(["database backups"]);
    expect(intel.backend).toBe("wasm");
    expect(vector).toHaveLength(manifest.dimensions);
  } finally { await intel.close(); }
});

it("still refuses an altered model on the WebAssembly path before anything loads", async () => {
  const altered = { ...manifest, files: manifest.files.map((file, i) => i === 0 ? { ...file, sha256: "0".repeat(64) } : file) };
  const model = new MemoryEmbeddings(join(root, "model"), altered, { backend: "wasm" });
  await expect(model.embed(["query"])).rejects.toThrow("MEMORY_MODEL_UNVERIFIED");
});
