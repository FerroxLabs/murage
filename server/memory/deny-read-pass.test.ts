// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { instrumentDatabase, IoBudget, ioBudget } from "../io-budget.ts";
import { closeDatabase, database } from "../database.ts";
import { assertMemoryAccess, inMemoryAccessPass } from "./policy.ts";
import { accessFor, freshDataDir, ROSTER } from "./testing/recall-fixture.ts";
import { denyReadMeter, memoryLookup, memoryLookupEachSource, resetDenyReadMeter } from "./deny-read.ts";
import { inEligibilityPass } from "./eligibility-pass.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture() {
  const f = new WritetimeFixture().message("thread", "message", "user")
    .source("source", "s-room", { thread: "thread", message: "message" }).record("record", 1, "s-room", ["source"]);
  cleanups.push(() => f.close());
  const stop = instrumentDatabase(f.db, new IoBudget());
  cleanups.push(stop);
  return f;
}
const refs = [{ kind: "record", id: "record", version: 1 }, { kind: "source", id: "source", version: 1 }] as const;
const lookup = (db: DatabaseSync) => memoryLookup(db, refs, CONTENT);

it("a pass reads each record, source, anchor and shared window once across repeated lookups and read snapshots", () => {
  const { db } = fixture();
  inEligibilityPass(db, () => {
    expect([...lookup(db).values()]).toEqual([{ state: "shown" }, { state: "shown" }]);
    resetDenyReadMeter();
    for (let i = 0; i < 5; i++) {
      db.exec("BEGIN");
      expect([...lookup(db).values()]).toEqual([{ state: "shown" }, { state: "shown" }]);
      db.exec("COMMIT");
    }
    expect(denyReadMeter().statements).toBe(0);
    // The reference path remains independent of the pass memo.
    expect(memoryLookupEachSource(db, refs, CONTENT)).toEqual(lookup(db));
    expect(denyReadMeter().statements).toBeGreaterThan(0);
  });
  resetDenyReadMeter(); lookup(db);
  expect(denyReadMeter().statements).toBeGreaterThan(0);
});

it.each([
  ["scope denial", "INSERT INTO memory_deny VALUES('scope','s-room',0,0)"],
  ["record tombstone", "INSERT INTO memory_tombstones(id,target_type,target_id,revision,epoch,reason,created_at) VALUES('tomb','record','record',1,0,'owner-forget',0)"],
  ["source deletion", "UPDATE memory_sources SET state='deleted' WHERE id='source'"],
  ["anchor change", "UPDATE messages SET json='{invalid' WHERE id='message'"],
  ["pending window", "INSERT INTO memory_deny_pending_scope VALUES('s-room',0,1)"],
])("%s invalidates the facts immediately, and rollback restores them", (_name, sql) => {
  const { db } = fixture();
  inEligibilityPass(db, () => {
    expect([...lookup(db).values()].every(v => v.state === "shown")).toBe(true);
    db.exec("BEGIN"); db.exec(sql);
    expect([...lookup(db).values()].some(v => v.state !== "shown")).toBe(true);
    db.exec("ROLLBACK");
    expect([...lookup(db).values()]).toEqual([{ state: "shown" }, { state: "shown" }]);
  });
});

it("foreign commits invalidate the same pass, including after ending a read snapshot", () => {
  const { db } = fixture();
  db.exec("PRAGMA journal_mode=WAL");
  const file = String(db.prepare("PRAGMA database_list").get()!.file), writer = new DatabaseSync(file);
  cleanups.push(() => writer.close());
  inEligibilityPass(db, () => {
    expect([...lookup(db).values()].every(v => v.state === "shown")).toBe(true);
    db.exec("BEGIN"); lookup(db);
    writer.exec("UPDATE memory_sources SET state='deleted' WHERE id='source'");
    db.exec("COMMIT");
    expect(lookup(db).get("source:source:1")).toEqual({ state: "withheld", reason: "tombstone" });
    writer.exec("UPDATE memory_sources SET state='active' WHERE id='source'");
    expect([...lookup(db).values()]).toEqual([{ state: "shown" }, { state: "shown" }]);
  });
});

function accessFixture() {
  freshDataDir("active");
  cleanups.push(closeDatabase);
  return accessFor();
}

