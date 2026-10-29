// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test support for the server producer's counters (not a test file): a fresh epoch, and the windows recorded since,
// read on the counters' own clock (the real one; fake Date timers in a test do not move it).
import { serverHealthCounters } from "./counters.ts";
import type { CounterRow, Fact, OperationalWindow } from "../../shared/health-protocol.mjs";

export const TEST_INSTALLATION = "a".repeat(32);
let cursor = 0;
const realNow = () => Math.ceil(performance.timeOrigin + performance.now());
const nextNow = () => { cursor = Math.max(cursor + 60_000, realNow() + 60_000); return cursor; };

/** A new producer epoch with everything recorded before it dropped. */
export function freshServerCounters(): void {
  serverHealthCounters.startEpoch(TEST_INSTALLATION, serverHealthCounters.currentEpoch);
  cursor = 0;
  serverHealthCounters.flush(nextNow());
}
/** Everything recorded since the last drain, as published windows. */
export const drainServerWindows = (): OperationalWindow[] => serverHealthCounters.flush(nextNow());
export const rows = (windows: OperationalWindow[]): CounterRow[] => windows.flatMap(window => window.counters);
export const factsOf = <K extends Fact["kind"]>(windows: OperationalWindow[], kind: K): Extract<Fact, { kind: K }>[] =>
  windows.flatMap(window => window.facts).filter((fact): fact is Extract<Fact, { kind: K }> => fact.kind === kind);
/** The total of one (detector, code), optionally for one engine or source key. */
export function total(windows: OperationalWindow[], detector: string, code: string, filter: { engineKind?: string; sourceKey?: string } = {}): number {
  return rows(windows).filter(row => row.detector === detector && row.code === code
    && (filter.engineKind === undefined || row.engineKind === filter.engineKind)
    && (filter.sourceKey === undefined || row.sourceKey === filter.sourceKey)).reduce((sum, row) => sum + row.value, 0);
}
