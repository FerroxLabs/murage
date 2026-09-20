// A last line of defence around the installation directory itself.
//
// On 2026-09-20 a debugging script imported this server's config and called
// `rmSync(DATA_DIR, { recursive: true, force: true })`. Under vitest the test
// harness redirects DATA_DIR to a throwaway directory, so the same line is
// harmless there; run outside vitest it resolved to the real `~/.murage` and
// destroyed a live installation — 28 bots, every workspace, every MEMORY.md.
// The author of that script held the rule "never touch ~/.murage" and believed
// they were keeping it. The rule was not the missing piece; a guard was.
//
// So: importing `server/config.ts` now installs this, and any process that can
// resolve DATA_DIR is a process that cannot recursively delete it.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ----------------------------------
// The test guard (`server/testing/safe-wipe.mjs`) refuses every recursive
// delete that is, contains, *or lies inside* a data directory. That is right
// for tests, where nothing legitimate deletes inside a real installation. It
// is badly wrong in production, where nine shipped features delete inside
// DATA_DIR on purpose: deleting a bot removes its workspace, skill-state and
// checkpoints (server/store.ts:1967-1980); removing a skill deletes its folder
// (server/skills.ts:1060); every routed Hermes/Fuigo turn cleans up a per-turn
// provider HOME that holds an API key (server/provider-routing.ts:114); engine
// updates, package imports and memory evolution all stage and discard inside
// it. Refusing those would leak credentials and wedge imports.
//
// This guard therefore protects ROOTS ONLY:
//   * DATA_DIR itself, and anything that contains it (a home directory, `/`),
//   * DATA_DIR/workspaces itself — the directory whose loss was the one
//     unrecoverable part of the incident. Individual bot workspaces inside it
//     are still deletable, because deleting a bot is a real feature.
// Everything strictly inside DATA_DIR is left alone.
// The DEFAULT import is the mutable CommonJS exports object. `import * as fs`
// gives an ESM namespace object whose properties are non-writable by
// specification, so every patch silently fails and the guard protects nothing.
import fs, { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";

/** Thrown instead of deleting. Named so a caller can recognise it. */
export class DataDirectoryProtected extends Error {
  readonly target: string;
  constructor(target: string, reason: string) {
    super(`Refusing to recursively delete ${target}: ${reason}`);
    this.name = "DataDirectoryProtected";
    this.target = target;
  }
}

/** macOS and Windows compare paths case-insensitively; Linux does not. */
const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value);

/**
 * Segment-aware containment. NOT a string prefix test: `~/.murage-archive-
 * inspection-ab12` starts with `~/.murage` as text but is a sibling, and the
 * restore path genuinely deletes siblings like it
 * (server/installation-restore-preparation.ts:205). Getting this wrong would
 * refuse a legitimate delete every time a restore was prepared.
 */
function sameOrInside(inner: string, outer: string): boolean {
  const a = fold(resolve(inner)), b = fold(resolve(outer));
  if (a === b) return true;
  return a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Replace a builtin's method even when an earlier patcher left the property
 * non-configurable. The test harness installs its own recursive-delete guard
 * (server/testing/safe-wipe.mjs) and calls syncBuiltinESMExports, after which
 * a plain assignment throws "Cannot redefine property: rmSync". Both guards
 * must be able to coexist: theirs is stricter, ours is the one that ships.
 */
function replaceMethod(owner: Record<string, unknown>, name: string, value: unknown): void {
  const existing = Object.getOwnPropertyDescriptor(owner, name);
  if (existing?.writable) { owner[name] = value; }
  else {
    Object.defineProperty(owner, name, {
      value, writable: true, configurable: true, enumerable: existing?.enumerable ?? true,
    });
  }
  // A guard that believes it is installed while the assignment was discarded
  // is worse than no guard: it reports success and protects nothing. That is
  // exactly what an `import * as fs` namespace produced here, and the only
  // reason it surfaced was a test that tried a real delete.
  if (owner[name] !== value) throw new Error(`data-dir guard could not replace fs.${name}`);
}

/** Resolve as far as the filesystem allows, so a symlinked path cannot dodge
 *  the comparison. A path that does not exist cannot be deleted anyway, so a
 *  failed realpath falls back to a lexical resolve. */
function canonical(target: string): string {
  try { return realpathSync.native(target); } catch { return resolve(target); }
}

/** fs accepts a string, a Buffer, or a file: URL. Judge whichever it is. */
function targetPath(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof URL) return value.protocol === "file:" ? fileURLToPath(value) : null;
  return null;
}

const recursive = (options: unknown): boolean =>
  Boolean(options && typeof options === "object" && (options as { recursive?: unknown }).recursive);

