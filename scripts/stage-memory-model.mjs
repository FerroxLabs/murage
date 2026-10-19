// Stages the pinned local semantic memory model for release packaging.
//
//   node scripts/stage-memory-model.mjs --target darwin-arm64 --out dist-native/memory-model --cache "$RUNNER_TEMP/memory-model-cache"
//
// Fetches the exact files of shared/memory-model-manifest.json at the pinned
// Hugging Face revision, verifies every file's size and SHA-256 against the
// manifest, and refuses (exit 1) on any mismatch. The result is
// <out>/<target>/, which electron-builder copies to Resources/memory-model.
// Every target, Intel macOS included, bundles the same files: Intel runs them on
// ONNX Runtime WebAssembly (server/memory/embedding-runtime.ts). The cache is keyed by revision, and a cached file is re-verified
// before use, so a poisoned or truncated cache entry is re-downloaded.
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifestFileTarget, verifyModelDirectory } from "../shared/memory-model-verify.mjs";
import { safeWipe } from "../server/testing/safe-wipe.mjs";

export const MODEL_BUNDLE_TARGETS = Object.freeze(["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]);
/** The note earlier Intel macOS stages held in place of the model. A package that still carries it is refused. */
export const NOT_BUNDLED_NOTE = "NOT-BUNDLED.txt";

export function modelFileUrl(manifest, file) {
  return `https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${file.path}`;
}

/** Total bytes the bundle adds to a package. */
export function bundleBytes(manifest) {
  return manifest.files.reduce((sum, file) => sum + file.bytes, 0);
}

async function download(manifest, file, destination, fetchImpl) {
  const response = await fetchImpl(modelFileUrl(manifest, file), { redirect: "follow" });
  if (!response.ok) throw new Error(`Model download failed for ${file.path}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(path.dirname(destination), { recursive: true });
  const part = `${destination}.part`;
  await writeFile(part, bytes);
  await rename(part, destination);
}

/**
 * Fill `cacheRoot/<revision>` with verified files, then copy them to
 * `outDirectory/<target>`. Throws on any size or hash mismatch.
 */
export async function stageMemoryModel({ manifest, target, outDirectory, cacheRoot, fetchImpl = fetch }) {
  if (!MODEL_BUNDLE_TARGETS.includes(target)) throw new Error(`Unsupported model bundle target: ${target}`);
  const destination = path.join(outDirectory, target);
  // The guarded delete: <out>/<target> is admitted only strictly inside the out directory, never a home or data directory.
  await safeWipe(destination, { within: outDirectory, maxRetries: 3 });
  await mkdir(destination, { recursive: true });
  if (!/^[0-9a-f]{40}$/.test(manifest.revision ?? "")) throw new Error("The memory model manifest does not pin a full revision");
  const cache = path.join(cacheRoot, manifest.revision);
  for (const file of manifest.files) {
    const cached = manifestFileTarget(cache, file.path);
    if (!cached) throw new Error(`Invalid model manifest path: ${file.path}`);
    const single = { files: [file] };
    if (!(await verifyModelDirectory(cache, single)).ok) {
      await rm(cached, { force: true });
      await download(manifest, file, cached, fetchImpl);
      const result = await verifyModelDirectory(cache, single);
      if (!result.ok) { await rm(cached, { force: true }); throw new Error(`Memory model verification failed: ${result.reason}`); }
    }
    const target_ = manifestFileTarget(destination, file.path);
    await mkdir(path.dirname(target_), { recursive: true });
    await copyFile(cached, target_);
  }
  const final = await verifyModelDirectory(destination, manifest);
  if (!final.ok) throw new Error(`Staged memory model verification failed: ${final.reason}`);
  return { target, bundled: true, bytes: bundleBytes(manifest) };
}

/** After-pack gate: a packaged Resources/memory-model must match the manifest exactly, on every target. Intel macOS
 * is held to the same bytes and checksums as the rest (it runs them on WebAssembly), and a leftover keyword-only note
 * from an earlier stage is refused rather than read as "not bundled". */
export async function validatePackagedMemoryModel(resources, platform, arch, manifest, required) {
  const directory = path.join(resources, "memory-model");
  const target = `${platform}-${arch}`;
  if (!MODEL_BUNDLE_TARGETS.includes(target)) throw new Error(`Unsupported model bundle target: ${target}`);
  if (await lstat(path.join(directory, NOT_BUNDLED_NOTE)).then(() => true, error => { if (error?.code === "ENOENT") return false; throw error; })) {
    throw new Error(`Packaged memory model for ${target} still carries ${NOT_BUNDLED_NOTE}: every target bundles the model`);
  }
  const result = await verifyModelDirectory(directory, manifest);
  if (result.ok) return { target, bundled: true };
  if (!required && /unreadable: ENOENT/.test(result.reason ?? "")) return { target, bundled: false };
  throw new Error(`Packaged memory model failed verification for ${target}: ${result.reason}`);
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const target = option("--target"), out = option("--out"), cache = option("--cache");
  if (!target || !out || !cache) throw new Error("Usage: stage-memory-model.mjs --target <platform-arch> --out <dir> --cache <dir>");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(root, "shared", "memory-model-manifest.json"), "utf8"));
  const result = await stageMemoryModel({ manifest, target, outDirectory: path.resolve(out), cacheRoot: path.resolve(cache) });
  console.log(`Staged memory model for ${target}: ${result.bundled ? `${result.bytes} bytes verified` : "not bundled"}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
