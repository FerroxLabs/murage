// SPDX-License-Identifier: Apache-2.0
// Types for safe-wipe.mjs, the only recursive delete tests and scripts may use.
export interface SafeWipeOptions {
  /** Admit a target strictly inside this root (build outputs under the
   * repository). Never a home or data directory. */
  within?: string;
  /** Environment to read MURAGE_DATA_DIR / MURAGE_COMPANION_DIR from. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Override for os.homedir(); the account home from os.userInfo() is always protected too. */
  homedir?: string;
  /** Override for os.tmpdir(). */
  tmpdir?: string;
  /** Override for process.cwd(). */
  cwd?: string;
  /** Override for process.platform (case folding). */
  platform?: NodeJS.Platform;
  /** A lease owned by this pid is the caller's own fixture, not a live installation. Default process.pid. */
  selfPid?: number;
  /** assertSafeToWipe only: skip the live-lease scan when merely validating a
   * location (a config admitting MURAGE_E2E_DATA_DIR while last run's harness
   * may still own it). Deletes always scan. Default true. */
  checkLeases?: boolean;
  /** rm retry budget. safeWipeSync judges once and never retries a refusal;
   * safeWipe re-judges on every attempt (a just-killed lease owner reads as
   * live until reaped) and throws a refusal that outlives the budget. */
  maxRetries?: number;
  retryDelay?: number;
}

export type SafeWipeAdmission = "tmpdir" | "scratch-segment" | "within";

export declare class SafeWipeRefused extends Error {
  readonly name: "SafeWipeRefused";
  readonly path: string;
  readonly reason: string;
  constructor(path: string, reason: string);
}

/** Symlink-resolved path whose leaf need not exist; a symlink leaf resolves to its target even when dangling. */
export declare function canonicalPath(target: string): string;
/** Throws SafeWipeRefused unless `target` may be deleted recursively. */
export declare function assertSafeToWipe(target: string, options?: SafeWipeOptions): { path: string; admitted: SafeWipeAdmission };
/** Deny-only rules (home, data dirs, cwd, roots, live leases); used by the process-wide guard. */
export declare function assertNotProtected(target: string, options?: SafeWipeOptions): void;
/** assertSafeToWipe, then rmSync recursive+force. Returns the canonical path. */
export declare function safeWipeSync(target: string, options?: SafeWipeOptions): string;
/** assertSafeToWipe on every attempt, then fs/promises rm with retries. Returns the canonical path. */
export declare function safeWipe(target: string, options?: SafeWipeOptions): Promise<string>;
/** The path a node:fs delete names, from a string, `file:` URL or Buffer, for the guard's judgement. */
export declare function wipeTargetPath(target: unknown): string;
/** Patch node:fs so every recursive delete in this process runs assertNotProtected. Idempotent; true when it installed. */
export declare function installSafeWipeGuard(options?: SafeWipeOptions): boolean;
