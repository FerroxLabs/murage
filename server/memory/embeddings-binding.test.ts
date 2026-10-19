import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MemoryEmbeddings } from "./embeddings.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const manifest = { model: "t", revision: "r", dimensions: 2, files: [{ path: "config.json", bytes: 2, sha256: "0".repeat(64) }] };
let root = "";
afterEach(() => removeTempDirSync(root));

it("refuses a linked root when strict and a wrong-hash directory otherwise, before the runtime is imported", async () => {
  root = mkdtempSync(join(tmpdir(), "murage-embed-bind-"));
  const real = join(root, "real"); mkdirSync(real); writeFileSync(join(real, "config.json"), "{}");
  symlinkSync(real, join(root, "link"));
  await expect(new MemoryEmbeddings(join(root, "link"), manifest, { strictRoot: true }).load()).rejects.toThrow("MEMORY_MODEL_UNVERIFIED");
  await expect(new MemoryEmbeddings(real, manifest).load()).rejects.toThrow("MEMORY_MODEL_UNVERIFIED");
});

it("tries the fallback directory after the primary fails, and reports the primary failure when both fail", async () => {
  root = mkdtempSync(join(tmpdir(), "murage-embed-bind-"));
  const bad = join(root, "bad"), alsoBad = join(root, "also"); mkdirSync(bad); mkdirSync(alsoBad);
  writeFileSync(join(bad, "config.json"), "{}"); writeFileSync(join(alsoBad, "config.json"), "{}");
  await expect(new MemoryEmbeddings(bad, manifest, { fallbackDirectory: alsoBad }).load()).rejects.toThrow("MEMORY_MODEL_UNVERIFIED");
});
