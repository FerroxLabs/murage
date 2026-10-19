// Where the local semantic model is read from. A model shipped inside the app
// (Resources/memory-model, located by MURAGE_MEMORY_MODEL_DIR) wins when every
// manifest file matches its pinned size and SHA-256 and no part of its path is a
// symbolic link; anything else falls back to the optional copy in
// DATA_DIR/memory-model. The user's copy is only ever read.
//
// A verdict is remembered only while the files keep the identity they had when
// they were hashed (inode, size, mtime, ctime); a change re-opens the question.
import { isAbsolute, join } from "node:path";
import { modelSignature, modelSizesMatch, verifyModelDirectory, type ModelManifestLike } from "../../shared/memory-model-verify.mjs";

type Manifest = ModelManifestLike & { revision?: string };

export function bundledModelDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  const directory = env.MURAGE_MEMORY_MODEL_DIR?.trim();
  return directory && isAbsolute(directory) ? directory : null;
}

/** Runs after every successful verification, whoever asked for it (settings, worker start). Must be idempotent. */
let verifiedHook: ((manifest: Manifest) => void) | null = null;
export function setBundledModelVerifiedHook(hook: ((manifest: Manifest) => void) | null) { verifiedHook = hook; }

interface Verdict { promise: Promise<boolean>; ok?: boolean; signature?: string | null }
const verdicts = new Map<string, Verdict>();
const keyOf = (directory: string, manifest: Manifest) => `${directory}\0${manifest.revision ?? ""}`;

/** Full verification. Computed once per directory and revision while the files are unchanged; re-computed after any change. */
export function bundledModelVerified(directory: string, manifest: Manifest): Promise<boolean> {
  const key = keyOf(directory, manifest), known = verdicts.get(key);
  if (known && (known.ok === undefined || modelSignature(directory, manifest) === known.signature)) return known.promise;
  const verdict: Verdict = { promise: Promise.resolve(false) };
  verdict.promise = (async () => {
    const before = modelSignature(directory, manifest);
    const result = await verifyModelDirectory(directory, manifest, { rejectLinks: true }).catch(() => ({ ok: false }));
    const ok = Boolean(result.ok && before && before === modelSignature(directory, manifest));
    verdict.ok = ok; verdict.signature = before;
    if (ok) { try { verifiedHook?.(manifest); } catch { /* adoption retries on the next start */ } }
    return ok;
  })();
  verdicts.set(key, verdict);
  return verdict.promise;
}

export type BundledModelState = "verified" | "checking" | "absent";

const probing = new Set<string>();

/** Synchronous view for the settings status; starts verification the first time it sees plausible bundled files. */
export function bundledModelState(manifest: Manifest, directory: string | null = bundledModelDirectory()): BundledModelState {
  if (!directory) return "absent";
  const key = keyOf(directory, manifest), known = verdicts.get(key);
  if (known?.ok !== undefined) {
    if (modelSignature(directory, manifest) === known.signature) return known.ok ? "verified" : "absent";
    verdicts.delete(key); // the files changed since they were checked: look again
  } else if (known || probing.has(key)) return "checking";
  probing.add(key);
  void modelSizesMatch(directory, manifest).then((plausible) => {
    probing.delete(key);
    if (plausible) return bundledModelVerified(directory, manifest);
    verdicts.set(key, { promise: Promise.resolve(false), ok: false, signature: modelSignature(directory, manifest) });
  }).catch(() => { probing.delete(key); });
  return "checking";
}

export function resetBundledModelVerdicts() { verdicts.clear(); probing.clear(); }

/** The directory the worker should load from: the verified bundled copy, else the user's downloaded copy path. */
export async function resolveMemoryModelDirectory(manifest: Manifest, options: { dataDir: string; bundled?: string | null }): Promise<{ directory: string; source: "bundled" | "downloaded"; fallback?: string }> {
  const bundled = options.bundled === undefined ? bundledModelDirectory() : options.bundled;
  const downloaded = join(options.dataDir, "memory-model");
  if (bundled && await bundledModelVerified(bundled, manifest)) return { directory: bundled, source: "bundled", fallback: downloaded };
  return { directory: downloaded, source: "downloaded" };
}
