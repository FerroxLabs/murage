// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: cause18e-overbudget (DATA_VERSION READS, MAIN 2026-11-21; ASTRA 2fe03224ca and memv2-G 79d6be37c8 class).
// The one way a memo, fence, stamp or cache reads SQLite's commit counter: the PRAGMA statement, on the connection that asks. The
// table-valued form (the pragma's name used as a table in a FROM clause, also when schema-qualified) resolves like any table name, so a table or view of that name
// shadows it: the "counter" is then a constant, and every memo keyed on it survives another connection's commit. A leaf module (node:sqlite
// types only), so the stamps of any layer can use it.
import type { DatabaseSync } from "node:sqlite";

export const DATA_VERSION_SQL = "PRAGMA data_version";
/** This connection's commit counter, or undefined when it cannot be read (the caller then keeps no memo: fail closed). */
export function dataVersion(db: DatabaseSync): number | undefined {
  const value = Number(db.prepare(DATA_VERSION_SQL).get()?.data_version);
  return Number.isFinite(value) ? value : undefined;
}
