// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S08, continuation reset loop (GAP-SENTINEL-109 section 5, class 8). Counts automatic continuation resets per opaque
// scope from turn-window facts. Producer contract: `resetDelta` counts automatic resets only; owner-requested new
// sessions and engine changes (RESET_REASONS_NOT_AUTOMATIC) never enter it. One issue per engine, never one per
// thread: scopes are bounded contributors inside it. A grouped issue resolves only when every contributing scope has
// recovered; a contributor lost to the correlation cap keeps the issue unresolved with partial coverage until a full
// 30 complete active minutes pass with no automatic reset anywhere on that engine.
import type { EngineKind } from "../../../shared/health-protocol.mjs";
import { fingerprint, type Coverage, type Detector, type DetectorInput, type DetectorResult, type EvidenceRef, type Severity } from "../types.ts";
import { CORRELATION_SLOTS, type HighWater, MINUTE, evidenceFor, ingest, makeResult, maxSeverity, minuteEnd, minutesWindow, shortToken, tupleOf, worseCoverage } from "./common.ts";
import { dispatchTuple } from "./dispatch.ts";

export const RESETS_VERSION = 1;
/** Medium: at least 4 automatic resets in one scope within 10 minutes. */
export const RESETS_MEDIUM = 4;
export const RESETS_MINUTES = 10;
/** High: that loop also produces at least 3 distinct exhausted turns within 15 minutes (presented under S07). */
export const RESETS_HIGH_EXHAUSTED = 3;
export const RESETS_EXHAUSTED_MINUTES = 15;
/** Recovery per scope: 30 complete active minutes with at least 3 completed turns and at most 1 automatic reset. */
export const RESETS_RECOVERY_MINUTES = 30;
export const RESETS_RECOVERY_TURNS = 3;
export const RESETS_RECOVERY_MAX_RESETS = 1;

/** [minute, engine, scope, resets] per scope and minute; [minute, engine, scope, turn] per exhausted turn. */
export type ResetRow = readonly [number, string, string, number];
export type ExhaustedRow = readonly [number, string, string, string];
/** A contributing scope's recovery progress. */
export type ScopeRecovery = { engine: string; activeMinutes: number; completedTurns: number; resets: number };
export type ResetsState = {
  hw: HighWater | null;
  resets: readonly ResetRow[];
  exhausted: readonly ExhaustedRow[];
  /** Scopes that triggered and have not yet recovered. */
  contributors: { readonly [scope: string]: ScopeRecovery };
  /** Per engine: a contributor was evicted; value = complete active minutes since with zero automatic resets. */
  lost: { readonly [engine: string]: number };
  partialUntil: number | null;
  /** Engines seen (bounded by the engine enum); each keeps reporting so a recovery seen during a frozen scan is not lost. */
  engines: readonly string[];
};

