// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S09, front-matter fallback (GAP-SENTINEL-109 section 5, class 9). Counts the fixed fallback code only; it never
// ingests the file or its name. Normal fallback is a count, not an issue. Low only, never a count-based High.
// One issue per engine; the engine launches that triggered are its contributors. A contributor resolves after a later
// completed isolation scan plus 30 complete minutes with zero fallback, or retires when a newer launch replaces it.
import type { EngineKind } from "../../../shared/health-protocol.mjs";
import type { Coverage, Detector, DetectorInput, DetectorResult, EvidenceRef } from "../types.ts";
import { CORRELATION_SLOTS, type HighWater, MINUTE, evidenceFor, ingest, makeResult, minuteEnd, minutesWindow, shortToken, tupleOf, worseCoverage } from "./common.ts";

export const ISOLATION_VERSION = 1;
/** Low: at least 20 fallbacks within 10 minutes in one engine launch. */
export const ISOLATION_FALLBACKS = 20;
export const ISOLATION_MINUTES = 10;
/** Recovery: after a later completed scan, 30 complete consecutive minutes with zero fallback in that launch. */
export const ISOLATION_RECOVERY_MINUTES = 30;

/** [minute, engine, launch, fallbacks]. */
export type IsolationRow = readonly [number, string, string, number];
export type LaunchRecovery = { engine: string; scanned: number; calmMinutes: number; lastMinute: number | null; retired: number };
export type IsolationState = {
  hw: HighWater | null;
  rows: readonly IsolationRow[];
  /** Launches that triggered and have not recovered or retired. */
  contributors: { readonly [launch: string]: LaunchRecovery };
  /** Latest launch seen per engine: a newer launch retires the older ones. */
  current: { readonly [engine: string]: string };
  /** Engines seen (bounded by the engine enum). */
  engines: readonly string[];
  /** A contributor was evicted at the cap for these engines: they cannot recover until a newer launch replaces it. */
  lost: { readonly [engine: string]: string };
};