/**
 * The whole decision, as a pure function, so it can be tested exhaustively
 * without patching the filesystem.
 *
 * @returns the reason to refuse, or null to allow.
 */
export function protectedRootRefusal(target: string, dataDir: string): string | null {
  const root = canonical(dataDir);
  const path = canonical(target);
  if (sameOrInside(root, path)) {
    return path === root
      ? "it is the Murage installation directory"
      : `it contains the Murage installation directory ${root}`;
  }
  const workspaces = join(root, "workspaces");
  if (sameOrInside(workspaces, path)) {
    return `it is or contains every bot workspace (${workspaces}); delete one bot's folder instead`;
  }
  return null;
}

let installed = false;
let undo: (() => void) | null = null;

/** Undo the patch. Tests only — production installs once and keeps it. */
export function uninstallDataDirGuardForTests(): void {
  undo?.();
  undo = null;
  installed = false;
}

/**
 * Patch the recursive-delete entry points so none of them can remove the
 * installation root. Idempotent, and safe to sit underneath the test guard.
 *
 * @param dataDir the resolved installation directory (DATA_DIR)
 * @returns true if this call installed the guard
 */
export function installDataDirGuard(dataDir: string, options: { tempRoot?: string } = {}): boolean {
  if (installed) return false;
  if (!dataDir || !isAbsolute(dataDir)) return false;

  // A data directory under the OS temp dir belongs to a test rig or a soak
  // harness, which is entitled to delete its own fixtures wholesale. The real
  // installation never lives there, so skipping keeps every existing suite
  // working without weakening the protection that matters. `tempRoot` is the
  // seam that lets this file's own tests exercise the patch on a fixture.
  // Canonicalise both sides: on macOS tmpdir() reports /var/folders/... while
  // the same directory realpaths to /private/var/folders/..., so a lexical
  // comparison decides a vitest fixture is a real installation and the guard
  // installs itself across the whole test suite.
  const temp = options.tempRoot ?? tmpdir();
  if (temp && sameOrInside(canonical(dataDir), canonical(temp))) return false;

  /** Throws if `value` names a protected root. Silent otherwise. */
  const check = (value: unknown): void => {
    const named = targetPath(value);
    if (named === null) return;
    const reason = protectedRootRefusal(named, dataDir);
    if (reason) throw new DataDirectoryProtected(canonical(named), reason);
  };

  installed = true;

  const originalRmSync = fs.rmSync;
  replaceMethod(fs as unknown as Record<string, unknown>, "rmSync", function guardedRmSync(this: unknown, path: unknown, options?: unknown) {
    if (recursive(options)) check(path);
    return (originalRmSync as Function).call(this, path, options);
  });

  const originalRm = fs.rm;
  replaceMethod(fs as unknown as Record<string, unknown>, "rm", function guardedRm(this: unknown, path: unknown, options?: unknown, callback?: unknown) {
    if (recursive(options)) {
      try { check(path); }
      catch (error) {
        // `rm(path, cb)` cannot reach here (no recursive flag), but
        // `rm(path, opts, cb)` must report through the callback rather than
        // throwing synchronously, which no caller expects.
        const done = typeof options === "function" ? options : callback;
        if (typeof done === "function") { process.nextTick(done, error); return; }
        throw error;
      }
    }
    return (originalRm as Function).call(this, path, options, callback);
  });

  const originalPromisesRm = fs.promises.rm;
  replaceMethod(fs.promises as unknown as Record<string, unknown>, "rm", async function guardedPromisesRm(this: unknown, path: unknown, options?: unknown) {
    if (recursive(options)) check(path);
    return (originalPromisesRm as Function).call(this, path, options);
  });

  const originalRmdirSync = fs.rmdirSync;
  replaceMethod(fs as unknown as Record<string, unknown>, "rmdirSync", function guardedRmdirSync(this: unknown, path: unknown, options?: unknown) {
    if (recursive(options)) check(path);
    return (originalRmdirSync as Function).call(this, path, options);
  });

  undo = () => {
    const fsRecord = fs as unknown as Record<string, unknown>;
    replaceMethod(fsRecord, "rmSync", originalRmSync);
    replaceMethod(fsRecord, "rm", originalRm);
    replaceMethod(fs.promises as unknown as Record<string, unknown>, "rm", originalPromisesRm);
    replaceMethod(fsRecord, "rmdirSync", originalRmdirSync);
    syncBuiltinESMExports();
  };

  // Named imports (`import { rmSync } from "node:fs"`) bind to the builtin's
  // ESM facade, which has to be re-synced or those callers keep the original.
  syncBuiltinESMExports();
  return true;
}
