// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test tree only. A small in-memory model of the write-time lineage that S1 (lineage-write.ts) and S4 (deny-read.ts) implement, so the S2
// sinks can be tested for what they RECORD while the S0 stubs are live: a turn's parents, a Murage object's prefix carry from its writer's
// turn, and the read predicate's positional rule (a prefix carry from (thread, lsn) is withheld when a line of that thread before lsn is
// withheld, DESIGN-WRITETIME 1). It is not the real predicate: it answers only what these tests need, and it never answers "shown" for a
// ref it does not know how to judge.
import { memoryRefKey, type LineageReader, type LineageRef, type LineageVerdict, type MemoryRef, type TurnLineage } from "../lineage-types.ts";

type MutableTurn = TurnLineage & { parents: LineageRef[] };
export const fakeLineage = {
  /** Stored lines of each thread, in write order (lsn = position + 1). */
  lines: new Map<string, string[]>(),
  /** Running turns by thread. */
  turns: new Map<string, MutableTurn>(),
  /** Murage objects and records written in a turn: prefix carry and the turn's parents at the time. */
  records: new Map<string, { thread: string; lsn: number; parents: LineageRef[] }>(),
  /** Withheld lines (thread NUL message). */
  denied: new Set<string>(),
  /** Every addTurnParents call. */
  added: [] as Array<{ thread: string; refs: LineageRef[] }>,
  reset(): void { this.lines.clear(); this.turns.clear(); this.records.clear(); this.denied.clear(); this.added.length = 0; },
  /** A line is stored in a thread (an owner line, a bot reply). */
  write(threadId: string, messageId: string): void { const list = this.lines.get(threadId) ?? []; list.push(messageId); this.lines.set(threadId, list); },
  /** A turn starts on a thread: its lsn is the thread's next position. */
  open(threadId: string, turnId = `turn-${threadId}`): MutableTurn {
    const turn: MutableTurn = { threadId, turnId, turnLsn: (this.lines.get(threadId)?.length ?? 0) + 1, parents: [], denyGeneration: 1 };
    this.turns.set(threadId, turn);
    return turn;
  },
  /** The owner withholds, forgets or deletes a line. */
  deny(threadId: string, messageId: string): void { this.denied.add(`${threadId}\u0000${messageId}`); },
};

const prefixDenied = (threadId: string, headLsn: number) =>
  (fakeLineage.lines.get(threadId) ?? []).some((messageId, index) => index + 1 < headLsn && fakeLineage.denied.has(`${threadId}\u0000${messageId}`));

function refDenied(ref: LineageRef, depth = 0): boolean {
  if (depth > 8) return true;
  switch (ref.kind) {
    case "line": return fakeLineage.denied.has(`${ref.threadId}\u0000${ref.messageId}`);
    case "prefix": return prefixDenied(ref.threadId, ref.headLsn ?? Number.MAX_SAFE_INTEGER);
    case "memory": return recordDenied(ref.ref, depth + 1);
    default: return false;
  }
}
function recordDenied(ref: MemoryRef, depth = 0): boolean {
  const record = fakeLineage.records.get(memoryRefKey(ref));
  if (!record) return false;
  return prefixDenied(record.thread, record.lsn) || record.parents.some(parent => refDenied(parent, depth));
}

/** Overrides for lineage-write.ts (S1's names). */
export const fakeWrite = {
  currentTurnLineage: (threadId: string): TurnLineage | undefined => fakeLineage.turns.get(threadId),
  runningTurnFor: (threadId: string, _botId?: string): TurnLineage | undefined => fakeLineage.turns.get(threadId),
  addTurnParents: (turn: TurnLineage, refs: readonly LineageRef[]): void => {
    const running = fakeLineage.turns.get(turn.threadId);
    if (running === turn) running.parents.push(...refs);
    fakeLineage.added.push({ thread: turn.threadId, refs: [...refs] });
  },
  writeRecordLineage: (_tx: unknown, record: MemoryRef, turn: TurnLineage): void => {
    fakeLineage.records.set(memoryRefKey(record), { thread: turn.threadId, lsn: turn.turnLsn, parents: [...turn.parents] });
  },
  writeObjectLineage: (_tx: unknown, record: MemoryRef, refs: readonly LineageRef[]): void => {
    fakeLineage.records.set(memoryRefKey(record), { thread: "", lsn: 0, parents: [...refs] });
  },
};

/** Overrides for deny-read.ts (S4's names). */
export const fakeRead = {
  memoryLookup: (_db: unknown, refs: readonly MemoryRef[], _reader: LineageReader): Map<string, LineageVerdict> =>
    new Map(refs.map(ref => [memoryRefKey(ref), recordDenied(ref) ? { state: "withheld", reason: "deny-range" } : { state: "shown" }] as const)),
};
