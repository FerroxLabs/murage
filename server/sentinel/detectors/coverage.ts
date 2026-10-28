// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S10, monitoring coverage and scanner health (GAP-SENTINEL-109 section 5). Reports when Sentinel's own inputs go
// quiet, stale or unreadable, so the owner never sees "all clear" built on inputs nobody could read. A scanner
// heartbeat older than 30 minutes is surfaced by the host, not here (a missing scanner cannot report itself).
// Coverage restores after two complete scans at least 120 s apart with the class's sources fresh.
import { EVIDENCE_SOURCE_ROLES } from "../../../shared/health-protocol.mjs";
import type { Detector, DetectorInput, DetectorResult, EvidenceRef } from "../types.ts";
import { MINUTE, makeResult, tupleOf } from "./common.ts";

export const COVERAGE_VERSION = 1;
/** A running producer with no complete record for this many awake minutes. */
export const COVERAGE_SILENT_AWAKE_MS = 10 * MINUTE;
/** A required stats snapshot older than this while the app is active (strictly older). */
export const COVERAGE_STATS_MAX_AGE_MS = 45 * MINUTE;
/** At least this many failed scan attempts within COVERAGE_SCAN_FAIL_WINDOW_MS. */
export const COVERAGE_SCAN_FAILS = 3;
export const COVERAGE_SCAN_FAIL_WINDOW_MS = 10 * MINUTE;
/** Recovery: two fresh scans at least this far apart. */
export const COVERAGE_RECOVERY_GAP_MS = 120_000;

const RUNNING = new Set(["running", "resumed"]);

export type ProducerTrack = { running: number; lastCompleteAwake: number | null; lastAt: number | null };
export type CoverageState = {
  awake: number | null;
  producers: { readonly [producer: string]: ProducerTrack };
  /** Awake clock when the server producer was first seen running without a stats snapshot, or null. */
  statsWaitSince: number | null;
  /** Per class: UTC ms of the first fresh scan in the current fresh stretch, or null. */
  freshSince: { readonly [cls: string]: number | null };
  /** Classes whose condition held at the previous scan: a new onset counts one occurrence. */
  held: { readonly [cls: string]: number };
};

export const coverageDetector: Detector<CoverageState> = {
  id: "coverage",
  version: COVERAGE_VERSION,
  evaluate(input: DetectorInput, prior: CoverageState | null) {
    const awakeNow = input.awake.awakeNowMs;
    const rebased = prior?.awake != null && awakeNow < prior.awake;
    const producers: Record<string, ProducerTrack> = {};
    for (const [name, track] of Object.entries(prior?.producers ?? {})) producers[name] = { ...track, lastCompleteAwake: rebased && track.lastCompleteAwake !== null ? awakeNow : track.lastCompleteAwake };
    const freshSince: Record<string, number | null> = { ...(prior?.freshSince ?? {}) };
    let statsWaitSince = rebased && prior?.statsWaitSince != null ? awakeNow : prior?.statsWaitSince ?? null;
    const freshProducer = new Set<string>();
    const held: Record<string, number> = {};

    for (const producer of ["server", "desktop"] as const) {
      for (const window of input.windows[producer]) {
        if (window.installationId !== input.installationId || window.endAt > input.now) continue;
        const track = (producers[producer] ??= { running: 0, lastCompleteAwake: awakeNow, lastAt: null });
        if (track.lastAt !== null && window.endAt <= track.lastAt) continue;
        track.lastAt = window.endAt;
        track.running = RUNNING.has(window.lifecycle) ? 1 : 0;
        if (window.complete) { track.lastCompleteAwake = awakeNow; freshProducer.add(producer); }
      }
    }

    const results: DetectorResult[] = [];
    const emit = (cls: string, triggered: boolean, fresh: boolean, metrics: Record<string, number>, evidence: EvidenceRef[] = []) => {
      let since = freshSince[cls] ?? null;
      if (triggered || !fresh) since = null;
      else if (since === null) since = input.now;
      freshSince[cls] = since;
      if (triggered) held[cls] = 1;
      results.push(makeResult({
        tuple: tupleOf(input.installationId, "coverage", "monitoring", null, null, cls),
        triggered: triggered ? "medium" : null,
        occurrences: triggered && prior?.held[cls] !== 1 ? 1 : 0,
        positive: since !== null,
        complete: since !== null && input.now - since >= COVERAGE_RECOVERY_GAP_MS,
        coverage: "complete",
        titleKey: `health.coverage.${cls}`,
        window: { startAt: input.now - COVERAGE_SCAN_FAIL_WINDOW_MS, endAt: input.now },
        metrics,
        evidence,
      }));
    };

    // A running producer that has gone quiet.
    for (const [producer, track] of Object.entries(producers)) {
      const quietMs = track.lastCompleteAwake === null ? null : awakeNow - track.lastCompleteAwake;
      const silent = track.running === 1 && quietMs !== null && quietMs >= COVERAGE_SILENT_AWAKE_MS;
      emit(`producer-silent-${producer}`, silent, freshProducer.has(producer) || track.running === 0, quietMs === null ? {} : { quietAwakeMin: Math.floor(quietMs / MINUTE) });
    }

    // A stale required stats snapshot while the app is active.
    const active = producers.server?.running === 1;
    const stats = input.dbStats && input.dbStats.manifest.installationId === input.installationId ? input.dbStats : null;
    if (!active || stats !== null) statsWaitSince = null;
    else statsWaitSince ??= awakeNow;
    const ageMs = stats === null ? null : input.now - stats.manifest.at;
    const stale = active && (ageMs !== null ? ageMs > COVERAGE_STATS_MAX_AGE_MS : statsWaitSince !== null && awakeNow - statsWaitSince > COVERAGE_STATS_MAX_AGE_MS);
    if (active || freshSince["stats-stale"] !== undefined) {
      emit("stats-stale", stale, !stale, ageMs === null ? {} : { statsAgeMin: Math.floor(ageMs / MINUTE) }, stats ? [{ sourceRole: "db-stats", generation: stats.manifest.generation, observedAt: stats.manifest.at }] : []);
    }

    // Repeated scan failures: (now - 10 min, now].
    const failures = (input.scanFailures ?? []).filter(at => at > input.now - COVERAGE_SCAN_FAIL_WINDOW_MS && at <= input.now).length;
    emit("scan-failing", failures >= COVERAGE_SCAN_FAILS, failures < COVERAGE_SCAN_FAILS, { failedScans: failures });

    // Unknown schema, path or permission: immediately reported as unavailable coverage.
    for (const role of EVIDENCE_SOURCE_ROLES) {
      if (role === "other") continue;
      const value = input.sourceCoverage[role];
      const cls = `source-unavailable-${role}`;
      if (value === undefined && freshSince[cls] === undefined) continue;
      emit(cls, value === "unavailable", value === "complete" || value === "not-applicable", {});
    }

    return { results, nextState: { awake: awakeNow, producers, statsWaitSince, freshSince, held } };
  },
};
