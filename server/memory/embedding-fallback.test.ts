// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A native binding that fails to load (a missing system library, a damaged install) falls back to ONNX Runtime
// WebAssembly instead of leaving memory keyword-only. Real WebAssembly inference on the tiny fixture model.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { writeTinyModel } from "./tiny-model-fixture.ts";
import type { ModelManifest } from "./embeddings.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const native = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./embedding-runtime.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./embedding-runtime.ts")>(),
  loadNativeTransformers: () => { native.calls++; return Promise.reject(new Error("Cannot find module onnxruntime_binding.node")); },
}));
const { MemoryEmbeddings } = await import("./embeddings.ts");

let root = "", manifest: ModelManifest;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "murage-embed-fallback-")); manifest = writeTinyModel(join(root, "model")); });
afterAll(() => removeTempDirSync(root));

it("falls back to WebAssembly when the native binding fails to load", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const model = new MemoryEmbeddings(join(root, "model"), manifest);
  try {
    expect(model.backend).toBe("native");
    const [vector] = await model.embed(["database backups every night"]);
    expect(native.calls).toBe(1);
    expect(model.backend).toBe("wasm");
    expect(vector).toHaveLength(manifest.dimensions);
    expect(errors.mock.calls.flat().join(" ")).toContain("using WebAssembly");
  } finally { await model.close(); errors.mockRestore(); }
});

it("a forced native backend does not fall back: the failure is the result", async () => {
  const model = new MemoryEmbeddings(join(root, "model"), manifest, { backend: "native" });
  await expect(model.embed(["query"])).rejects.toThrow("onnxruntime_binding");
});