export const resetsDetector: Detector<ResetsState> = {
  id: "resets",
  version: RESETS_VERSION,
  evaluate(input: DetectorInput, prior: ResetsState | null) {
    const ingested = ingest(input, "resets", ["turn-window"], prior?.hw ?? null);
    let resets: ResetRow[] = [...(prior?.resets ?? [])];
    let exhausted: ExhaustedRow[] = [...(prior?.exhausted ?? [])];
    const contributors: Record<string, ScopeRecovery> = {};
    for (const [scope, acc] of Object.entries(prior?.contributors ?? {})) contributors[scope] = { ...acc };
    const lost: Record<string, number> = { ...(prior?.lost ?? {}) };
    let partialUntil = prior?.partialUntil ?? null;
    const triggered: Record<string, Severity | null> = {};
    const occurrences: Record<string, number> = {};
    const evidence: Record<string, EvidenceRef[]> = {};
    const engines = new Set<string>([...(prior?.engines ?? []), ...Object.values(contributors).map(c => c.engine), ...Object.keys(lost)]);
    let latest: number | null = null;
    const slots = CORRELATION_SLOTS.resets;

    for (const iw of ingested.windows) {
      const m = iw.lastMinute;
      latest = Math.max(latest ?? m, m);
      if (!iw.ok) continue;
      const touchedScopes = new Set<string>();
      const resetEngines = new Set<string>();
      iw.window.facts.forEach((fact, index) => {
        if (fact.kind !== "turn-window") return;
        const engine = fact.engineKind;
        const scope = shortToken(fact.scopeToken);
        const turn = shortToken(fact.turnToken);
        engines.add(engine);
        if (fact.resetDelta > 0) {
          const at = resets.findIndex(row => row[0] === m && row[2] === scope);
          if (at >= 0) resets[at] = [m, engine, scope, resets[at]![3] + fact.resetDelta];
          else resets.push([m, engine, scope, fact.resetDelta]);
          touchedScopes.add(scope);
          resetEngines.add(engine);
          occurrences[engine] = (occurrences[engine] ?? 0) + fact.resetDelta;
          (evidence[engine] ??= []).push(evidenceFor(iw, iw.window.counters.length + index));
          const acc = contributors[scope];
          if (acc) acc.resets += fact.resetDelta;
        }
        if (fact.final === "exhausted" && !exhausted.some(row => row[2] === scope && row[3] === turn)) {
          exhausted.push([m, engine, scope, turn]);
          touchedScopes.add(scope);
        }
      });
      // Completed turns per scope: the keyed S07 counter rows (a row folded past the keyed cap names no scope).
      for (const row of iw.window.counters) {
        if (row.detector !== "dispatch-exhausted" || row.code !== "completed" || row.sourceKey === undefined) continue;
        const acc = contributors[shortToken(row.sourceKey)];
        if (acc) acc.completedTurns += row.value;
      }
      resets = resets.filter(row => row[0] > m - RESETS_MINUTES);
      exhausted = exhausted.filter(row => row[0] > m - RESETS_EXHAUSTED_MINUTES);
      // Shared slot budget: rows plus contributors. Evict the oldest rows first, then the oldest contributors.
      const over = resets.length + exhausted.length + Object.keys(contributors).length - slots;
      if (over > 0) {
        let left = over;
        const dropR = Math.min(left, resets.length); const droppedR = resets.splice(0, dropR); left -= dropR;
        const dropE = Math.min(left, exhausted.length); const droppedE = exhausted.splice(0, dropE); left -= dropE;
        const lastDropped = Math.max(droppedR.at(-1)?.[0] ?? 0, droppedE.at(-1)?.[0] ?? 0);
        if (lastDropped) partialUntil = Math.max(partialUntil ?? 0, lastDropped + RESETS_EXHAUSTED_MINUTES);
        for (const scope of Object.keys(contributors).slice(0, Math.max(0, left))) {
          lost[contributors[scope]!.engine] = 0;
          delete contributors[scope];
        }
      }
      const partial = partialUntil !== null && m <= partialUntil;
      for (const scope of touchedScopes) {
        if (partial) continue;
        const mine = resets.filter(row => row[2] === scope);
        const count = mine.reduce((total, row) => total + row[3], 0);
        if (count < RESETS_MEDIUM) continue;
        const engine = mine[mine.length - 1]![1];
        const turns = new Set(exhausted.filter(row => row[2] === scope).map(row => row[3])).size;
        const severity: Severity = turns >= RESETS_HIGH_EXHAUSTED ? "high" : "medium";
        triggered[engine] = maxSeverity(triggered[engine] ?? null, severity);
        contributors[scope] = { engine, activeMinutes: 0, completedTurns: 0, resets: 0 };
      }
      if (!partial && iw.window.activeMs > 0) {
        const span = iw.lastMinute - iw.firstMinute + 1;
        for (const [scope, acc] of Object.entries(contributors)) {
          if (touchedScopes.has(scope) && triggered[acc.engine]) continue;
          if (acc.resets > RESETS_RECOVERY_MAX_RESETS) { contributors[scope] = { ...acc, activeMinutes: 0, completedTurns: 0, resets: 0 }; continue; }
          acc.activeMinutes += span;
        }
        for (const engine of Object.keys(lost)) lost[engine] = resetEngines.has(engine) ? 0 : lost[engine]! + span;
      }
    }

    const results: DetectorResult[] = [];
    for (const engine of engines) {
      const mine = Object.values(contributors).filter(acc => acc.engine === engine);
      const scopeDone = (acc: ScopeRecovery) => acc.activeMinutes >= RESETS_RECOVERY_MINUTES && acc.completedTurns >= RESETS_RECOVERY_TURNS && acc.resets <= RESETS_RECOVERY_MAX_RESETS;
      const lostOpen = lost[engine] !== undefined && lost[engine]! < RESETS_RECOVERY_MINUTES;
      const done = !lostOpen && mine.every(scopeDone);
      const end = latest ?? Math.ceil(input.now / MINUTE);
      let coverage: Coverage = ingested.coverage;
      if (lostOpen || (partialUntil !== null && end <= partialUntil)) coverage = worseCoverage(coverage, "partial");
      const severity = triggered[engine] ?? null;
      const s07 = fingerprint(dispatchTuple(input.installationId, engine as EngineKind));
      results.push(makeResult({
        tuple: tupleOf(input.installationId, "resets", "engine", engine as EngineKind, null, "reset-loop"),
        triggered: severity,
        occurrences: occurrences[engine] ?? 0,
        positive: mine.some(acc => acc.activeMinutes > 0) || mine.length === 0,
        complete: done,
        coverage,
        titleKey: "health.resets.loop",
        window: severity ? minutesWindow(end, RESETS_MINUTES) : { startAt: minuteEnd(end) - RESETS_RECOVERY_MINUTES * MINUTE, endAt: minuteEnd(end) },
        metrics: { loopingScopes: mine.length, recoveredScopes: mine.filter(scopeDone).length },
        evidence: evidence[engine] ?? [],
        relatedFingerprints: [s07],
        ...(severity === "high" ? { presentedBy: s07 } : {}),
      }));
      if (done) {
        for (const [scope, acc] of Object.entries(contributors)) if (acc.engine === engine) delete contributors[scope];
        delete lost[engine];
      }
    }
    if (partialUntil !== null && latest !== null && latest > partialUntil) partialUntil = null;
    return { results, nextState: { hw: ingested.hw, resets, exhausted, contributors, lost, partialUntil, engines: [...engines] } };
  },
};
