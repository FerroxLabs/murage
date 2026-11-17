// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { instrumentDatabase, IoBudget } from "../io-budget.ts";
import { inEligibilityPass } from "./eligibility-pass.ts";
import { assertRecallView, recallContextKey } from "./recall-view.ts";

const view = { viewId: "view", generation: "generation", digest: "digest" };
const binding = { botId: "reader", threadId: "thread", humanPrincipal: { personId: "person", bindingId: "binding", revision: 1 }, notOwnerAudience: false };

function fixture() {
  const db = new DatabaseSync(":memory:"), budget = new IoBudget();
  db.exec(`CREATE TABLE memory_recall_views (view_id TEXT, generation TEXT, authority_epoch INTEGER, state TEXT, digest TEXT, scope_count INTEGER, watermark INTEGER);
    CREATE TABLE memory_recall_contexts (context_key TEXT, view_id TEXT, generation TEXT);
    CREATE TABLE memory_recall_epoch (id INTEGER PRIMARY KEY, epoch INTEGER, projection_floor INTEGER);
    CREATE TABLE memory_scope_bindings (id TEXT PRIMARY KEY, state TEXT);
    INSERT INTO memory_recall_views VALUES ('view','generation',1,'ready','digest',1,1);
    INSERT INTO memory_recall_epoch VALUES (1,1,1);
    INSERT INTO memory_scope_bindings VALUES ('memory-roster-policy','granted')`);
  db.prepare("INSERT INTO memory_recall_contexts VALUES (?,'view','generation')").run(recallContextKey(binding));
  const stop = instrumentDatabase(db, budget);
  return { db, budget, close: () => { stop(); db.close(); } };
}

it("recall-view validation reads all live fences in one statement", () => {
  const f = fixture();
  try {
    expect(() => assertRecallView(f.db, view, binding)).not.toThrow();
    const statements = (f.budget as unknown as { statements: Map<string, { calls: number }> }).statements;
    expect([...statements.values()].reduce((sum, row) => sum + row.calls, 0)).toBe(1);
    expect(() => assertRecallView(f.db, view)).not.toThrow();
  } finally { f.close(); }
});

it.each([
  ["missing view", "DELETE FROM memory_recall_views"],
  ["wrong generation", "UPDATE memory_recall_views SET generation='other'"],
  ["unready view", "UPDATE memory_recall_views SET state='building'"],
  ["changed digest", "UPDATE memory_recall_views SET digest='changed'"],
  ["empty scopes", "UPDATE memory_recall_views SET scope_count=0"],
  ["projection debt", "UPDATE memory_recall_epoch SET projection_floor=2"],
  ["missing authority", "DELETE FROM memory_recall_epoch"],
  ["changed authority", "UPDATE memory_recall_epoch SET epoch=2"],
  ["invalid authority", "UPDATE memory_recall_epoch SET epoch=1.5"],
  ["missing context", "DELETE FROM memory_recall_contexts"],
  ["wrong binding", "UPDATE memory_recall_contexts SET context_key='other'"],
  ["revoked policy", "UPDATE memory_scope_bindings SET state='pending'"],
])("%s refuses inside the same pass; rollback restores the live fences", (_name, sql) => {
  const f = fixture(), { db } = f;
  try {
    inEligibilityPass(db, () => {
      expect(() => assertRecallView(db, view, binding)).not.toThrow();
      db.exec("BEGIN");
      expect(() => assertRecallView(db, view, binding)).not.toThrow();
      db.exec(sql);
      expect(() => assertRecallView(db, view, binding)).toThrow("MEMORY_RECALL_UNAVAILABLE");
      db.exec("ROLLBACK");
      expect(() => assertRecallView(db, view, binding)).not.toThrow();
    });
  } finally { f.close(); }
});