export const isolationNoiseDetector: Detector<IsolationState> = {
  id: "isolation-noise",
  version: ISOLATION_VERSION,
  evaluate(input: DetectorInput, prior: IsolationState | null) {
    const ingested = ingest(input, "isolation-noise", ["isolation"], prior?.hw ?? null);
    let rows: IsolationRow[] = [...(prior?.rows ?? [])];
    const contributors: Record<string, LaunchRecovery> = {};
    for (const [launch, acc] of Object.entries(prior?.contributors ?? {})) contributors[launch] = { ...acc };
    const current: Record<string, string> = { ...(prior?.current ?? {}) };
    const lost: Record<string, string> = { ...(prior?.lost ?? {}) };
    const engines = new Set<string>(prior?.engines ?? []);
    const triggered = new Set<string>();
    const occurrences: Record<string, number> = {};
    const evidence: Record<string, EvidenceRef[]> = {};
    let latest: number | null = null;

    for (const iw of ingested.windows) {
      const m = iw.lastMinute;
      latest = Math.max(latest ?? m, m);
      const fallbackBy = new Map<string, number>();
      iw.window.facts.forEach((fact, index) => {
        if (fact.kind !== "isolation") return;
        const engine = fact.engineKind;
        const launch = shortToken(fact.launchToken);
        engines.add(engine);
        if (current[engine] !== launch) {
          // A newer launch for this engine retires every older launch of it.
          for (const acc of Object.values(contributors)) if (acc.engine === engine) acc.retired = 1;
          if (lost[engine] !== undefined && lost[engine] !== launch) delete lost[engine];
          current[engine] = launch;
        }
        if (!iw.ok) return;
        if (fact.fallbackDelta > 0) {
          fallbackBy.set(launch, (fallbackBy.get(launch) ?? 0) + fact.fallbackDelta);
          const at = rows.findIndex(row => row[0] === m && row[2] === launch);
          if (at >= 0) rows[at] = [m, engine, launch, rows[at]![3] + fact.fallbackDelta];
          else rows.push([m, engine, launch, fact.fallbackDelta]);
          occurrences[engine] = (occurrences[engine] ?? 0) + fact.fallbackDelta;
          (evidence[engine] ??= []).push(evidenceFor(iw, iw.window.counters.length + index));
        }
        const acc = contributors[launch];
        if (acc && fact.completedScan) acc.scanned = 1;
      });
      rows = rows.filter(row => row[0] > m - ISOLATION_MINUTES);
      const over = rows.length + Object.keys(contributors).length - CORRELATION_SLOTS["isolation-noise"];
      if (over > 0) {
        const fromRows = Math.min(over, rows.length);
        rows.splice(0, fromRows);
        for (const launch of Object.keys(contributors).slice(0, over - fromRows)) { lost[contributors[launch]!.engine] = launch; delete contributors[launch]; }
      }
      if (iw.ok) {
        for (const launch of fallbackBy.keys()) {
          const sum = rows.filter(row => row[2] === launch).reduce((n, row) => n + row[3], 0);
          if (sum < ISOLATION_FALLBACKS) continue;
          const engine = rows.find(row => row[2] === launch)![1];
          triggered.add(engine);
          contributors[launch] = { engine, scanned: 0, calmMinutes: 0, lastMinute: m, retired: 0 };
        }
      }
      // Recovery: consecutive complete minutes with zero fallback, counted only after a completed scan.
      for (const [launch, acc] of Object.entries(contributors)) {
        if (acc.retired || (triggered.has(acc.engine) && acc.lastMinute === m && acc.calmMinutes === 0 && !acc.scanned)) continue;
        const contiguous = acc.lastMinute === null || iw.firstMinute === acc.lastMinute + 1;
        if (!iw.ok || !contiguous || (fallbackBy.get(launch) ?? 0) > 0) acc.calmMinutes = 0;
        else if (acc.scanned) acc.calmMinutes += iw.lastMinute - iw.firstMinute + 1;
        acc.lastMinute = m;
      }
    }

    const results: DetectorResult[] = [];
    for (const engine of engines) {
      const mine = Object.entries(contributors).filter(([, acc]) => acc.engine === engine);
      const recovered = mine.filter(([, acc]) => !acc.retired && acc.calmMinutes >= ISOLATION_RECOVERY_MINUTES);
      const retired = mine.filter(([, acc]) => acc.retired);
      const lostOpen = lost[engine] !== undefined;
      const allSettled = !lostOpen && mine.length > 0 && recovered.length + retired.length === mine.length;
      const onlyRetired = allSettled && recovered.length === 0;
      const end = latest ?? Math.ceil(input.now / MINUTE);
      let coverage: Coverage = ingested.coverage;
      if (lostOpen) coverage = worseCoverage(coverage, "partial");
      const isTriggered = triggered.has(engine);
      results.push(makeResult({
        tuple: tupleOf(input.installationId, "isolation-noise", "engine", engine as EngineKind, null, "front-matter-fallback"),
        triggered: isTriggered ? "low" : null,
        occurrences: occurrences[engine] ?? 0,
        positive: !lostOpen && (mine.length === 0 || mine.some(([, acc]) => acc.calmMinutes > 0 || acc.retired === 1)),
        complete: !lostOpen && (mine.length === 0 || (allSettled && !onlyRetired)),
        coverage,
        ...(onlyRetired && !isTriggered ? { retired: "source-retired" as const } : {}),
        titleKey: "health.isolation-noise.fallback",
        window: isTriggered ? minutesWindow(end, ISOLATION_MINUTES) : { startAt: minuteEnd(end) - ISOLATION_RECOVERY_MINUTES * MINUTE, endAt: minuteEnd(end) },
        metrics: { recentFallbacks: rows.filter(row => row[1] === engine).reduce((n, row) => n + row[3], 0), noisyLaunches: mine.length },
        evidence: evidence[engine] ?? [],
      }));
      if (allSettled && !isTriggered) for (const [launch] of mine) delete contributors[launch];
    }
    return { results, nextState: { hw: ingested.hw, rows, contributors, current, engines: [...engines], lost } };
  },
};
