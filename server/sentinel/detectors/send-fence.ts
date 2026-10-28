// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S06, send-fence rebuilding (GAP-SENTINEL-109 section 5, class 6). Individual refused reads are normal enforcement;
// only many refusals across many turns with slow rebuilds make an issue. When every affected turn in the trigger
// window ended exhausted, the row is presented under S07 (presentedBy), keeping both fingerprints.
import type { EngineKind } from "../../../shared/health-protocol.mjs";
import { fingerprint, type Coverage, type Detector, type DetectorInput, type DetectorResult, type EvidenceRef } from "../types.ts";
import { CORRELATION_SLOTS, type HighWater, MINUTE, evidenceFor, ingest, makeResult, minuteEnd, minutesWindow, shortToken, tupleOf, worseCoverage } from "./common.ts";
import { dispatchTuple } from "./dispatch.ts";

export const SEND_FENCE_VERSION = 1;
/** Medium: in 15 minutes, at least 10 refusals over at least 5 distinct turns, and at least 3 of those turns with
 * rebuild delay of at least 5 s. */
export const FENCE_MINUTES = 15;
export const FENCE_REFUSALS = 10;
export const FENCE_TURNS = 5;
export const FENCE_SLOW_TURNS = 3;
export const FENCE_SLOW_MS = 5_000;
/** Recovery: 30 complete active minutes with fewer than 3 affected turns and no exhausted dispatch. */
export const FENCE_RECOVERY_MINUTES = 30;
export const FENCE_RECOVERY_MAX_TURNS = 3;

/** [minute, engine, turn, refusals, rebuildMs, exhausted 0|1] per turn and minute. */
export type FenceRow = readonly [number, string, string, number, number, number];
export type FenceRecovery = { activeMinutes: number; affected: readonly string[]; exhausted: number };
export type FenceState = {
  hw: HighWater | null;
  rows: readonly FenceRow[];
  recovery: { readonly [engine: string]: FenceRecovery };
  partialUntil: number | null;
};

