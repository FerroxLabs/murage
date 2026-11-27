// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Test helper for lane I's migration kill harness (owner: lane I). Shared by the harness (migration-v2-kill.test.ts) and by the child
// process it kills (memv2-kill-child.ts): the reproducible id stream (KILLSUITE "Restart equality": reproducible IDs) and the list of
// tables lane C's revoke drain writes. Neutral names only; nothing here touches a profile.
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { DatabaseSync } from "node:sqlite";

/** Every id the product draws (records, sources, views, jobs, tombstones) comes from a per-fixture stream, so a killed run and its
 * no-kill twin of one seed are built with the SAME ids and their journals compare exactly. The ids stay hash-ordered (not
 * creation-ordered), as random ones are. Ids drawn inside a judge probe come from a second stream that never repeats, so a probe
 * cannot shift the ids of later migration work. */
export const IDS = { seed: 0, n: 0, probe: 0, inProbe: false, trace: [] as string[] };
// node:crypto is a builtin: its randomUUID export is replaced on the builtin's own exports object and the ESM bindings re-synced, so
// every server module's `import { randomUUID } from "node:crypto"` draws from the stream.
const nodeCrypto = createRequire(import.meta.url)("node:crypto") as typeof import("node:crypto");
const realUUID = nodeCrypto.randomUUID;
const uuidOf = (key: string) => { const h = createHash("sha256").update(key).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const streamUUID = (() => {
  // the caller's frame: only server/memory/ modules draw fixture data. An id drawn elsewhere (a per-connection log id in
  // server/database.ts, a once-per-process index id) is drawn a different number of times by a run that reopens the file or by the
  // first build of a process, so it comes from the side stream, like a probe's ids
  const caller = (new Error().stack?.split("\n")[2] ?? "").replace(/^.*[\\/]server[\\/]/, "").replace(/[?:)].*$/, "");
  if (IDS.inProbe || !caller.startsWith("memory/")) return uuidOf(`probe:${IDS.probe++}`);
  if (IDS.trace.length < 4000) IDS.trace.push(caller);
  return uuidOf(`seed:${IDS.seed}:${IDS.n++}`);
}) as typeof nodeCrypto.randomUUID;
export function useIdStream(on: boolean): void { nodeCrypto.randomUUID = on ? streamUUID : realUUID; syncBuiltinESMExports(); }

/** The tables lane C's drain writes (queue, frontier, reached, audience, holds, marks, receipts): a killed drain must leave every row as it was. */
export const DRAIN_TABLES = ["memory_revoke_jobs", "memory_revoke_frontier", "memory_revoke_reached", "memory_revoke_audience", "memory_deny_pending", "memory_deny_pending_scope",
  "memory_deny", "memory_deny_point", "memory_deny_object", "memory_deny_range", "memory_deny_session", "memory_disclosures"];

/** What the harness asks its child to do, and what the child reports at its cut (one line on stdout, then it parks until it is killed). */
export type ForcedKind = "begin" | "precommit" | "rollback" | "publish" | "fence" | "noprogress";
export interface ChildSpec { kind: "work" | "cursor" | "commit" | "drain" | "marker" | ForcedKind; now: number; seed: number; ids: number; drainAt: number; armed: boolean; retentionPage: number; unit?: "lap" | "due" }
export interface ChildReport { pid: number; committed?: { markers: string; content: string; step: string }; kind: "work" | "cursor" | "commit" | "stalled" | "drain" | "drain-miss" | "marker" | "marker-miss" | "forced-miss" | ForcedKind; task: string | null; inTransaction: boolean; wrote: number; ids: number; outcome?: { more: boolean; stalled?: string }; drainWrites?: number; stack: string[]; statements?: string[] }
export const PARKED = "MEMV2-PARKED ", OPENED = "MEMV2-OPENED ";

/** The runner's marker rows (every task's cursor), as one string: read by the child at its cut and by the harness's raw reader. */
export const markersOf = (db: DatabaseSync) => JSON.stringify(db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE id LIKE 'memory-v2:%' ORDER BY id").all());
/** Full content of the file: every row of every table of main (in rowid order, or by all columns for a table without one) and the
 * sequence counters, hashed per table. Sees an in-place UPDATE, which a row count and newest rowid do not (ASTRA c21dbca0b9). */
export function contentOf(db: DatabaseSync): string {
  const tables = db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name").all().map(t => String(t.name));
  const hashOf = (rows: unknown[]) => createHash("sha256").update(JSON.stringify(rows, (_k, v) => v instanceof Uint8Array ? Buffer.from(v).toString("base64") : typeof v === "bigint" ? v.toString() : v)).digest("hex").slice(0, 16);
  // integers read as BigInt (a 64-bit value does not fit a JS number); a WITHOUT ROWID table has no rowid: ordered by every column
  const all = (sql: string) => { const st = db.prepare(sql); st.setReadBigInts(true); return st.all(); };
  const rowsOf = (t: string) => {
    try { return all(`SELECT rowid AS _r, * FROM main."${t}" ORDER BY rowid`); }
    catch { const cols = db.prepare(`SELECT name FROM pragma_table_info(?, 'main')`).all(t).map(c => `"${String(c.name)}"`); return all(`SELECT * FROM main."${t}" ORDER BY ${cols.join(",")}`); }
  };
  return JSON.stringify([...tables.map(t => [t, hashOf(rowsOf(t))]), hashOf(all("SELECT name,seq FROM main.sqlite_sequence ORDER BY name"))]);
}
