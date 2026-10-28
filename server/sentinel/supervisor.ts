// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Sentinel supervisor (1.0.9, GAP-SENTINEL-109 sections 3.1 and 9).
//
// Every scan runs in a child process with a 5 s wall deadline; a child still running then (a stuck synchronous SQLite
// call or parser) is killed, and the attempt is recorded as a failed scan for S10. `--watch` repeats isolated child
// scans every 120 s plus a deterministic 0-15 s per-installation jitter, scheduling the next run only after the previous
// one ends: a wake from sleep produces exactly one scan, never a catch-up burst. The child gets an allowlisted
// environment only (no provider credentials, no PATH lookups).
//
// A watcher retires by itself when the descriptor says another scheduler owns the installation: before each scan it
// re-reads the descriptor (cli.ts stillOwned), and when the schedule revision it started with has moved on (an OS
// scheduler took over, an update, or a newer `murage start`) on two scans in a row, it stops. Two in a row, so a
// registration attempt that writes a revision and puts the old one back within a cycle never stops it. No pid files.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { HEALTH_LIMITS } from "../../shared/health-protocol.mjs";

/** Environment names a scanner process may see. Nothing else is passed on or kept. */
export const ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "HOME", "USERPROFILE", "LOCALAPPDATA", "XDG_STATE_HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "WINDIR", "LANG", "TZ",
  "ELECTRON_RUN_AS_NODE", "MURAGE_SENTINEL_CHILD",
]);
export const CHILD_FLAG = "MURAGE_SENTINEL_CHILD";

export function allowlistedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) { const value = env[key]; if (typeof value === "string" && value.length <= 4096 && !value.includes("\0")) out[key] = value; }
  return out;
}

/** Removes every non-allowlisted variable from this process's environment (credentials never linger in the scanner). */
export function scrubEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) if (!ENV_ALLOWLIST.includes(key)) delete env[key];
}

/** Deterministic 0..15 s jitter from the installation id. */
export function installationJitterMs(installationId: string): number {
  const digest = createHash("sha256").update(`murage-sentinel-jitter|${installationId}`).digest();
  return digest.readUInt32BE(0) % (HEALTH_LIMITS.scanJitterMaxMs + 1);
}

/** Exit codes the scan child reports. */
export const EXIT = Object.freeze({
  ok: 0, failed: 1, usage: 2, notProven: 3, alreadyRunning: 10, upgradeNeeded: 11, unavailable: 12, budgetExhausted: 13, outputRefused: 14,
});

export interface ChildSpec { execPath: string; args: readonly string[]; env: Record<string, string> }
export type SpawnChild = (spec: ChildSpec) => ChildProcess;
export const defaultSpawn: SpawnChild = spec => spawn(spec.execPath, [...spec.args], { env: spec.env, stdio: "ignore", windowsHide: true, detached: false } satisfies SpawnOptions);

export interface ChildResult { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; spawnFailed: boolean }

/** Runs one child scan and kills it at the wall deadline. Never rejects. */
export function runChildScan(spec: ChildSpec, options: { deadlineMs?: number; spawnChild?: SpawnChild } = {}): Promise<ChildResult> {
  const deadline = options.deadlineMs ?? HEALTH_LIMITS.scanWallMs;
  return new Promise(resolve => {
    let child: ChildProcess;
    try { child = (options.spawnChild ?? defaultSpawn)(spec); }
    catch { resolve({ code: null, signal: null, timedOut: false, spawnFailed: true }); return; }
    let timedOut = false;
    let settled = false;
    const finish = (result: ChildResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, deadline);
    child.once("error", () => finish({ code: null, signal: null, timedOut, spawnFailed: child.pid === undefined }));
    child.once("exit", (code, signal) => finish({ code, signal, timedOut, spawnFailed: false }));
  });
}

/** A failed attempt for S10: killed at the deadline, crashed, failed to start, or reported failure. */
export const isFailedAttempt = (result: ChildResult) =>
  result.timedOut || result.spawnFailed || result.signal !== null || result.code === null || result.code === EXIT.failed;

export interface WatchOptions {
  spec: ChildSpec;
  installationId: string;
  onResult?: (result: ChildResult, at: number) => void;
  /** Called for a failed attempt (the supervisor records it for S10). */
  onFailure?: (at: number) => void;
  spawnChild?: SpawnChild;
  deadlineMs?: number;
  cadenceMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Whether this watcher still owns the installation's scanning (checked before each scan). */
  stillOwned?: () => boolean;
  /** Called once when the watcher retires because another scheduler owns the installation. */
  onRetire?: () => void;
}

/** Consecutive "not owned" checks after which a watcher retires. */
export const RETIRE_AFTER_CHECKS = 2;

/** --watch: one isolated child scan, then the next after cadence + jitter. Stops on stop(). */
export class WatchSupervisor {
  private readonly options: WatchOptions;
  private handle: unknown = null;
  private stopped = false;
  private running: Promise<void> | null = null;
  private notOwned = 0;
  readonly delayMs: number;

  constructor(options: WatchOptions) {
    this.options = options;
    this.delayMs = (options.cadenceMs ?? HEALTH_LIMITS.scanCadenceMs) + installationJitterMs(options.installationId);
  }

  /** Runs the first scan now. */
  start(): void { this.stopped = false; this.tick(); }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.handle !== null) (this.options.clearTimer ?? (h => clearTimeout(h as NodeJS.Timeout)))(this.handle);
    this.handle = null;
    return this.running ?? Promise.resolve();
  }

  private tick(): void {
    if (this.stopped || this.running) return;
    let owned = true;
    try { owned = this.options.stillOwned?.() ?? true; } catch { owned = true; }
    this.notOwned = owned ? 0 : this.notOwned + 1;
    if (this.notOwned >= RETIRE_AFTER_CHECKS) {
      this.stopped = true;
      try { this.options.onRetire?.(); } catch { /* retiring never throws */ }
      return;
    }
    if (!owned) { this.schedule(); return; }
    const now = this.options.now ?? Date.now;
    this.running = runChildScan(this.options.spec, { ...(this.options.deadlineMs !== undefined ? { deadlineMs: this.options.deadlineMs } : {}), ...(this.options.spawnChild ? { spawnChild: this.options.spawnChild } : {}) })
      .then(result => {
        const at = now();
        if (isFailedAttempt(result)) this.options.onFailure?.(at);
        this.options.onResult?.(result, at);
      })
      .finally(() => {
        this.running = null;
        this.schedule();
      });
  }

  /** Schedules the next tick after completion: a timer that fires late (sleep) runs one scan, with no catch-up. */
  private schedule(): void {
    if (!this.stopped) this.handle = (this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => { this.handle = null; this.tick(); }, this.delayMs);
  }
}
