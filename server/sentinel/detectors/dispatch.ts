// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S07, exhausted dispatch (GAP-SENTINEL-109 section 5, class 7). Only the terminal turn outcome counts: a log that
// says "attempt 3" never proves exhaustion. Direct and room turns use the same definition. Each exhausted turn counts
// once, irrespective of refusal or rebuild volume. Digest only: the turn already shows its own outcome card.
import type { EngineKind } from "../../../shared/health-protocol.mjs";
import type { Coverage, Detector, DetectorInput, DetectorResult, EvidenceRef, Severity } from "../types.ts";
import { CORRELATION_SLOTS, type HighWater, evidenceFor, ingest, makeResult, maxSeverity, minuteEnd, minutesWindow, shortToken, tupleOf, worseCoverage } from "./common.ts";

export const DISPATCH_VERSION = 1;
/** High: at least this many distinct exhausted turns within DISPATCH_HIGH_MINUTES. */
export const DISPATCH_HIGH_TURNS = 3;
export const DISPATCH_HIGH_MINUTES = 15;
/** Recovery: this many complete active minutes with no exhaustion and at least DISPATCH_RECOVERY_TURNS completed turns. */
export const DISPATCH_RECOVERY_MINUTES = 30;
export const DISPATCH_RECOVERY_TURNS = 3;

/** [minute, engine, turn] for each exhausted turn inside the High window. */
export type ExhaustRow = readonly [number, string, string];
/** Per engine, since the last exhaustion: complete active minutes and completed turns. */
export type DispatchRecovery = { activeMinutes: number; completedTurns: number };
export type DispatchState = {
  hw: HighWater | null;
  rows: readonly ExhaustRow[];
  recovery: { readonly [engine: string]: DispatchRecovery };
  /** Rows were evicted at the cap: no threshold or recovery is established for windows ending at or before this minute. */
  partialUntil: number | null;
};

export const dispatchDetector: Detector<DispatchState> = {
  id: "dispatch-exhausted",
  version: DISPATCH_VERSION,
  evaluate(input: DetectorInput, prior: DispatchState | null) {
    const ingested = ingest(input, "dispatch-exhausted", ["turn-window"], prior?.hw ?? null);
    let rows: ExhaustRow[] = [...(prior?.rows ?? [])];
    const recovery: Record<string, DispatchRecovery> = {};
    for (const [engine, acc] of Object.entries(prior?.recovery ?? {})) recovery[engine] = { ...acc };
    let partialUntil = prior?.partialUntil ?? null;
    const triggered: Record<string, Severity | null> = {};
    const occurrences: Record<string, number> = {};
    const evidence: Record<string, EvidenceRef[]> = {};
    const affected: Record<string, number> = {};
    let latest: number | null = null;

    for (const iw of ingested.windows) {
      const m = iw.lastMinute;
      latest = Math.max(latest ?? m, m);
      if (!iw.ok) continue; // only fully covered minutes count; recovery accumulation freezes
      const exhaustedNow = new Set<string>();
      iw.window.facts.forEach((fact, index) => {
        if (fact.kind !== "turn-window" || fact.final === null) return;
        const engine = fact.engineKind;
        const turn = shortToken(fact.turnToken);
        if (fact.final === "exhausted") {
          if (rows.some(row => row[1] === engine && row[2] === turn)) return; // one turn counts once
          rows.push([m, engine, turn]);
          occurrences[engine] = (occurrences[engine] ?? 0) + 1;
          exhaustedNow.add(engine);
          (evidence[engine] ??= []).push(evidenceFor(iw, iw.window.counters.length + index));
          recovery[engine] = { activeMinutes: 0, completedTurns: 0 };
        }
      });
      // Completed turns arrive as counter rows (keyed per scope, or folded per engine), never as facts.
      for (const row of iw.window.counters) {
        if (row.detector !== "dispatch-exhausted" || row.code !== "completed") continue;
        const acc = recovery[row.engineKind];
        if (acc) acc.completedTurns += row.value;
      }
      // Window (m - 15, m]: prune, then cap (evicting the oldest makes the affected windows partial).
      rows = rows.filter(row => row[0] > m - DISPATCH_HIGH_MINUTES);
      if (rows.length > CORRELATION_SLOTS["dispatch-exhausted"]) {
        const dropped = rows.splice(0, rows.length - CORRELATION_SLOTS["dispatch-exhausted"]);
        partialUntil = Math.max(partialUntil ?? 0, dropped[dropped.length - 1]![0] + DISPATCH_HIGH_MINUTES);
      }
      const partial = partialUntil !== null && m <= partialUntil;
      for (const engine of exhaustedNow) {
        let severity: Severity = "medium";
        const turns = new Set(rows.filter(row => row[1] === engine).map(row => row[2])).size;
        affected[engine] = Math.max(affected[engine] ?? 0, turns);
        if (!partial && turns >= DISPATCH_HIGH_TURNS) severity = "high";
        triggered[engine] = maxSeverity(triggered[engine] ?? null, severity);
      }
      if (!partial && iw.window.activeMs > 0) {
        for (const [engine, acc] of Object.entries(recovery)) if (!exhaustedNow.has(engine)) acc.activeMinutes += iw.lastMinute - iw.firstMinute + 1;
      }
    }

    const results: DetectorResult[] = [];
    for (const [engine, acc] of Object.entries(recovery)) {
      const done = acc.activeMinutes >= DISPATCH_RECOVERY_MINUTES && acc.completedTurns >= DISPATCH_RECOVERY_TURNS;
      let coverage: Coverage = ingested.coverage;
      if (partialUntil !== null && latest !== null && latest <= partialUntil) coverage = worseCoverage(coverage, "partial");
      const end = latest ?? Math.ceil(input.now / 60_000);
      results.push(makeResult({
        tuple: tupleOf(input.installationId, "dispatch-exhausted", "dispatch", engine as EngineKind, null, "exhausted-turns"),
        triggered: triggered[engine] ?? null,
        occurrences: occurrences[engine] ?? 0,
        positive: acc.activeMinutes > 0 || acc.completedTurns > 0,
        complete: done,
        coverage,
        titleKey: "health.dispatch.exhausted-turns",
        window: triggered[engine] ? minutesWindow(end, DISPATCH_HIGH_MINUTES) : { startAt: minuteEnd(end) - acc.activeMinutes * 60_000, endAt: minuteEnd(end) },
        metrics: { activeMinutes: acc.activeMinutes, completedTurns: acc.completedTurns, exhaustedTurns: affected[engine] ?? 0 },
        ...(affected[engine] !== undefined ? { affectedTurns: affected[engine] } : {}),
        evidence: evidence[engine] ?? [],
      }));
      // A recovered engine stays (the map is bounded by the engine enum), so a scan whose lifecycle step was frozen
      // can still see the completed recovery on the next scan.
    }
    if (partialUntil !== null && latest !== null && latest > partialUntil) partialUntil = null;
    return { results, nextState: { hw: ingested.hw, rows, recovery, partialUntil } };
  },
};

/** The S07 fingerprint tuple for an engine, for S06/S08 presentation grouping. */
export const dispatchTuple = (installationId: string, engine: EngineKind) => tupleOf(installationId, "dispatch-exhausted", "dispatch", engine, null, "exhausted-turns");
