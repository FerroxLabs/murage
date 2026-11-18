// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The recall change log records only what the view reads: a receipt update that touches no view-visible column writes nothing, a lexical_status flip
// writes exactly one row (the consumer re-checks that record), and a record update that keeps its key writes one row, not an old/new pair.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateMemorySchema } from "./schema.ts";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  migrateMemorySchema(db, "active");
  db.exec("INSERT INTO memory_scopes VALUES('w','workspace','owner','[]',0)");
  db.exec("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES('r1',1,'w','fact','t','a','active',0,0)");
  db.exec("INSERT INTO memory_projection_receipts VALUES('r1',1,0,'pending','pending',NULL)");
  return db;
}
const mark = (db: DatabaseSync) => Number(db.prepare("SELECT COALESCE(max(sequence),0) n FROM memory_recall_changes").get()!.n);
const since = (db: DatabaseSync, at: number) => db.prepare("SELECT kind,object_id,version FROM memory_recall_changes WHERE sequence>? ORDER BY sequence").all(at);

describe("recall change log fan-out", () => {
  it("a receipt update that changes no view-visible column logs nothing", () => {
    const db = open(), at = mark(db);
    db.exec("UPDATE memory_projection_receipts SET embedding_status='indexed',error='x',index_generation=index_generation WHERE record_id='r1'");
    db.exec("UPDATE memory_projection_receipts SET lexical_status=lexical_status WHERE record_id='r1'");
    expect(since(db, at)).toEqual([]);
  });
  it("a lexical_status flip logs exactly one row for that record", () => {
    const db = open(), at = mark(db);
    db.exec("UPDATE memory_projection_receipts SET lexical_status='indexed' WHERE record_id='r1'");
    expect(since(db, at)).toEqual([{ kind: "record", object_id: "r1", version: 1 }]);
  });
  it("a receipt moved to another record logs both the old and the new record", () => {
    const db = open();
    db.exec("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES('r2',1,'w','fact','t','a','active',0,0)");
    const at = mark(db);
    db.exec("UPDATE memory_projection_receipts SET record_id='r2' WHERE record_id='r1'");
    expect(since(db, at)).toEqual([{ kind: "record", object_id: "r2", version: 1 }, { kind: "record", object_id: "r1", version: 1 }]);
  });
  it("a record update that keeps its key logs one row, a key change logs the old and the new key", () => {
    const db = open(), at = mark(db);
    db.exec("UPDATE memory_records SET state='archived' WHERE id='r1'");
    expect(since(db, at)).toEqual([{ kind: "record", object_id: "r1", version: 1 }]);
    const next = mark(db);
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("UPDATE memory_records SET version=2 WHERE id='r1'");
    expect(since(db, next)).toEqual([{ kind: "record", object_id: "r1", version: 1 }, { kind: "record", object_id: "r1", version: 2 }]);
  });
});
