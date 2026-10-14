// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A read that is told how many rows it must find and proves both ends: it asks for one row more than the declared size, so a set with fewer rows than it
// declares (missing) and a set with more (excess) are both seen by the same statement, at the cost of one extra row, never a second query or a count.
import type { StatementSync } from "node:sqlite";

export interface ExactRead<T> {
  /** At most `n` rows (the extra row that proves excess is not returned). */
  rows: T[];
  /** How many of the `n` rows were not there. */
  missing: number;
  /** A row exists beyond the `n`th. */
  excess: boolean;
}

/** Reads `n` rows with the statement (its last parameter is its LIMIT, supplied here as n + 1). */
export function readExact<T = Record<string, unknown>>(statement: Pick<StatementSync, "all">, args: readonly (string | number | null)[], n: number): ExactRead<T> {
  const found = statement.all(...args, n + 1) as T[];
  return { rows: found.length > n ? found.slice(0, n) : found, missing: Math.max(0, n - found.length), excess: found.length > n };
}

/** The refusal a read that reached its declared size throws when it found too few or too many rows: the set cannot be proven, so nothing rests on it. */
export function assertExact(read: { missing: number; excess: boolean }): void {
  if (read.missing > 0 || read.excess) throw new Error("MEMORY_ROOT_SET_UNPROVEN");
}
