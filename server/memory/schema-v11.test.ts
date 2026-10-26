// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory schema 11 (1.0.3, SETTINGS-LANES L3): no table changes; learning settings move to v3 and this month's ledger is seeded from
// the day rows on the upgrade; 11 -> 10 maps them back, drops the month ledger and the per-slice counters, and leaves a file the
// 1.0.2 validator (the frozen v10 text) accepts with chats and memories intact.
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { MEMORY_SCHEMA_V10, MEMORY_SCHEMA_V11, MEMORY_SCHEMA_VERSION, downgradeMemorySchema, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { DEFAULT_MEMORY_LEARNING_V2, memoryLearningV2Schema, memoryLearningV3Schema } from "./learning-policy.ts";
import { DEFAULT_LEARNING_CEILING } from "../../shared/memory-learning-contract.ts";

const tz = process.env.TZ;
afterEach(() => { vi.useRealTimers(); if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));");
  migrateMemorySchema(db);
  return db;
}
const version = (db: DatabaseSync) => Number(db.prepare("SELECT schema_version FROM memory_meta").get()!.schema_version);
const settings = (db: DatabaseSync) => JSON.parse(String(db.prepare("SELECT settings FROM memory_learning_config").get()!.settings));
const scope = (db: DatabaseSync) => String(db.prepare("SELECT id FROM memory_scopes WHERE kind='workspace'").get()?.id ?? (db.exec("INSERT INTO memory_scopes VALUES('ws','workspace',(SELECT installation_id FROM memory_meta),'[]',0)"), "ws"));
const put = (db: DatabaseSync, id: string, subject: string, intent: object) =>
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent").run(id, scope(db), subject, JSON.stringify(intent));
const spend = (db: DatabaseSync, month: string) => { const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(`learning-spend:${month}`); return row ? JSON.parse(String(row.intent)) : undefined; };

it("v10-v11-fresh-install: a new file is v11 with v3 settings and no ledger row", () => {
  const db = open();
  try {
    expect(MEMORY_SCHEMA_VERSION).toBe(13);
    expect(version(db)).toBe(13);
    expect(memoryLearningV3Schema.parse(settings(db))).toMatchObject({ version: 3, ceiling: DEFAULT_LEARNING_CEILING, reviewMode: false });
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_id='learning-spend'").get()!.n)).toBe(0);
    expect(MEMORY_SCHEMA_V11).toBe(MEMORY_SCHEMA_V10.replace("CHECK(schema_version=10)", "CHECK(schema_version=11)"));
  } finally { db.close(); }
});

it("v11 -> v10 -> v11 round trip keeps every settings field, and a zero ceiling stays zero both ways", () => {
  const db = open();
  try {
    const custom = { ...settings(db), automaticFacts: false, reviewMode: true, callsPerMinute: 4, learnFrom: { chats: false, channels: true }, botsPaused: ["bot-a"], perCallOutputTokens: { extraction: 1500, grounding: 32, reflection: 4000 } };
    db.prepare("UPDATE memory_learning_config SET settings=?").run(JSON.stringify(custom));
    expect(downgradeMemorySchema(db, 10)).toEqual({ status: "downgraded", from: 13, to: 10 });
    expect(version(db)).toBe(10);
    expect(memoryLearningV2Schema.parse(settings(db))).toMatchObject({ version: 2, reviewMode: true, botsPaused: ["bot-a"], dailyInputTokens: DEFAULT_MEMORY_LEARNING_V2.dailyInputTokens });
    expect(downgradeMemorySchema(db, 10)).toMatchObject({ status: "already-v10" });
    migrateMemorySchema(db);
    expect(version(db)).toBe(13);
    expect(settings(db)).toEqual(custom);
    db.prepare("UPDATE memory_learning_config SET settings=json_set(settings,'$.ceiling',json('{\"input\":0,\"output\":0}'))").run();
    downgradeMemorySchema(db, 10);
    expect(settings(db)).toMatchObject({ dailyInputTokens: 0, dailyOutputTokens: 0 });
    migrateMemorySchema(db);
    expect(settings(db).ceiling).toEqual({ input: 0, output: 0 });
  } finally { db.close(); }
});

