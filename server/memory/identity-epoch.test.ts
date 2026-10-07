// At startup a backlog of ordinary memory jobs writes records, details and
// evidence constantly. The identity set must survive those writes (the live
// store paid 158 s in three minutes rescanning it), and must still be rebuilt
// by any write that can change which sources an identity record cites.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { captureSource } from "./capture.ts";
import { setMemoryMode } from "./repository.ts";
import { identityScanCount, identitySourceSet } from "./provenance-stamp.ts";

beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); scopeId = ""; captured.clear();
});
let scopeId = "";
function scope(): string {
  if (scopeId) return scopeId;
  transaction(db => captureSource(db, { id: "source:seed", threadId: "t0", kind: "tool-outcome", speaker: "tool", outcome: "completed", text: "seed", action: { label: "fixture-check", reportedOutcome: "completed", verification: "tool-reported" } }));
  return scopeId = String(database().prepare("SELECT scope_id FROM memory_sources WHERE id='source:seed'").get()!.scope_id);
}
function record(id: string, kind: string, partition?: string) {
  const db = database(), s = scope();
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,'owner-statement','active',0,1,NULL,NULL,1)").run(id, s, kind, `text ${id}`);
  if (partition) db.prepare("INSERT INTO memory_record_details(record_id,record_version,partition,attention,claim_status) VALUES(?,1,?,'current','current') ON CONFLICT(record_id,record_version) DO UPDATE SET partition=excluded.partition").run(id, partition);
}
const captured = new Set<string>();
function evidence(id: string, source: string) {
  if (!captured.has(source)) {
    transaction(db => captureSource(db, { id: source, threadId: `t-${source}`, kind: "tool-outcome", speaker: "tool", outcome: "completed", text: `outcome ${source}`, action: { label: "fixture-check", reportedOutcome: "completed", verification: "tool-reported" } }));
    captured.add(source);
  }
  database().prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,1)").run(id, source);
}
const scansAfter = (write: () => void) => { identitySourceSet(database()); const before = identityScanCount(); write(); identitySourceSet(database()); return identityScanCount() - before; };

it("ordinary memory writes keep the identity set; identity writes rebuild it", () => {
  record("canon", "character-canon"); evidence("canon", "source:a");
  record("ident", "fact", "identity"); evidence("ident", "source:b");
  expect([...identitySourceSet(database())].sort()).toEqual(["source:a:1", "source:b:1"]);

  // The backlog shape: a hundred ordinary records with details and evidence.
  expect(scansAfter(() => { for (let i = 0; i < 100; i++) { record(`f${i}`, "fact", "semantic"); evidence(`f${i}`, `source:f${i}`); } })).toBe(0);
  database().prepare("UPDATE memory_records SET state='archived' WHERE id='f1'").run();
  database().prepare("DELETE FROM memory_evidence WHERE record_id='f2'").run();
  expect(scansAfter(() => {})).toBe(0);

  // Each of these can change the set, and each is seen at once.
  expect(scansAfter(() => evidence("canon", "source:c"))).toBe(1);
  expect(identitySourceSet(database()).has("source:c:1")).toBe(true);
  expect(scansAfter(() => database().prepare("DELETE FROM memory_evidence WHERE record_id='ident'").run())).toBe(1);
  expect(identitySourceSet(database()).has("source:b:1")).toBe(false);
  expect(scansAfter(() => database().prepare("UPDATE memory_record_details SET partition='identity' WHERE record_id='f3'").run())).toBe(1);
  expect(identitySourceSet(database()).has("source:f3:1")).toBe(true);
  expect(scansAfter(() => database().prepare("UPDATE memory_record_details SET partition='semantic' WHERE record_id='f3'").run())).toBe(1);
  expect(identitySourceSet(database()).has("source:f3:1")).toBe(false);
  expect(scansAfter(() => database().prepare("UPDATE memory_records SET kind='character-canon' WHERE id='f4'").run())).toBe(1);
  expect(identitySourceSet(database()).has("source:f4:1")).toBe(true);
  expect(scansAfter(() => { for (const sql of ["DELETE FROM memory_evidence WHERE record_id='canon'", "DELETE FROM memory_record_details WHERE record_id='canon'", "DELETE FROM memory_records WHERE id='canon'"]) database().prepare(sql).run(); })).toBe(1);
  expect(identitySourceSet(database()).has("source:a:1")).toBe(false);
});

it("checks inside separate transactions share one scan, and a rolled-back identity write never leaks into the set", () => {
  record("canon", "character-canon"); evidence("canon", "source:a");
  record("plain", "fact", "semantic"); evidence("plain", "source:p");
  transaction(() => {}); // the first transaction notes the committed counter
  const before = identityScanCount();
  for (let i = 0; i < 50; i++) transaction(db => { identitySourceSet(db); record(`job${i}`, "fact", "semantic"); });
  expect(identityScanCount() - before).toBeLessThanOrEqual(1);

  // An identity write inside a transaction is seen there, then undone by the rollback.
  expect(() => transaction(db => {
    database().prepare("UPDATE memory_record_details SET partition='identity' WHERE record_id='plain'").run();
    expect(identitySourceSet(db).has("source:p:1")).toBe(true);
    throw new Error("rollback");
  })).toThrow("rollback");
  expect(identitySourceSet(database()).has("source:p:1")).toBe(false);
  transaction(db => expect(identitySourceSet(db).has("source:p:1")).toBe(false));
  expect([...identitySourceSet(database())]).toEqual(["source:a:1"]);
});
