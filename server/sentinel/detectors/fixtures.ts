// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Synthetic, validated inputs for the Sentinel detector tests. Every window passes the frozen producer validator, so a
// test can never rely on a shape the real producers could not publish. No IO, no clock reads.
import {
  parseOperationalWindow, type BackupStatus, type CounterRow, type Fact, type IoMinuteFact, type ObligationFact, type OperationalWindow, type TurnWindowFact,
} from "../../../shared/health-protocol.mjs";
import type { Detector, DetectorInput, DetectorResult, DetectorState } from "../types.ts";

export const INST = "0123456789abcdef0123456789abcdef";
export const SK = "fedcba9876543210";
export const MIN = 60_000;
export const HOUR_MS = 60 * MIN;
/** Minute-aligned base time. Window i ends at T0 + i minutes. */
export const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);
export const at = (minute: number) => T0 + minute * MIN;
/** Awake clock offset: awake time is wall time minus this, unless a test says otherwise. */
export const AWAKE_BASE = 1_000_000;
/** A distinct 16-hex-character opaque token per (prefix, n). */
export const tok = (n: number, prefix = "a") => `${prefix}${n.toString(16).padStart(15, "0")}`;

export interface WinOpts {
  producer?: "server" | "desktop";
  epoch?: number;
  seq?: number;
  complete?: boolean;
  coverage?: OperationalWindow["coverageByDetector"];
  counters?: CounterRow[];
  facts?: Fact[];
  activeMs?: number;
  lifecycle?: OperationalWindow["lifecycle"];
  span?: number;
}

/** A validated window ending at minute i. */
export function win(i: number, opts: WinOpts = {}): OperationalWindow {
  const span = opts.span ?? 1;
  const raw = {
    schemaVersion: 1, installationId: INST, producer: opts.producer ?? "server", epoch: opts.epoch ?? 1, seq: opts.seq ?? i,
    startAt: at(i - span), endAt: at(i), activeMs: opts.activeMs ?? Math.min(60_000, span * MIN), complete: opts.complete ?? true, omitted: 0,
    coverageByDetector: opts.coverage ?? {}, counters: opts.counters ?? [], facts: opts.facts ?? [], lifecycle: opts.lifecycle ?? "running",
  };
  const parsed = parseOperationalWindow(raw);
  if (!parsed.ok) throw new Error(`fixture window invalid: ${parsed.reason}`);
  return parsed.value;
}

export interface InputOpts {
  now?: number;
  awake?: number;
  previousAwake?: number | null;
  discontinuity?: boolean;
  windows?: OperationalWindow[];
  desktop?: OperationalWindow[];
  backupStatus?: BackupStatus | null;
  dbStats?: DetectorInput["dbStats"];
  sourceCoverage?: DetectorInput["sourceCoverage"];
  scanFailures?: number[];
}

export function input(opts: InputOpts = {}): DetectorInput {
  const windows = opts.windows ?? [];
  const lastEnd = windows.length ? Math.max(...windows.map(w => w.endAt)) : T0;
  const now = opts.now ?? lastEnd;
  const out: DetectorInput = {
    installationId: INST, now,
    awake: { awakeNowMs: opts.awake ?? now - T0 + AWAKE_BASE, previousAwakeMs: opts.previousAwake ?? null, discontinuity: opts.discontinuity ?? false },
    windows: { server: windows, desktop: opts.desktop ?? [] },
    backupStatus: opts.backupStatus ?? null,
    dbStats: opts.dbStats ?? null,
    sourceCoverage: opts.sourceCoverage ?? { server: "complete" },
  };
  if (opts.scanFailures) out.scanFailures = opts.scanFailures;
  return out;
}

/** Runs a detector over successive scans, threading its state. Returns every scan's results and the final state. */
export function scans<S extends DetectorState>(detector: Detector<S>, inputs: DetectorInput[], start: S | null = null) {
  let state = start;
  const all: DetectorResult[][] = [];
  for (const one of inputs) {
    const out = detector.evaluate(one, state);
    all.push([...out.results]);
    state = out.nextState;
  }
  return { results: all, last: all[all.length - 1] ?? [], state };
}

/** One scan per window (the normal two-minute cadence folded to one window per scan). */
export function perWindow<S extends DetectorState>(detector: Detector<S>, windows: OperationalWindow[], start: S | null = null, extra: InputOpts = {}) {
  return scans(detector, windows.map(w => input({ ...extra, windows: [w] })), start);
}

export const byClass = (results: readonly DetectorResult[], errorClass: string) => results.find(r => r.tuple.errorClass === errorClass);
export const byEngine = (results: readonly DetectorResult[], engine: string) => results.find(r => r.tuple.engineKind === engine);

const MiB = 1024 * 1024;
export function io(bytes: number, opts: Partial<IoMinuteFact> = {}): IoMinuteFact {
  return {
    kind: "io-minute", idle: true, intervalMs: 60_000, osBytes: null, applicationBytes: bytes, plannedBytesAllowed: 0, chargedBytes: bytes,
    budgetBytes: MiB, cpuFraction: 0.1, pollScale: 1, sourceClass: "messages-db", discontinuity: false, ...opts,
  };
}
export const MIB = MiB;

export function obligation(opts: Partial<ObligationFact> = {}): ObligationFact {
  const fact: ObligationFact = {
    kind: "obligation", engineKind: "claude", code: "deletion", pendingCount: 1, oldestPendingAt: T0 - HOUR_MS, holderState: "held",
    failedAttemptsAfterClear: 0, completedDelta: 0, observedAt: T0, ...opts,
  };
  return fact;
}

/** Completed turns as the producer reports them: an S07 counter row, keyed by the scope's token (null: folded per engine). */
export function completedRow(value: number, scope: number | null = 1, engineKind: CounterRow["engineKind"] = "claude"): CounterRow {
  return { detector: "dispatch-exhausted", engineKind, code: "completed", value, ...(scope === null ? {} : { sourceKey: tok(scope, "c") }) };
}

export function turn(opts: Partial<TurnWindowFact> & { n?: number; scope?: number } = {}): TurnWindowFact {
  const { n = 1, scope = 1, ...rest } = opts;
  return {
    kind: "turn-window", scopeToken: tok(scope, "c"), turnToken: tok(n, "b"), engineKind: "claude", at: T0, refusalDelta: 0, rebuildMsDelta: 0, resetDelta: 0, final: null, ...rest,
  };
}
