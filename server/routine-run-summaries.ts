// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RoutineRun } from './routines.ts';

type Key = readonly number[];
function compare(a: Key, b: Key): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
class Node {
  left?: Node;
  right?: Node;
  height = 1;
  failures: number;
  allFailed: boolean;
  readonly key: Key;
  readonly run: RoutineRun;
  readonly failed: boolean;
  constructor(key: Key, run: RoutineRun, failed: boolean) {
    this.key = key; this.run = run; this.failed = failed;
    this.failures = failed ? 1 : 0;
    this.allFailed = failed;
  }
}
const height = (node?: Node) => node?.height ?? 0;
function refresh(node: Node): Node {
  node.height = 1 + Math.max(height(node.left), height(node.right));
  node.allFailed = node.failed && (node.left?.allFailed ?? true) && (node.right?.allFailed ?? true);
  node.failures = (node.right?.failures ?? 0) + ((node.right?.allFailed ?? true) && node.failed ? 1 + (node.left?.failures ?? 0) : 0);
  return node;
}
function left(node: Node): Node {
  const root = node.right!; node.right = root.left; root.left = refresh(node); return refresh(root);
}
function right(node: Node): Node {
  const root = node.left!; node.left = root.right; root.right = refresh(node); return refresh(root);
}
function balance(node: Node): Node {
  refresh(node);
  if (height(node.left) - height(node.right) > 1) {
    if (height(node.left!.right) > height(node.left!.left)) node.left = left(node.left!);
    return right(node);
  }
  if (height(node.right) - height(node.left) > 1) {
    if (height(node.right!.left) > height(node.right!.right)) node.right = right(node.right!);
    return left(node);
  }
  return node;
}
function insert(root: Node | undefined, node: Node): Node {
  if (!root) return node;
  if (compare(node.key, root.key) < 0) root.left = insert(root.left, node);
  else root.right = insert(root.right, node);
  return balance(root);
}
function remove(root: Node | undefined, key: Key): Node | undefined {
  if (!root) return;
  const order = compare(key, root.key);
  if (order < 0) root.left = remove(root.left, key);
  else if (order > 0) root.right = remove(root.right, key);
  else {
    if (!root.left) return root.right;
    if (!root.right) return root.left;
    let next = root.right; while (next.left) next = next.left;
    const replacement = new Node(next.key, next.run, next.failed);
    replacement.left = root.left; replacement.right = remove(root.right, next.key); root = replacement;
  }
  return balance(root);
}
class OrderedRuns {
  root?: Node;
  add(key: Key, run: RoutineRun, failed = false) { this.root = insert(this.root, new Node(key, run, failed)); }
  delete(key: Key) { this.root = remove(this.root, key); }
  latest(): RoutineRun | undefined { let node = this.root; while (node?.right) node = node.right; return node?.run; }
}
type Entry = { order: number; routine: string; owner: string; latest: Key; outcome?: Key; failed: boolean };
type Summary = { latest: OrderedRuns; outcomes: OrderedRuns; owners: Map<string, OrderedRuns> };

/** Retained runs are read once at load. Each insertion, removal or relevant field
 * transition changes AVL indexes in O(log n); listings never visit run history.
 * Snapshot keys keep deletion correct even after a tracked run has changed. */
export class RoutineRunSummaries {
  private entries = new Map<RoutineRun, Entry>();
  private routines = new Map<string, Summary>();
  private sequence = 0;
  reset(runs: readonly RoutineRun[]): void {
    this.entries.clear(); this.routines.clear(); this.sequence = 0;
    for (const run of runs) this.add(run);
  }
  add(run: RoutineRun): void {
    if (this.entries.has(run)) return;
    this.update(run, this.sequence++);
  }
  changed(run: RoutineRun): void {
    const entry = this.entries.get(run);
    if (entry) this.update(run, entry.order);
  }
  delete(run: RoutineRun): void {
    const entry = this.entries.get(run); if (!entry) return;
    const summary = this.routines.get(entry.routine)!;
    summary.latest.delete(entry.latest);
    if (entry.outcome) summary.outcomes.delete(entry.outcome);
    const owned = summary.owners.get(entry.owner)!; owned.delete(entry.latest);
    if (!owned.root) summary.owners.delete(entry.owner);
    if (!summary.latest.root) this.routines.delete(entry.routine);
    this.entries.delete(run);
  }
  private update(run: RoutineRun, order: number): void {
    const next: Entry = { order, routine: run.routineId, owner: run.watch?.ownerBotId ?? run.botId,
      latest: [run.scheduledFor, -order], failed: run.status === 'failed',
      ...(['failed', 'completed'].includes(run.status) ? { outcome: [run.finishedAt ?? run.createdAt, run.createdAt, -order] } : {}) };
    const old = this.entries.get(run);
    if (old && old.routine === next.routine && old.owner === next.owner && old.failed === next.failed
      && compare(old.latest, next.latest) === 0 && (old.outcome && next.outcome ? compare(old.outcome, next.outcome) === 0 : old.outcome === next.outcome)) return;
    this.delete(run);
    let summary = this.routines.get(next.routine);
    if (!summary) this.routines.set(next.routine, summary = { latest: new OrderedRuns(), outcomes: new OrderedRuns(), owners: new Map() });
    summary.latest.add(next.latest, run);
    if (next.outcome) summary.outcomes.add(next.outcome, run, next.failed);
    let owned = summary.owners.get(next.owner);
    if (!owned) summary.owners.set(next.owner, owned = new OrderedRuns());
    owned.add(next.latest, run);
    this.entries.set(run, next);
  }
  failures(routineId: string): number { return this.routines.get(routineId)?.outcomes.root?.failures ?? 0; }
  latest(routineId: string, ownerBotId?: string): RoutineRun | undefined {
    const summary = this.routines.get(routineId);
    return (ownerBotId === undefined ? summary?.latest : summary?.owners.get(ownerBotId))?.latest();
  }
}
