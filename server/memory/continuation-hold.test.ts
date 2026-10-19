// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Privacy path of the per-turn continuation check (disclosures.ts continuationMemoryRevoked, authority-epoch.ts): a session's receipts are
// judged once and kept; a later turn judges only the receipts written since, UNLESS something that could take a receipt away was written
// (the authority epoch), and then the whole session is judged again. A revoked, forgotten, tombstoned, archived, undone or policy-changed
// record must never be treated as still allowed. Fail closed: a missing trigger makes one of these tests fail.
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { afterEach as thawAfterEach, beforeEach as thawBeforeEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { authorityParts, authorityStamp, softChangedSince } from "./authority-epoch.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { captureSource } from "./capture.ts";
import { continuationMemoryRevoked, noteMemoryLookup, resetSessionHolds } from "./disclosures.ts";
import { forgetMemory } from "./forget.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { outputRootsFor, recordSessionRoots } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";
import { archiveMemoryRecord } from "./retention.ts";
import { reviewKeep, reviewUndo } from "./review.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
// 1.0.2: this test models a 1.0.1 file (legacy root-set rows) for the read-time judge, which still decides legacy data until S6.
thawBeforeEach(() => thawRootSetWritesForTest(true));
thawAfterEach(() => thawRootSetWritesForTest(false));

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("active"); reconcileMemoryRoster(roster); resetSessionHolds();
});

