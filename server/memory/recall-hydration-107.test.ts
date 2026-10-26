// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.7 memory-recall-hydration D1/D2 (docs/superpowers/specs/2026-10-26-memory-recall-hydration-107-design.md, failure list r2): a pending
// window holds a record or source version "checking" only when since <= the created lsn of THE VERSION READ (memory_record_lsn,
// memory_source_lsn); an unstamped version is bounded (records: lineage_upgrade_lsn; sources: the first source stamp). Before this the reader
// looked for a created_lsn COLUMN no schema has, so every record and source read "checking" under any non-audience window and recall came
// back empty. F1-F5, F8 and F10; F6 and F9 are in schema-v13-source-lsn.test.ts, F7 in recall-proof-allowance-107.test.ts.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { memoryLookup } from "./deny-read.ts";
import { memoryRefKey, PENDING_ALL_SCOPES, type MemoryRef } from "./lineage-types.ts";
import { plausiblyReadable, writetimeRecordRefusal } from "./readable.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });

const app = () => new WritetimeFixture(database());
/** The lsn counter: what the next stamp takes. */
const at = (f: WritetimeFixture, next: number) => f.db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(next);
const state = (f: WritetimeFixture, ref: MemoryRef) => memoryLookup(f.db, [ref], CONTENT).get(memoryRefKey(ref))?.state;
const record = (id: string, version?: number): MemoryRef => version === undefined ? { kind: "record", id } : { kind: "record", id, version };
const source = (id: string, version?: number): MemoryRef => version === undefined ? { kind: "source", id } : { kind: "source", id, version };
const stamp = (f: WritetimeFixture, table: "memory_record_lsn" | "memory_source_lsn", id: string) =>
  f.db.prepare(`SELECT created_lsn AS c FROM ${table} WHERE ${table === "memory_record_lsn" ? "id" : "source_id"}=?`).all(id).map(row => Number(row.c));
const unstamp = (f: WritetimeFixture, table: "memory_record_lsn" | "memory_source_lsn", id: string) =>
  f.db.prepare(`DELETE FROM ${table} WHERE ${table === "memory_record_lsn" ? "id" : "source_id"}=?`).run(id);
const closeWindow = (f: WritetimeFixture, revoke: number) => f.db.prepare("DELETE FROM memory_deny_pending_scope WHERE revoke_id=?").run(revoke);

it("F1 a record version stamped at or after a pending window's since stays checking until marked; one stamped before it is shown", () => {
  const f = app();
  at(f, 10); f.record("old", 1, "s-room");
  at(f, 15); f.record("edge", 1, "s-room");
  at(f, 20); f.record("new", 1, "s-room");
  expect(stamp(f, "memory_record_lsn", "old")).toEqual([10]);
  f.pendingScope("s-room", 15, 2);
  expect(state(f, record("old", 1))).toBe("shown");
  expect(state(f, record("edge", 1))).toBe("checking");
  expect(state(f, record("new", 1))).toBe("checking");
  // an unversioned ref reads its latest version's stamp, never the earliest's
  at(f, 12); f.record("v", 1, "s-room");
  at(f, 30); f.record("v", 2, "s-room");
  expect(state(f, record("v", 1))).toBe("shown");
  expect(state(f, record("v", 2))).toBe("checking");
  expect(state(f, record("v"))).toBe("checking");
  // marked: withheld; the window gone: what is not marked reads shown
  f.denyMemory("record", "new", 1, 2);
  expect(state(f, record("new", 1))).toBe("withheld");
  closeWindow(f, 2);
  expect(state(f, record("new", 1))).toBe("withheld");
  expect(state(f, record("edge", 1))).toBe("shown");
});

it("F2 an unstamped (pre-v10) record is bounded by lineage_upgrade_lsn: checking under a window whose since <= it, shown under a later one", () => {
  const f = app();
  at(f, 50); f.record("legacy", 1, "s-room"); unstamp(f, "memory_record_lsn", "legacy");
  f.meta("lineage_upgrade_lsn", 40);
  f.pendingScope("s-room", 40, 2);
  expect(state(f, record("legacy", 1))).toBe("checking");
  expect(state(f, record("legacy"))).toBe("checking");
  closeWindow(f, 2); f.pendingScope("s-room", 41, 3);
  expect(state(f, record("legacy", 1))).toBe("shown");
  expect(state(f, record("legacy"))).toBe("shown");
  // the '*' window counts for every scope, as Sean's legacy line revokes do
  closeWindow(f, 3); f.pendingScope(PENDING_ALL_SCOPES, 39, 4);
  expect(state(f, record("legacy", 1))).toBe("checking");
});

