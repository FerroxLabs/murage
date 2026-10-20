import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { modelSignature } from "../../shared/memory-model-verify.mjs";
import { bundledModelDirectory, bundledModelState, resetBundledModelVerdicts, resolveMemoryModelDirectory, setBundledModelVerifiedHook } from "./model-location.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const files = { "config.json": "{\"a\":1}", "onnx/model.onnx": "weights-weights" };
const manifest = { revision: "r".repeat(40), files: Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: sha(text) })) };
let root = "";
function write(directory: string, overrides: Record<string, string> = {}) {
  for (const [path, text] of Object.entries({ ...files, ...overrides })) {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
}
beforeEach(() => { resetBundledModelVerdicts(); setBundledModelVerifiedHook(null); root = realpathSync(mkdtempSync(join(tmpdir(), "murage-model-loc-"))); }); // resolved: a bundled path with a linked part never verifies, and macOS os.tmpdir() sits behind /var -> /private/var
afterEach(() => { setBundledModelVerifiedHook(null); removeTempDirSync(root); });

it("uses the bundled directory when every file verifies", async () => {
  const bundled = join(root, "Resources", "memory-model"); write(bundled);
  expect(await resolveMemoryModelDirectory(manifest, { dataDir: join(root, "data"), bundled })).toEqual({ directory: bundled, source: "bundled", fallback: join(root, "data", "memory-model") });
});

it("uses the downloaded copy path when nothing is bundled", async () => {
  const dataDir = join(root, "data");
  expect(await resolveMemoryModelDirectory(manifest, { dataDir, bundled: null })).toEqual({ directory: join(dataDir, "memory-model"), source: "downloaded" });
  expect(await resolveMemoryModelDirectory(manifest, { dataDir, bundled: join(root, "missing") })).toMatchObject({ source: "downloaded" });
});

it("falls back to the downloaded copy when the bundled bytes are corrupt, and leaves both copies alone", async () => {
  const bundled = join(root, "bundled"), dataDir = join(root, "data"), downloaded = join(dataDir, "memory-model");
  write(bundled, { "onnx/model.onnx": "weights-WEIGHTS" }); // same size, different bytes
  write(downloaded);
  expect(await resolveMemoryModelDirectory(manifest, { dataDir, bundled })).toEqual({ directory: downloaded, source: "downloaded" });
  expect(readFileSync(join(downloaded, "onnx/model.onnx"), "utf8")).toBe(files["onnx/model.onnx"]);
  expect(readFileSync(join(bundled, "onnx/model.onnx"), "utf8")).toBe("weights-WEIGHTS");
});

it("prefers the bundled copy even when the user already downloaded one", async () => {
  const bundled = join(root, "bundled"), dataDir = join(root, "data");
  write(bundled); write(join(dataDir, "memory-model"));
  expect((await resolveMemoryModelDirectory(manifest, { dataDir, bundled })).source).toBe("bundled");
});

it("reads the bundled directory from MURAGE_MEMORY_MODEL_DIR and ignores a relative value", () => {
  expect(bundledModelDirectory({ MURAGE_MEMORY_MODEL_DIR: "/a/b" })).toBe("/a/b");
  expect(bundledModelDirectory({ MURAGE_MEMORY_MODEL_DIR: "relative/path" })).toBeNull();
  expect(bundledModelDirectory({})).toBeNull();
});

it("reports checking, then verified, for a good bundle, and absent for a bad one", async () => {
  const good = join(root, "good"), bad = join(root, "bad"); write(good); write(bad, { "config.json": "{\"a\":2}" });
  expect(bundledModelState(manifest, good)).toBe("checking");
  expect(bundledModelState(manifest, null)).toBe("absent");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(bundledModelState(manifest, good)).toBe("verified");
  bundledModelState(manifest, bad);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(bundledModelState(manifest, bad)).toBe("absent");
});

it("runs the verified hook once per verification whichever caller verifies first, and again only after a change", async () => {
  const bundled = join(root, "bundled"); write(bundled);
  const hook = vi.fn(); setBundledModelVerifiedHook(hook);
  // the worker path verifies first, concurrently; the settings path asks afterwards
  await Promise.all([1, 2, 3].map(() => resolveMemoryModelDirectory(manifest, { dataDir: root, bundled })));
  expect(bundledModelState(manifest, bundled)).toBe("verified");
  expect(hook).toHaveBeenCalledTimes(1);
  await resolveMemoryModelDirectory(manifest, { dataDir: root, bundled });
  expect(hook).toHaveBeenCalledTimes(1);
});

it("attaches one verification when status calls race", async () => {
  const bundled = join(root, "bundled"); write(bundled);
  const hook = vi.fn(); setBundledModelVerifiedHook(hook);
  for (let i = 0; i < 5; i++) bundledModelState(manifest, bundled);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(hook).toHaveBeenCalledTimes(1);
});

it("drops a verified verdict when a file is replaced, falling back and reporting absent", async () => {
  const bundled = join(root, "bundled"), dataDir = join(root, "data"); write(bundled); write(join(dataDir, "memory-model"));
  expect((await resolveMemoryModelDirectory(manifest, { dataDir, bundled })).source).toBe("bundled");
  expect(bundledModelState(manifest, bundled)).toBe("verified");
  rmSync(join(bundled, "onnx/model.onnx")); writeFileSync(join(bundled, "onnx/model.onnx"), "weights-WEIGHTS");
  expect(bundledModelState(manifest, bundled)).toBe("checking");
  expect((await resolveMemoryModelDirectory(manifest, { dataDir, bundled })).source).toBe("downloaded");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(bundledModelState(manifest, bundled)).toBe("absent");
});

it("rejects a bundled directory reached through a symbolic link, at the root or an ancestor", async () => {
  const real = join(root, "real"); write(join(real, "memory-model"));
  symlinkSync(real, join(root, "ancestor-link"));
  symlinkSync(join(real, "memory-model"), join(root, "root-link"));
  for (const bundled of [join(root, "ancestor-link", "memory-model"), join(root, "root-link")])
    expect((await resolveMemoryModelDirectory(manifest, { dataDir: root, bundled })).source).toBe("downloaded");
});

it("rejects a bundled model whose internal directory is a symbolic link", async () => {
  const bundled = join(root, "bundled"), elsewhere = join(root, "elsewhere");
  write(elsewhere); mkdirSync(bundled, { recursive: true });
  writeFileSync(join(bundled, "config.json"), files["config.json"]);
  symlinkSync(join(elsewhere, "onnx"), join(bundled, "onnx"));
  expect(await resolveMemoryModelDirectory(manifest, { dataDir: join(root, "data"), bundled })).toMatchObject({ source: "downloaded" });
  expect(modelSignature(bundled, manifest)).toBeNull();
});

it("detects an intermediate directory swapped and restored", async () => {
  const bundled = join(root, "bundled"); write(bundled);
  const before = modelSignature(bundled, manifest);
  expect(before).toBeTruthy();
  renameSync(join(bundled, "onnx"), join(root, "onnx-parked"));
  mkdirSync(join(bundled, "onnx"));
  removeTempDirSync(join(bundled, "onnx"));
  renameSync(join(root, "onnx-parked"), join(bundled, "onnx"));
  // Original leaf files are untouched, but the directory's identity (ctime/mtime) changed.
  expect(modelSignature(bundled, manifest)).not.toBe(before);
});