function access() {
  const registry = new InternalCapabilities(); registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
let counter = 0;
function newRecord(state: "active" | "candidate" = "active") {
  const text = `The alarm code is ${4800 + counter++}.`, sourceId = `message:older:m${counter}`;
  captureSource(database(), { id: sourceId, threadId: "older", messageId: `m${counter}`, kind: "text", speaker: "owner", outcome: "recorded", text });
  const record = saveMemoryCandidate(text, [{ sourceId, revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], `k${counter}`, access());
  database().prepare("UPDATE memory_records SET state=? WHERE id=?").run(state, record);
  return { record, sourceId };
}
const receipt = (id: string, records: Array<{ id: string; version: number }>, state = "delivered") =>
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'chat','engine','S',?,'[]','[]',(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,?,?)")
    .run(id, JSON.stringify(records), state, Date.now());
const sessionRow = () => recordSessionRoots("chat", "engine", "S", outputRootsFor(LineageAllowance.tool(1_000_000_000), []));
const check = (why?: { reason?: string }) => continuationMemoryRevoked(LineageAllowance.tool(), "chat", "engine", "S", access(), why);
function countStatements(match: (text: string) => boolean) {
  const db = database(), real = db.prepare.bind(db);
  let n = 0;
  (db as unknown as { prepare: unknown }).prepare = (text: string) => { if (match(text)) n++; return real(text); };
  return { get n() { return n; }, reset: () => { n = 0; }, restore: () => { (db as unknown as { prepare: unknown }).prepare = real; } };
}
const hydrations = (text: string) => text.startsWith("SELECT * FROM memory_records WHERE id=? AND version=? AND state='active'");

describe("a change between two turns is seen at the next one", () => {
  const cases: Array<[string, (c: { record: string; sourceId: string }) => void]> = [
    ["a receipt revoked", () => { database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='F1'").run(); }],
    ["the record forgotten", c => { forgetMemory(ownerMemoryTicket(), { kind: "record", id: c.record }); }],
    ["a tombstone on the record", c => { database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('t1','record',?,NULL,NULL,1,'forgotten',1)").run(c.record); }],
    ["the record archived", c => { archiveMemoryRecord(ownerMemoryTicket(), c.record, 1); }],
    ["a tombstone on its evidence source", c => { database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('t2','source',?,NULL,NULL,1,'forgotten',1)").run(c.sourceId); }],
    ["its evidence source retired", c => { database().prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(c.sourceId); }],
    // the SOFT kind of source write: a new revision. Not a hard change, but the session rests on this source through its record.
    ["its evidence source taking a new revision", c => { database().prepare("UPDATE memory_sources SET revision=revision+1, content_hash='changed' WHERE id=?").run(c.sourceId); }],
    ["the policy revision changed", () => { database().prepare("UPDATE memory_meta SET policy_revision=policy_revision+1").run(); }],
    ["the deletion epoch changed", () => { database().prepare("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1").run(); }],
    ["the record superseded away", c => { database().prepare("UPDATE memory_records SET state='superseded' WHERE id=?").run(c.record); }],
  ];
  for (const [name, change] of cases) {
    it(name, () => {
      const made = newRecord();
      receipt("F1", [{ id: made.record, version: 1 }]); sessionRow();
      expect(check()).toBe(false);
      expect(check()).toBe(false); // answered from the hold
      const noise = newRecord(); receipt("F2", [{ id: noise.record, version: 1 }]);
      expect(check()).toBe(false); // new receipts are judged on their own
      change(made);
      const why: { reason?: string } = {};
      expect(check(why), name).toBe(true);
    });
  }

  it("an undone keep: the record the session was shown is archived again", () => {
    const made = newRecord("candidate");
    const ticket = ownerMemoryTicket();
    expect(reviewKeep(ticket, roster, { actionId: "k1", id: made.record, version: 1 }).result.status).toBe("kept");
    receipt("F1", [{ id: made.record, version: 1 }]); sessionRow();
    expect(check()).toBe(false);
    expect(check()).toBe(false);
    expect(reviewUndo(ticket, roster, { actionId: "u1", keepActionId: "k1", id: made.record, version: 1 }).result.status).toBe("archived");
    expect(check()).toBe(true);
  });

  it("a record that joins the session later is judged when it joins, and a change to it after that is seen", () => {
    const first = newRecord(), later = newRecord();
    receipt("F1", [{ id: first.record, version: 1 }]); sessionRow();
    expect(check()).toBe(false);
    receipt("F2", [{ id: later.record, version: 1 }]);
    expect(check()).toBe(false);
    // a soft write to the source of the record that joined later
    database().prepare("UPDATE memory_sources SET revision=revision+1, content_hash='changed' WHERE id=?").run(later.sourceId);
    expect(check()).toBe(true);
  });

  it("a record that is withdrawn before the session's next receipt is judged is not let in", () => {
    const first = newRecord(), later = newRecord();
    receipt("F1", [{ id: first.record, version: 1 }]); sessionRow();
    expect(check()).toBe(false);
    database().prepare("UPDATE memory_records SET state='archived' WHERE id=?").run(later.record);
    receipt("F2", [{ id: later.record, version: 1 }]);
    expect(check()).toBe(true);
  });

  it("a receipt written before the session's newest one but bound to the session only later is judged too", () => {
    const first = newRecord(), bound = newRecord();
    // F0 is written first and not yet in the session; F1 is the session's newest
    database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('F0','chat','engine',NULL,?,'[]','[]',(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',1)").run(JSON.stringify([{ id: bound.record, version: 1 }]));
    receipt("F1", [{ id: first.record, version: 1 }]); sessionRow();
    expect(check()).toBe(false);
    database().prepare("UPDATE memory_records SET state='archived' WHERE id=?").run(bound.record);
    database().prepare("UPDATE memory_disclosures SET native_session='S' WHERE bundle_id='F0'").run();
    // F0 has a lower rowid than F1, which is already in the session: binding it is a hard change
    expect(check()).toBe(true);
  });
});

describe("a direct write to each covered table moves the epoch", () => {
  const cases: Array<[string, string]> = [
    ["records: state", "UPDATE memory_records SET state='archived'"],
    ["records: owner pin", "UPDATE memory_records SET owner_pinned=1"],
    ["records: delete", "DELETE FROM memory_records"],
    ["sources: retired", "UPDATE memory_sources SET state='retired'"],
    ["sources: deleted", "UPDATE memory_sources SET state='deleted'"],
    ["sources: delete", "DELETE FROM memory_sources"],
    ["source versions: revision", "UPDATE memory_source_versions SET revision=revision+5"],
    ["source versions: delete", "DELETE FROM memory_source_versions"],
    ["evidence: update", "UPDATE memory_evidence SET end_byte=end_byte+1"],
    ["evidence: delete", "DELETE FROM memory_evidence"],
    ["derivations: update", "UPDATE memory_derivations SET child_version=child_version"],
    ["derivations: delete", "DELETE FROM memory_derivations"],
    ["tombstones: insert", "INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('tx','record','x',NULL,NULL,1,'r',1)"],
    ["tombstones: update", "UPDATE memory_tombstones SET reason='r2'"],
    ["tombstones: delete", "DELETE FROM memory_tombstones"],
    ["record details: partition", "UPDATE memory_record_details SET partition='identity'"],
    ["record details: delete", "DELETE FROM memory_record_details"],
    ["scopes: update", "UPDATE memory_scopes SET revision=revision+1"],
    ["bindings: insert", "INSERT INTO memory_scope_bindings VALUES('human-thread:t',(SELECT id FROM memory_scopes LIMIT 1),'human-thread','t',1,'granted','{}')"],
    ["bindings: update", "UPDATE memory_scope_bindings SET state='revoked' WHERE subject_type!='system'"],
    ["bindings: delete", "DELETE FROM memory_scope_bindings WHERE subject_type!='system'"],
    ["disclosures: revoke", "UPDATE memory_disclosures SET state='revoked'"],
    ["disclosures: contents", "UPDATE memory_disclosures SET record_versions='[]'"],
    ["disclosures: policy", "UPDATE memory_disclosures SET policy_revision=policy_revision+1"],
    ["disclosures: delete", "DELETE FROM memory_disclosures"],
    ["disclosure outputs: update", "UPDATE memory_disclosure_outputs SET message_id='z'"],
    ["disclosure outputs: delete", "DELETE FROM memory_disclosure_outputs"],
    ["output roots: update", "UPDATE memory_output_roots SET set_id='z'"],
    ["output roots: delete", "DELETE FROM memory_output_roots"],
    ["lineage meta: update", "UPDATE memory_lineage_meta SET since=since+1"],
    ["meta: policy", "UPDATE memory_meta SET policy_revision=policy_revision+1"],
    ["meta: deletion epoch", "UPDATE memory_meta SET deletion_epoch=deletion_epoch+1"],
    ["meta: mode", "UPDATE memory_meta SET mode='off'"],
  ];
  for (const [name, sql] of cases) {
    it(name, () => {
      const made = newRecord(), other = newRecord();
      receipt("F1", [{ id: made.record, version: 1 }]); sessionRow();
      const db = database();
      db.exec("PRAGMA foreign_keys=OFF");
      db.prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES('human-thread:t0',(SELECT id FROM memory_scopes LIMIT 1),'human-thread','t0',1,'granted','{}')").run();
      db.prepare("INSERT OR IGNORE INTO memory_derivations VALUES(?,1,?,1)").run(made.record, other.record);
      db.prepare("INSERT OR IGNORE INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('t0','record','y',NULL,NULL,1,'r',1)").run();
      db.prepare("INSERT OR IGNORE INTO memory_disclosure_outputs VALUES('F1','chat','m1')").run();
      db.prepare("INSERT OR IGNORE INTO memory_output_roots VALUES('chat','m1','s1')").run();
      const before = authorityStamp(), hardBefore = authorityParts()!.hard;
      const result = db.prepare(sql).run();
      expect(Number(result.changes), `${sql} touched nothing`).toBeGreaterThan(0);
      expect(authorityStamp(), name).not.toBe(before);
      expect(authorityParts()!.hard, `${name} must be a hard change`).not.toBe(hardBefore);
    });
  }

  it("a source taking a new revision moves the epoch, softly and with its id logged", () => {
    const made = newRecord();
    const before = authorityParts()!;
    database().prepare("UPDATE memory_sources SET revision=revision+1, content_hash='c2' WHERE id=?").run(made.sourceId);
    const after = authorityParts()!;
    expect(after.stamp).not.toBe(before.stamp);
    expect(after.hard).toBe(before.hard);
    expect([...softChangedSince(before.seq)!]).toEqual([made.sourceId]);
  });

  it("a lookup companion replaced by its grown successor is soft; a receipt deleted any other way is hard", () => {
    const made = newRecord(), second = newRecord();
    receipt("F1", [{ id: made.record, version: 1 }]);
    expect(noteMemoryLookup("F1", "F1:lookup", [{ id: made.record, version: 1, evidence: [] }], [])).toBe(true);
    const before = authorityParts()!;
    expect(noteMemoryLookup("F1", "F1:lookup", [{ id: second.record, version: 1, evidence: [] }], [])).toBe(true);
    expect(authorityParts()!.hard).toBe(before.hard);
    const mid = authorityParts()!;
    database().prepare("DELETE FROM memory_disclosures WHERE bundle_id='F1:lookup'").run();
    expect(authorityParts()!.hard).not.toBe(mid.hard);
  });

  it("nothing is cached inside a transaction", () => {
    transaction(() => { expect(authorityParts()).toBeUndefined(); });
  });
});

describe("a session's turns judge only what is new", () => {
  it("an unrelated source's new revision and a new receipt cost one record each, however long the session", () => {
    const stable = Array.from({ length: 30 }, () => newRecord());
    const unrelated = newRecord();
    receipt("F0", stable.map(made => ({ id: made.record, version: 1 })));
    sessionRow();
    const spy = countStatements(hydrations);
    try {
      expect(check()).toBe(false);
      expect(spy.n).toBe(30);
      const perTurn: number[] = [];
      for (let turn = 1; turn <= 500; turn++) {
        database().prepare("UPDATE memory_sources SET revision=revision+1, content_hash=? WHERE id=?").run(`h${turn}`, unrelated.sourceId);
        receipt(`F${turn}`, [{ id: stable[turn % 30]!.record, version: 1 }]);
        spy.reset();
        expect(check(), `turn ${turn}`).toBe(false);
        perTurn[turn] = spy.n;
      }
      // the record each new receipt cites was already judged: no turn hydrates anything again
      expect(Math.max(...perTurn.slice(1))).toBe(0);
      // and still sees a withdrawal deep in the session
      const victim = stable[7]!;
      database().prepare("UPDATE memory_records SET state='archived' WHERE id=?").run(victim.record);
      expect(check()).toBe(true);
    } finally { spy.restore(); }
  });

  it("turn 495 does the same work as turn 100 when every turn cites one new record", () => {
    const first = newRecord();
    receipt("F0", [{ id: first.record, version: 1 }]); sessionRow();
    const spy = countStatements(hydrations);
    const work: Record<number, number> = {};
    try {
      for (let turn = 1; turn <= 495; turn++) {
        const made = newRecord();
        receipt(`F${turn}`, [{ id: made.record, version: 1 }]);
        spy.reset();
        expect(check()).toBe(false);
        work[turn] = spy.n;
      }
    } finally { spy.restore(); }
    expect(work[100]).toBe(1);
    expect(work[495]!).toBeLessThanOrEqual(work[100]! * 1.3);
  });
});
