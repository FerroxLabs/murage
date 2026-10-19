// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two ways the pinned memory model runs: the native ONNX Runtime binding
// (onnxruntime-node), and ONNX Runtime's WebAssembly build (onnxruntime-web)
// where that binding does not exist (Intel macOS: the pinned onnxruntime-node
// ships no darwin/x64 binary) or fails to load. Both run the same verified
// model files through the same Transformers.js feature-extraction pipeline
// (same tokenizer, same mean pooling, same normalisation); only the ONNX
// executor differs.
//
// Transformers.js imports onnxruntime-node (and sharp) at module load, so on
// a machine without the native binding the package cannot even be imported.
// The WebAssembly path imports a second, separate instance of the same
// Transformers.js file (a distinct URL, so a distinct module record) and, for
// that instance only, resolves "onnxruntime-node" to onnxruntime-web's Node
// build and "sharp" (image pipelines, unused here) to an empty module. The
// native instance and every other import resolve exactly as before.
import { registerHooks } from "node:module";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type MemoryBackend = "native" | "wasm";
type Transformers = typeof import("@huggingface/transformers");

/** The onnxruntime-web release the WebAssembly path runs: the same ONNX Runtime release as the pinned onnxruntime-node. */
export const ORT_WEB_VERSION = "1.24.3";
/** What the WebAssembly path needs from onnxruntime-web, and all it ships (scripts/stage-memory-runtime.mjs). */
export const ORT_WASM_FILES = Object.freeze(["ort.node.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]);
/** Where scripts/stage-memory-runtime.mjs puts those files, beside the bundled memory worker (dist-server/memory). */
export const ORT_WASM_DIRECTORY = "ort-wasm";
const WASM_INSTANCE_QUERY = "murage-memory-backend=wasm";
/** Transformers.js refuses to load without an image library, but text embedding never calls it. */
const SHARP_PLACEHOLDER = `data:text/javascript,${encodeURIComponent("export default function sharp() { throw new Error(\"Image processing is not part of the memory model runtime\"); }")}`;

/** The pinned onnxruntime-node ships a binding for this platform (all release targets but Intel macOS). */
export function nativeBindingShipped(platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  return !(platform === "darwin" && arch === "x64");
}

const regularFiles = (directory: string) => ORT_WASM_FILES.every(name => {
  try { const stat = lstatSync(join(directory, name)); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
});

/** The directory holding the WebAssembly runtime files: the packaged copy beside the worker, else (a checkout) the
 * installed onnxruntime-web, but only at the pinned release. Null when neither is usable. */
export function wasmRuntimeDirectory(): string | null {
  const staged = join(dirname(fileURLToPath(import.meta.url)), ORT_WASM_DIRECTORY);
  if (regularFiles(staged)) return staged;
  try {
    const dist = dirname(fileURLToPath(import.meta.resolve("onnxruntime-web")));
    const pkg = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8"));
    if (pkg.name === "onnxruntime-web" && pkg.version === ORT_WEB_VERSION && regularFiles(dist)) return dist;
  } catch { /* not installed */ }
  return null;
}

/** The WebAssembly path can run here: its files are present and this Node can scope the import redirect to one instance. */
let wasmFound = false;
export function wasmRuntimeAvailable() {
  return wasmFound ||= typeof registerHooks === "function" && wasmRuntimeDirectory() !== null;
}

let nativeInstance: Promise<Transformers> | undefined;
let wasmInstance: Promise<Transformers> | undefined;

/** Transformers.js on the native binding. Rejects (once, for the life of the process) where the binding cannot load. */
export function loadNativeTransformers(): Promise<Transformers> {
  return nativeInstance ??= import("@huggingface/transformers");
}

/** Transformers.js on ONNX Runtime WebAssembly. Nothing is fetched: the runtime and its binary are local files. */
export function loadWasmTransformers(): Promise<Transformers> {
  wasmInstance ??= (async () => {
    const directory = wasmRuntimeDirectory();
    if (!directory || typeof registerHooks !== "function") throw new Error("MEMORY_WASM_RUNTIME_UNAVAILABLE");
    const ortUrl = pathToFileURL(join(directory, "ort.node.min.mjs")).href;
    const ort = await import(ortUrl);
    // The binary is handed over as bytes and the loader script by file URL, so ONNX Runtime never looks elsewhere,
    // and Transformers.js (which fills in a CDN location only when none is set) never fetches anything.
    ort.env.wasm.wasmBinary = readFileSync(join(directory, "ort-wasm-simd-threaded.wasm"));
    ort.env.wasm.wasmPaths = { mjs: pathToFileURL(join(directory, "ort-wasm-simd-threaded.mjs")).href };
    ort.env.wasm.proxy = false;
    const instanceUrl = `${import.meta.resolve("@huggingface/transformers")}?${WASM_INSTANCE_QUERY}`;
    let redirected = false;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL === instanceUrl) {
          if (specifier === "onnxruntime-node") { redirected = true; return { url: ortUrl, shortCircuit: true }; }
          if (specifier === "sharp") return { url: SHARP_PLACEHOLDER, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    const instance = await import(instanceUrl) as Transformers;
    // A loader that ignored the separate URL would hand back the native instance: never run that as "wasm".
    if (!redirected) throw new Error("MEMORY_WASM_RUNTIME_UNAVAILABLE");
    instance.env.useWasmCache = false;
    return instance;
  })();
  return wasmInstance;
}

/** Pipeline options per backend. Same model files, dtype and (in embeddings.ts) pooling and normalisation; the
 * WebAssembly path names ONNX Runtime Web's "wasm" execution provider explicitly. */
export function pipelineOptions(backend: MemoryBackend) {
  return backend === "wasm"
    ? { dtype: "q8" as const, device: "cpu" as const, local_files_only: true, session_options: { executionProviders: ["wasm"] } }
    : { dtype: "q8" as const, device: "cpu" as const, local_files_only: true };
}
