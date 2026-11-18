// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { instrumentDatabase, IoBudget, writeStamp } from "./io-budget.ts";
import { inEligibilityPass, passLookup } from "./memory/eligibility-pass.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE policy (allowed INTEGER NOT NULL); INSERT INTO policy VALUES (1)");
  const stop = instrumentDatabase(db, new IoBudget());
  let reads = 0;
  const allowed = () => passLookup(db, "policy", () => {
    reads++;
    return Number(db.prepare("SELECT allowed FROM policy").get()!.allowed) === 1;
  });
  return { db, allowed, reads: () => reads, close: () => { stop(); db.close(); } };
}

it.each(["exec", "run", "get", "all", "iterate"] as const)("%s: read snapshots preserve the per-pass memo", method => {
  const f = fixture(), { db, allowed } = f;
  try {
    inEligibilityPass(db, () => {
      expect(allowed()).toBe(true);
      const stamp = writeStamp(db);
      for (const begin of ["BEGIN", "BEGIN;", "BEGIN TRANSACTION", "BEGIN DEFERRED", "BEGIN DEFERRED TRANSACTION;"]) {
        if (method === "exec") db.exec(begin);
        else if (method === "iterate") [...db.prepare(begin).iterate()];
        else db.prepare(begin)[method]();
        db.prepare("SELECT allowed FROM policy").get();
        db.exec("COMMIT");
        expect(allowed()).toBe(true);
      }
      expect(writeStamp(db)).toBe(stamp);
      expect(f.reads()).toBe(1);
    });
    inEligibilityPass(db, () => expect(allowed()).toBe(true));
    expect(f.reads()).toBe(2);
    expect(allowed()).toBe(true);
    expect(f.reads()).toBe(3);
  } finally { f.close(); }
});

it.each(["exec", "run", "get", "all", "iterate"] as const)("%s: an actual policy update in a deferred transaction forces a fresh refusal, and rollback restores access", method => {
  const f = fixture(), { db, allowed } = f;
  try {
    inEligibilityPass(db, () => {
      expect(allowed()).toBe(true);
      db.exec("BEGIN");
      const sql = "UPDATE policy SET allowed=0 RETURNING allowed";
      if (method === "exec") db.exec(sql);
      else if (method === "iterate") [...db.prepare(sql).iterate()];
      else db.prepare(sql)[method]();
      expect(allowed()).toBe(false);
      expect(f.reads()).toBe(2);
      if (method === "exec") db.exec("ROLLBACK");
      else db.prepare("ROLLBACK").run();
      expect(allowed()).toBe(true);
      expect(f.reads()).toBe(3);
    });
  } finally { f.close(); }
});

it("a write bundled with BEGIN still invalidates the memo", () => {
  const f = fixture(), { db, allowed } = f;
  try {
    inEligibilityPass(db, () => {
      expect(allowed()).toBe(true);
      db.exec("BEGIN; UPDATE policy SET allowed=0; COMMIT");
      expect(allowed()).toBe(false);
      expect(f.reads()).toBe(2);
    });
  } finally { f.close(); }
});
