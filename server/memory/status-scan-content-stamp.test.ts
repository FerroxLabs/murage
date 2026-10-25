// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// SELF-OVERLOAD-105 item 4: the status scans (health, supplied, retention) skip a pass on a content stamp, not on every write. In 1.0.4 the
// write-time marker's commits (dozens a second while a revoke walks) moved writeStampOf every interval, so every pass re-read the whole
// store though no memory had changed.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import * as scan from "./status-scan.ts";

const S = scan as unknown as Record<string, any>;
function store(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE memory_meta(id INTEGER PRIMARY KEY, data_revision INTEGER NOT NULL DEFAULT 0); INSERT INTO memory_meta(id,data_revision) VALUES(1,0);
    CREATE TABLE memory_records(id TEXT, state TEXT, text TEXT);
    CREATE TABLE memory_deny_memory(kind TEXT, id TEXT, version INTEGER, revoke_id INTEGER);
    CREATE TABLE memory_revoke_frontier(revoke_id INTEGER, seq INTEGER, node TEXT);
    CREATE TABLE memory_lineage_lsn_meta(key TEXT PRIMARY KEY, value INTEGER); INSERT INTO memory_lineage_lsn_meta VALUES('deny_generation',1);`);
  return db;
}

it("fail-before: contentStampOf exists; a marker write leaves it, a content write moves it", () => {
  expect(typeof S.contentStampOf, "contentStampOf is exported").toBe("function");
  const db = store();
  const stamp = () => String(S.contentStampOf(db, ["memory_records"]));
  const s0 = stamp(), w0 = scan.writeStampOf(db);
  // what the marker writes every slice: deny marks, frontier rows
  db.exec("INSERT INTO memory_deny_memory VALUES('source','s1',0,7); INSERT INTO memory_revoke_frontier VALUES(7,1,'x'); DELETE FROM memory_revoke_frontier");
  expect(scan.writeStampOf(db), "every write moves the old stamp").not.toBe(w0);
  expect(stamp(), "a marker write leaves the content stamp").toBe(s0);
  // a new record: the scanned table grew
  db.exec("INSERT INTO memory_records VALUES('r1','active','t')");
  const s1 = stamp();
  expect(s1).not.toBe(s0);
  // a record's state changed: every content writer bumps data_revision (retention.ts transition)
  db.exec("UPDATE memory_records SET state='archived' WHERE id='r1'; UPDATE memory_meta SET data_revision=data_revision+1");
  const s2 = stamp();
  expect(s2).not.toBe(s1);
  // a revoke's phase ended (receipts and records it flipped): deny_generation moved
  db.exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'");
  expect(stamp()).not.toBe(s2);
});

it("a file without the meta rows or a table still stamps (absent reads as absent, never throws)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE memory_records(id TEXT)");
  expect(() => S.contentStampOf(db, ["memory_records", "memory_disclosures"])).not.toThrow();
  const before = String(S.contentStampOf(db, ["memory_records"]));
  db.exec("INSERT INTO memory_records VALUES('a')");
  expect(String(S.contentStampOf(db, ["memory_records"]))).not.toBe(before);
});

it("the three status scans stamp on content, none on every write", () => {
  const health = readFileSync(new URL("./health.ts", import.meta.url), "utf8"), retention = readFileSync(new URL("./retention.ts", import.meta.url), "utf8");
  expect(health).not.toMatch(/stamp:\s*writeStampOf/);
  expect(retention).not.toMatch(/stamp:\s*writeStampOf/);
  expect(health.match(/contentStampOf\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  expect(retention.match(/contentStampOf\(/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
});