it("F3 a source revision stamped at or after since stays checking; an unstamped one under a window opened before the first stamp stays checking", () => {
  const f = app();
  at(f, 10); f.source("a", "s-room");
  at(f, 20); f.source("b", "s-room");
  expect(stamp(f, "memory_source_lsn", "b")).toEqual([20]);
  f.pendingScope("s-room", 15, 2);
  expect(state(f, source("a", 1))).toBe("shown");
  expect(state(f, source("a"))).toBe("shown");
  expect(state(f, source("b", 1))).toBe("checking");
  expect(state(f, source("b"))).toBe("checking");
  // a made before the migration: no row, bounded by the first stamp (20), so a window at 15 still holds it
  unstamp(f, "memory_source_lsn", "a");
  expect(state(f, source("a", 1))).toBe("checking");
  closeWindow(f, 2); f.pendingScope("s-room", 25, 3);
  expect(state(f, source("a", 1))).toBe("shown");
  expect(state(f, source("b", 1))).toBe("shown");
  // a later revision stamped after the window: the unversioned ref reads it
  at(f, 30);
  f.db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES('b',2,'h-b2','{\"text\":\"words\"}',0)").run();
  f.db.prepare("UPDATE memory_sources SET revision=2 WHERE id='b'").run();
  expect(state(f, source("b", 1))).toBe("shown");
  expect(state(f, source("b", 2))).toBe("checking");
  expect(state(f, source("b"))).toBe("checking");
});

it("F3 with no source stamp yet an unstamped source is bounded by the lsn counter now: checking under every window opened before it", () => {
  const f = app();
  at(f, 10); f.source("a", "s-room"); unstamp(f, "memory_source_lsn", "a");
  at(f, 40);
  f.pendingScope("s-room", 39, 2);
  expect(state(f, source("a", 1))).toBe("checking");
  closeWindow(f, 2); f.pendingScope("s-room", 41, 3);
  expect(state(f, source("a", 1))).toBe("shown");
});

it("F4 no lineage_upgrade_lsn key: an unstamped record is checking under any window and shown with none, as before", () => {
  const f = app();
  at(f, 10); f.record("legacy", 1, "s-room"); unstamp(f, "memory_record_lsn", "legacy");
  f.db.prepare("DELETE FROM memory_lineage_lsn_meta WHERE key='lineage_upgrade_lsn'").run();
  expect(state(f, record("legacy", 1))).toBe("shown");
  f.pendingScope("s-room", 1_000_000, 2);
  expect(state(f, record("legacy", 1))).toBe("checking");
  expect(state(f, record("legacy"))).toBe("checking");
});

it("F5 an audience-only revoke binds audience readers only, unchanged: the content judge skips its window, every non-owner keeps its marks", () => {
  const f = app();
  f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(7)").run();
  at(f, 20); f.record("m", 1, "s-room", [], { assertion: "owner-statement" });
  f.pendingScope("s-room", 10, 7);
  expect(state(f, record("m", 1))).toBe("shown");
  f.denyMemory("record", "m", 1, 7);
  expect(state(f, record("m", 1))).toBe("shown");
  expect([...plausiblyReadable([{ id: "m", version: 1 }], ["s-room"], "current", false)]).toEqual([]);
  expect([...plausiblyReadable([{ id: "m", version: 1 }], ["s-room"], "current", true)]).toEqual(["m:1"]);
  // a non-audience window over the same record still holds it
  f.pendingScope("s-room", 10, 8);
  expect(state(f, record("m", 1))).toBe("checking");
});

it("F8 a record stamped before since whose evidence cites a source revision stamped after it stays checking", () => {
  const f = app();
  at(f, 10); f.record("r", 1, "s-room");
  at(f, 20); f.source("s", "s-room");
  f.db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES('r',1,'s',1,0,3)").run();
  f.pendingScope("s-room", 15, 2);
  expect(state(f, record("r", 1))).toBe("shown");
  expect(state(f, source("s", 1))).toBe("checking");
  const evidence = [{ sourceId: "s", revision: 1, startByte: 0, endByte: 3 }];
  expect(() => writetimeRecordRefusal(f.db, { kind: "record", id: "r", version: 1, scopeId: "s-room" }, evidence)).toThrow("MEMORY_REPLAY_LIMIT");
  closeWindow(f, 2);
  expect(writetimeRecordRefusal(f.db, { kind: "record", id: "r", version: 1, scopeId: "s-room" }, evidence)).toBeUndefined();
});

it("F10 a pre-migration window holds unstamped sources until its job leaves the window, then they read shown; nothing withheld is ever shown", () => {
  const f = app();
  // made before the migration: no stamp; one of them forgotten (marked)
  at(f, 5); f.source("u", "s-room").source("w", "s-room");
  unstamp(f, "memory_source_lsn", "u"); unstamp(f, "memory_source_lsn", "w");
  f.denyMemory("source", "w", 0, 9);
  // a legacy '*' window opened before the migration, then the first stamp (the migration point)
  f.job(3, 30).pendingScope(PENDING_ALL_SCOPES, 30, 3);
  at(f, 40); f.source("n", "s-room");
  // a revoke opened after the migration
  at(f, 45); f.job(4, 45).pendingScope(PENDING_ALL_SCOPES, 45, 4);
  const all = () => ["u", "w", "n"].map(id => state(f, source(id, 1)));
  expect(all()).toEqual(["checking", "withheld", "checking"]);
  // the legacy job leaves the window (its rows go): only the post-migration window remains, and it covers only what was made after it
  closeWindow(f, 3);
  expect(all()).toEqual(["shown", "withheld", "shown"]);
  at(f, 50); f.source("later", "s-room");
  expect(state(f, source("later", 1))).toBe("checking");
  closeWindow(f, 4);
  expect(all()).toEqual(["shown", "withheld", "shown"]);
  expect(state(f, source("later", 1))).toBe("shown");
});