export const sendFenceDetector: Detector<FenceState> = {
  id: "send-fence",
  version: SEND_FENCE_VERSION,
  evaluate(input: DetectorInput, prior: FenceState | null) {
    const ingested = ingest(input, "send-fence", ["turn-window"], prior?.hw ?? null);
    let rows: FenceRow[] = [...(prior?.rows ?? [])];
    const recovery: Record<string, { activeMinutes: number; affected: string[]; exhausted: number }> = {};
    for (const [engine, acc] of Object.entries(prior?.recovery ?? {})) recovery[engine] = { ...acc, affected: [...acc.affected] };
    let partialUntil = prior?.partialUntil ?? null;
    const triggered = new Set<string>();
    const suppressed: Record<string, boolean> = {};
    const occurrences: Record<string, number> = {};
    const affectedTurns: Record<string, number> = {};
    const evidence: Record<string, EvidenceRef[]> = {};
    let latest: number | null = null;

    for (const iw of ingested.windows) {
      const m = iw.lastMinute;
      latest = Math.max(latest ?? m, m);
      if (!iw.ok) continue;
      const touched = new Set<string>();
      iw.window.facts.forEach((fact, index) => {
        if (fact.kind !== "turn-window") return;
        const engine = fact.engineKind;
        const turn = shortToken(fact.turnToken);
        const exhausted = fact.final === "exhausted" ? 1 : 0;
        if (fact.refusalDelta === 0 && fact.rebuildMsDelta === 0 && !exhausted) return;
        const at = rows.findIndex(row => row[0] === m && row[1] === engine && row[2] === turn);
        if (at >= 0) {
          const row = rows[at]!;
          rows[at] = [m, engine, turn, row[3] + fact.refusalDelta, row[4] + fact.rebuildMsDelta, row[5] || exhausted];
        } else {
          rows.push([m, engine, turn, fact.refusalDelta, fact.rebuildMsDelta, exhausted]);
        }
        // An exhausted final marks every earlier row of that turn, so S07 ownership can be checked.
        if (exhausted) rows = rows.map(row => (row[1] === engine && row[2] === turn ? [row[0], row[1], row[2], row[3], row[4], 1] : row));
        touched.add(engine);
        if (fact.refusalDelta > 0) {
          occurrences[engine] = (occurrences[engine] ?? 0) + fact.refusalDelta;
          (evidence[engine] ??= []).push(evidenceFor(iw, iw.window.counters.length + index));
          const acc = (recovery[engine] ??= { activeMinutes: 0, affected: [], exhausted: 0 });
          if (!acc.affected.includes(turn) && acc.affected.length < FENCE_RECOVERY_MAX_TURNS) acc.affected.push(turn);
        }
        if (exhausted && recovery[engine]) recovery[engine]!.exhausted = 1;
      });
      rows = rows.filter(row => row[0] > m - FENCE_MINUTES);
      if (rows.length > CORRELATION_SLOTS["send-fence"]) {
        const dropped = rows.splice(0, rows.length - CORRELATION_SLOTS["send-fence"]);
        partialUntil = Math.max(partialUntil ?? 0, dropped[dropped.length - 1]![0] + FENCE_MINUTES);
      }
      const partial = partialUntil !== null && m <= partialUntil;
      for (const engine of touched) {
        if (partial) continue; // an evicted turn cannot establish a threshold
        const mine = rows.filter(row => row[1] === engine);
        const perTurn = new Map<string, { refusals: number; rebuildMs: number; exhausted: boolean }>();
        for (const row of mine) {
          const t = perTurn.get(row[2]) ?? { refusals: 0, rebuildMs: 0, exhausted: false };
          t.refusals += row[3]; t.rebuildMs += row[4]; t.exhausted ||= row[5] === 1;
          perTurn.set(row[2], t);
        }
        const refused = [...perTurn.values()].filter(t => t.refusals > 0);
        const refusals = refused.reduce((total, t) => total + t.refusals, 0);
        const slow = refused.filter(t => t.rebuildMs >= FENCE_SLOW_MS).length;
        if (refusals >= FENCE_REFUSALS && refused.length >= FENCE_TURNS && slow >= FENCE_SLOW_TURNS) {
          triggered.add(engine);
          affectedTurns[engine] = Math.max(affectedTurns[engine] ?? 0, refused.length);
          // Grouping: suppressed under S07 only when every affected turn ended exhausted.
          suppressed[engine] = refused.every(t => t.exhausted);
          recovery[engine] = { activeMinutes: 0, affected: [], exhausted: 0 };
        }
      }
      if (!partial && iw.window.activeMs > 0) {
        for (const [engine, acc] of Object.entries(recovery)) {
          if (triggered.has(engine) && touched.has(engine)) continue;
          if (acc.affected.length >= FENCE_RECOVERY_MAX_TURNS || acc.exhausted) { recovery[engine] = { activeMinutes: 0, affected: [], exhausted: 0 }; continue; }
          acc.activeMinutes += iw.lastMinute - iw.firstMinute + 1;
        }
      }
    }

    const results: DetectorResult[] = [];
    for (const [engine, acc] of Object.entries(recovery)) {
      const end = latest ?? Math.ceil(input.now / MINUTE);
      let coverage: Coverage = ingested.coverage;
      if (partialUntil !== null && end <= partialUntil) coverage = worseCoverage(coverage, "partial");
      const s07 = fingerprint(dispatchTuple(input.installationId, engine as EngineKind));
      const isTriggered = triggered.has(engine);
      results.push(makeResult({
        tuple: tupleOf(input.installationId, "send-fence", "engine", engine as EngineKind, null, "fence-rebuilding"),
        triggered: isTriggered ? "medium" : null,
        occurrences: occurrences[engine] ?? 0,
        positive: acc.activeMinutes > 0,
        complete: acc.activeMinutes >= FENCE_RECOVERY_MINUTES && acc.affected.length < FENCE_RECOVERY_MAX_TURNS && acc.exhausted === 0,
        coverage,
        titleKey: "health.send-fence.rebuilding",
        window: isTriggered ? minutesWindow(end, FENCE_MINUTES) : { startAt: minuteEnd(end) - acc.activeMinutes * MINUTE, endAt: minuteEnd(end) },
        metrics: { activeMinutes: acc.activeMinutes, recentAffectedTurns: acc.affected.length },
        ...(affectedTurns[engine] !== undefined ? { affectedTurns: affectedTurns[engine] } : {}),
        evidence: evidence[engine] ?? [],
        relatedFingerprints: [s07],
        ...(isTriggered && suppressed[engine] ? { presentedBy: s07 } : {}),
      }));
    }
    if (partialUntil !== null && latest !== null && latest > partialUntil) partialUntil = null;
    return { results, nextState: { hw: ingested.hw, rows, recovery, partialUntil } };
  },
};
