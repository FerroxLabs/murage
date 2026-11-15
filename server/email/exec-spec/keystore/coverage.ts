// Branch instrumentation and the coverage report. The branch recorder is a side channel for the checker only: the reducer's
// output never depends on it, so the reducer stays pure. `declareBranches` registers the ids a reducer can take; ids declared
// but never hit are the "reducer branches never taken" list.
import { EVENT_TYPES, MOVE_KINDS } from "./types.ts";

const declared = new Set<string>();
let hits = new Map<string, number>();
export const declareBranches = (ids: readonly string[]) => ids.forEach((i) => declared.add(i));
export const br = (id: string): void => { hits.set(id, (hits.get(id) ?? 0) + 1); };
export const resetBranchHits = () => { hits = new Map(); };
export const branchHits = () => new Map(hits);
export const declaredBranches = () => [...declared].sort();

export interface CoverageData {
  states: number; transitions: number; frontier: number; maxDepth: number;
  moves: Map<string, number>; events: Map<string, number>; branchHits: Map<string, number>; domain: string;
  /** r3.2e: transitions where an open STALLED take is CLOSED by the owner Reconnect (take intent -> reconnect intent, takeAuth dropped) */
  stalledCloses: number; stalledCloseStates: Set<string>;
}
export const newCoverage = (domain: string): CoverageData => ({ states: 0, transitions: 0, frontier: 0, maxDepth: 0, moves: new Map(), events: new Map(), branchHits: new Map(), domain, stalledCloses: 0, stalledCloseStates: new Set() });
export const tally = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export function coverageReport(c: CoverageData, declaredIds: readonly string[] = declaredBranches()) {
  const movesNever = MOVE_KINDS.filter((k) => !c.moves.has(k));
  const eventsNever = EVENT_TYPES.filter((e) => !c.events.has(e));
  const branchesNever = declaredIds.filter((b) => !c.branchHits.has(b));
  return { reachableStates: c.states, transitions: c.transitions, frontierStates: c.frontier, maxDepth: c.maxDepth, movesNever, eventsNever, branchesNever, branchesDeclared: declaredIds.length, branchesHit: declaredIds.length - branchesNever.length };
}
export function formatCoverage(c: CoverageData, declaredIds?: readonly string[]): string {
  const r = coverageReport(c, declaredIds);
  return [
    `stalled-take CLOSE: transitions=${c.stalledCloses} distinctSuccessorStates=${c.stalledCloseStates.size}`,
    `coverage [${c.domain}]: reachable states=${r.reachableStates} transitions=${r.transitions} frontier(unexpanded at depth bound)=${r.frontierStates} maxDepth=${r.maxDepth}`,
    `  moves never fired:    ${r.movesNever.join(", ") || "(none)"}`,
    `  events never fired:   ${r.eventsNever.join(", ") || "(none)"}`,
    `  reducer branches:     ${r.branchesHit}/${r.branchesDeclared} hit; never taken: ${r.branchesNever.join(", ") || "(none)"}`,
  ].join("\n");
}
