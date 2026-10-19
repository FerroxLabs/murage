import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { bundleBytes, modelFileUrl, stageMemoryModel, validatePackagedMemoryModel } from "./stage-memory-model.mjs";

import { removeTempDirSync } from "../server/testing/cleanup.ts";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const contents = { "config.json": "{\"x\":1}", "onnx/model_quantized.onnx": "0123456789" };
const manifest = { model: "Org/model", revision: "a".repeat(40), files: Object.entries(contents).map(([p, t]) => ({ path: p, bytes: Buffer.byteLength(t), sha256: sha(t) })) };
const roots = [];
const temp = () => { const root = mkdtempSync(path.join(tmpdir(), "murage-stage-model-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const serve = (overrides = {}) => vi.fn(async (url) => {
  const rel = String(url).split(`/resolve/${manifest.revision}/`)[1];
  const body = overrides[rel] ?? contents[rel];
  return body === undefined ? { ok: false, status: 404 } : { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) };
});

it("builds the pinned-revision URL", () => {
  expect(modelFileUrl(manifest, manifest.files[0])).toBe(`https://huggingface.co/Org/model/resolve/${"a".repeat(40)}/config.json`);
  expect(bundleBytes(manifest)).toBe(7 + 10);
});

it("downloads, verifies and stages every manifest file, then reuses the revision cache", async () => {
  const out = temp(), cache = temp(), fetchImpl = serve();
  const result = await stageMemoryModel({ manifest, target: "win32-x64", outDirectory: out, cacheRoot: cache, fetchImpl });
  expect(result).toEqual({ target: "win32-x64", bundled: true, bytes: 17 });
  expect(readFileSync(path.join(out, "win32-x64", "onnx/model_quantized.onnx"), "utf8")).toBe("0123456789");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  await stageMemoryModel({ manifest, target: "linux-x64", outDirectory: out, cacheRoot: cache, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("fails the build on a hash mismatch and keeps nothing bad in the cache", async () => {
  const out = temp(), cache = temp();
  await expect(stageMemoryModel({ manifest, target: "linux-x64", outDirectory: out, cacheRoot: cache, fetchImpl: serve({ "config.json": "{\"x\":2}" }) })).rejects.toThrow(/sha256/);
  expect(existsSync(path.join(cache, manifest.revision, "config.json"))).toBe(false);
});

it("fails the build on a size mismatch and on an HTTP error", async () => {
  await expect(stageMemoryModel({ manifest, target: "linux-x64", outDirectory: temp(), cacheRoot: temp(), fetchImpl: serve({ "onnx/model_quantized.onnx": "short" }) })).rejects.toThrow(/bytes/);
  await expect(stageMemoryModel({ manifest, target: "linux-x64", outDirectory: temp(), cacheRoot: temp(), fetchImpl: vi.fn(async () => ({ ok: false, status: 503 })) })).rejects.toThrow(/HTTP 503/);
});

it("re-downloads a poisoned cache entry", async () => {
  const out = temp(), cache = temp();
  mkdirSync(path.join(cache, manifest.revision), { recursive: true });
  writeFileSync(path.join(cache, manifest.revision, "config.json"), "{\"x\":9}");
  const fetchImpl = serve();
  await stageMemoryModel({ manifest, target: "darwin-arm64", outDirectory: out, cacheRoot: cache, fetchImpl });
  expect(readFileSync(path.join(out, "darwin-arm64", "config.json"), "utf8")).toBe("{\"x\":1}");
});

it("refuses an unpinned revision and an unknown target, and stages the real model for Intel macOS like every target", async () => {
  await expect(stageMemoryModel({ manifest: { ...manifest, revision: "main" }, target: "linux-x64", outDirectory: temp(), cacheRoot: temp(), fetchImpl: serve() })).rejects.toThrow(/full revision/);
  await expect(stageMemoryModel({ manifest, target: "freebsd-x64", outDirectory: temp(), cacheRoot: temp(), fetchImpl: serve() })).rejects.toThrow(/Unsupported/);
  const out = temp(), fetchImpl = serve();
  expect(await stageMemoryModel({ manifest, target: "darwin-x64", outDirectory: out, cacheRoot: temp(), fetchImpl })).toEqual({ target: "darwin-x64", bundled: true, bytes: 17 });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(readFileSync(path.join(out, "darwin-x64", "onnx/model_quantized.onnx"), "utf8")).toBe("0123456789");
  expect(existsSync(path.join(out, "darwin-x64", "NOT-BUNDLED.txt"))).toBe(false);
  await expect(stageMemoryModel({ manifest, target: "darwin-x64", outDirectory: temp(), cacheRoot: temp(), fetchImpl: serve({ "config.json": "{\"x\":2}" }) })).rejects.toThrow(/sha256/);
});

/** A Resources directory holding the staged bundle for `target`. */
async function packagedResources(target) {
  const out = temp(), resources = temp(), dest = path.join(resources, "memory-model");
  await stageMemoryModel({ manifest, target, outDirectory: out, cacheRoot: temp(), fetchImpl: serve() });
  const { cpSync } = await import("node:fs");
  cpSync(path.join(out, target), dest, { recursive: true });
  return { resources, dest };
}

it("after-pack gate, on each of the four targets: the verified bundle passes; corrupt, partial or missing fails when required", async () => {
  for (const target of ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]) {
    const [platform, arch] = target.split("-");
    const { resources, dest } = await packagedResources(target);
    expect(await validatePackagedMemoryModel(resources, platform, arch, manifest, true), target).toEqual({ target, bundled: true });
    writeFileSync(path.join(dest, "config.json"), "{\"x\":7}");
    await expect(validatePackagedMemoryModel(resources, platform, arch, manifest, true), target).rejects.toThrow(/failed verification/);
    const partial = temp(); mkdirSync(path.join(partial, "memory-model"), { recursive: true });
    writeFileSync(path.join(partial, "memory-model", "config.json"), contents["config.json"]);
    await expect(validatePackagedMemoryModel(partial, platform, arch, manifest, true), target).rejects.toThrow(/failed verification/);
    const empty = temp();
    await expect(validatePackagedMemoryModel(empty, platform, arch, manifest, true), target).rejects.toThrow(/failed verification/);
    // Unpackaged qualification builds (not required) may omit the model; they are reported as not bundled, never as ready.
    expect(await validatePackagedMemoryModel(empty, platform, arch, manifest, false), target).toEqual({ target, bundled: false });
  }
  await expect(validatePackagedMemoryModel(temp(), "freebsd", "x64", manifest, true)).rejects.toThrow(/Unsupported/);
});

it("Intel macOS gate: the old keyword-only note no longer passes, alone or beside a complete model", async () => {
  const noteOnly = temp();
  mkdirSync(path.join(noteOnly, "memory-model"), { recursive: true });
  writeFileSync(path.join(noteOnly, "memory-model", "NOT-BUNDLED.txt"), "note");
  await expect(validatePackagedMemoryModel(noteOnly, "darwin", "x64", manifest, true)).rejects.toThrow(/NOT-BUNDLED/);
  await expect(validatePackagedMemoryModel(noteOnly, "darwin", "x64", manifest, false)).rejects.toThrow(/NOT-BUNDLED/);
  const { resources, dest } = await packagedResources("darwin-x64");
  writeFileSync(path.join(dest, "NOT-BUNDLED.txt"), "note");
  await expect(validatePackagedMemoryModel(resources, "darwin", "x64", manifest, true)).rejects.toThrow(/NOT-BUNDLED/);
});

it("Intel macOS gate: an empty memory-model directory fails verification like every other target", async () => {
  const resources = temp();
  mkdirSync(path.join(resources, "memory-model"), { recursive: true });
  await expect(validatePackagedMemoryModel(resources, "darwin", "x64", manifest, true)).rejects.toThrow(/failed verification/);
});