it("repeated access checks poll foreign commits without repeating view and scope seeks", () => {
  const { access } = accessFixture(), scope = access.scopeIds[0]!;
  inMemoryAccessPass(() => {
    assertMemoryAccess(access, scope);
    const statements = (ioBudget as unknown as { statements: Map<string, { calls: number }> }).statements;
    statements.clear();
    for (let i = 0; i < 5; i++) assertMemoryAccess(access, scope);
    expect([...statements.values()].reduce((n, row) => n + row.calls, 0)).toBe(5);
  });
});

it.each([
  "UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1",
  "UPDATE memory_scope_bindings SET state='pending' WHERE id='memory-roster-policy'",
  "UPDATE memory_recall_views SET state='building'",
  "UPDATE memory_recall_views SET digest='changed'",
  "UPDATE memory_recall_views SET state='building'; DELETE FROM memory_recall_view_scopes; UPDATE memory_recall_views SET state='ready'",
])("cached access refuses a live change and sees its rollback: %s", sql => {
  const { access } = accessFixture(), db = database(), scope = access.scopeIds[0]!;
  inMemoryAccessPass(() => {
    expect(() => assertMemoryAccess(access, scope)).not.toThrow();
    db.exec("BEGIN"); db.exec(sql);
    expect(() => assertMemoryAccess(access, scope)).toThrow();
    db.exec("ROLLBACK");
    expect(() => assertMemoryAccess(access, scope)).not.toThrow();
  });
});

it("cached access still checks capability retirement on every call", () => {
  const { access, registry } = accessFixture();
  inMemoryAccessPass(() => {
    assertMemoryAccess(access);
    registry.begin(access.botId, access.threadId);
    expect(() => assertMemoryAccess(access)).toThrow("MEMORY_UNAUTHORIZED");
  });
});

it("foreign policy withdrawal ends cached access in the same pass", () => {
  const { access } = accessFixture(), db = database();
  const file = String(db.prepare("PRAGMA database_list").get()!.file), writer = new DatabaseSync(file);
  cleanups.push(() => writer.close());
  inMemoryAccessPass(() => {
    assertMemoryAccess(access);
    writer.exec("UPDATE memory_scope_bindings SET state='pending' WHERE id='memory-roster-policy'");
    expect(() => assertMemoryAccess(access)).toThrow();
  });
});

it("a roster revision invalidates cached access without any database write", () => {
  freshDataDir("active"); cleanups.push(closeDatabase);
  const roster = { ...ROSTER }, { access } = accessFor(roster);
  inMemoryAccessPass(() => {
    assertMemoryAccess(access);
    roster.memoryRosterRevision++;
    expect(() => assertMemoryAccess(access)).toThrow("MEMORY_SCOPE_DENIED");
    roster.memoryRosterRevision--;
    expect(() => assertMemoryAccess(access)).not.toThrow();
  });
});

it("an uninstrumented connection never retains rollback-sensitive facts", () => {
  const f = new WritetimeFixture().source("source", "s-room");
  cleanups.push(() => f.close());
  inEligibilityPass(f.db, () => {
    f.db.exec("BEGIN; UPDATE memory_sources SET state='deleted' WHERE id='source'");
    expect(lookup(f.db).get("source:source:1")?.state).toBe("withheld");
    f.db.exec("ROLLBACK");
    expect(lookup(f.db).get("source:source:1")?.state).toBe("shown");
  });
});

it("a failed partial write still invalidates remembered facts", () => {
  const { db } = fixture();
  inEligibilityPass(db, () => {
    expect([...lookup(db).values()].every(v => v.state === "shown")).toBe(true);
    expect(() => db.prepare("INSERT OR FAIL INTO memory_deny VALUES('scope','s-room',0,0),('scope','s-room',0,0)").run()).toThrow();
    expect([...lookup(db).values()].every(v => v.state === "withheld")).toBe(true);
  });
});

it("a prepared schema change with zero affected rows invalidates remembered facts", () => {
  const { db } = fixture();
  inEligibilityPass(db, () => {
    expect([...lookup(db).values()].every(v => v.state === "shown")).toBe(true);
    db.prepare("DELETE FROM memory_deny WHERE 0").run();
    expect(Number(db.prepare("DROP TABLE memory_deny").run().changes)).toBe(0);
    expect([...lookup(db).values()].every(v => v.state === "checking")).toBe(true);
  });
});