it("a v11 file stepped to 10 passes the 1.0.2 validator (frozen v10 text) with chats, memories and day rows intact; the month ledger and counters leave", () => {
  const db = open();
  try {
    db.exec("INSERT INTO messages VALUES('t','m',1,'user','text','a chat line','{}')");
    db.prepare("INSERT INTO memory_records VALUES('r1',1,?,'fact','Owner likes tea','owner-statement','active',0,1,NULL,NULL,1)").run(scope(db));
    put(db, "extract-budget:2026-10-05", "extract-budget", { input: 10, output: 2, minute: 1, calls: 1 });
    put(db, "learning-spend:2026-10", "learning-spend", { input: 10, output: 2 });
    put(db, "consolidation:a", "consolidation-pending", { jobId: "j", sourceId: "s", status: "deferred", reason: "spend-ceiling", retryAfter: 9e15, extractionAttempts: 2, sliceCalls: 5, skipped: [{ cursor: 0, length: 3, reason: "extraction-attempts", at: 1 }] });
    put(db, "consolidation:b", "consolidation", { jobId: "k", sourceId: "s2", status: "complete", sliceCalls: 0 });
    downgradeMemorySchema(db, 10);
    // the 1.0.2 validator: the v10 meta text and v2 settings
    expect(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_meta'").get()!.sql)).toContain("CHECK(schema_version=10)");
    expect(() => validateMemorySchema(db)).not.toThrow();
    expect(memoryLearningV2Schema.safeParse(settings(db)).success).toBe(true);
    expect(db.prepare("SELECT text FROM messages").get()!.text).toBe("a chat line");
    expect(db.prepare("SELECT text,state FROM memory_records WHERE id='r1'").get()).toEqual({ text: "Owner likes tea", state: "active" });
    expect(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='extract-budget:2026-10-05'").get()).toBeTruthy();
    expect(spend(db, "2026-10")).toBeUndefined();
    const a = JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='consolidation:a'").get()!.intent));
    const b = JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='consolidation:b'").get()!.intent));
    expect(a).toEqual({ jobId: "j", sourceId: "s", status: "deferred", reason: "spend-ceiling", retryAfter: expect.any(Number) });
    expect(a.retryAfter).toBeLessThanOrEqual(Date.now());
    expect(b).toEqual({ jobId: "k", sourceId: "s2", status: "complete" });
  } finally { db.close(); }
});

// Astra L3 r2: a state holding only the newer queue fields (parked, queueRevision) left the downgrade predicate unmatched and kept them.
it("downgrade-strips-every-v11-field: an intent holding only parked or queueRevision goes back to 1.0.2 without them", () => {
  const db = open();
  try {
    put(db, "consolidation:p", "consolidation-pending", { jobId: "j", sourceId: "s", status: "partial", parked: { extractionAttempts: 1, sliceCalls: 2 } });
    put(db, "consolidation:q", "consolidation", { jobId: "k", sourceId: "s2", status: "complete", queueRevision: 3 });
    downgradeMemorySchema(db, 10);
    const intent = (id: string) => JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent));
    expect(intent("consolidation:p")).toEqual({ jobId: "j", sourceId: "s", status: "partial" });
    expect(intent("consolidation:q")).toEqual({ jobId: "k", sourceId: "s2", status: "complete" });
  } finally { db.close(); }
});

it("v11 -> 6 chain steps through 10 and back up to 11", () => {
  const db = open();
  try {
    expect(downgradeMemorySchema(db, 6)).toEqual({ status: "downgraded", from: 13, to: 6 });
    expect(version(db)).toBe(6);
    expect(memoryLearningV2Schema.safeParse(settings(db)).success).toBe(true);
    migrateMemorySchema(db);
    expect(version(db)).toBe(13);
    expect(settings(db)).toMatchObject({ version: 3, ceiling: DEFAULT_LEARNING_CEILING });
  } finally { db.close(); }
});

it.each([
  ["Asia/Bangkok", new Date("2026-09-30T17:30:00Z"), { input: 300, output: 30 }],
  ["America/Los_Angeles", new Date("2026-10-01T07:30:00Z"), { input: 200, output: 20 }],
])("seed-from-daily-ledger at schema level (%s): the upgrade seeds this local month from the day rows", (zone, now, seeded) => {
  process.env.TZ = zone;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  const db = open();
  try {
    downgradeMemorySchema(db, 10);
    put(db, "extract-budget:2026-09-30", "extract-budget", { input: 100, output: 10 });
    put(db, "extract-budget:2026-10-01", "extract-budget", { input: 200, output: 20 });
    put(db, "extract-budget:2026-09-15", "extract-budget", { input: 999, output: 99 });
    migrateMemorySchema(db);
    expect(version(db)).toBe(13);
    expect(spend(db, "2026-10")).toEqual(seeded);
    // the day rows stay
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()!.n)).toBe(3);
  } finally { db.close(); }
});

it("zero-cap-upgrade at schema level: a v10 file with a zero daily cap comes up with a zero ceiling; other caps take the default", () => {
  const db = open();
  try {
    downgradeMemorySchema(db, 10);
    db.prepare("UPDATE memory_learning_config SET settings=json_set(settings,'$.dailyOutputTokens',0)").run();
    migrateMemorySchema(db);
    expect(settings(db).ceiling).toEqual({ input: 0, output: 0 });
    downgradeMemorySchema(db, 10);
    db.prepare("UPDATE memory_learning_config SET settings=json_set(settings,'$.dailyOutputTokens',123,'$.dailyInputTokens',456)").run();
    migrateMemorySchema(db);
    expect(settings(db).ceiling).toEqual(DEFAULT_LEARNING_CEILING);
  } finally { db.close(); }
});
