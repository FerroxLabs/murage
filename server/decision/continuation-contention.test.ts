// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { isDatabaseBusy } from "../db-busy.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { readContinuationRecord, saveContinuationRecord } from "./records.ts";

const fixtures: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); fixtures.splice(0).reverse().forEach(close => close()); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "continuation-contention-"));
  const path = join(dir, "fixture.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; CREATE TABLE decision_continuations(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const other = new DatabaseSync(path);
  other.exec("PRAGMA busy_timeout=0");
  fixtures.push(() => {
    if (other.isTransaction) other.exec("ROLLBACK");
    other.close(); db.close(); removeTempDirSync(dir);
  });
  return { db, other };
}

it("an unchanged continuation remains readable while another connection owns the writer", () => {
  const { db, other } = fixture();
  saveContinuationRecord(db, "fixture", "first");
  other.exec("BEGIN IMMEDIATE");
  expect(() => saveContinuationRecord(db, "fixture", "first")).not.toThrow();
  expect(readContinuationRecord(db, "fixture")).toBe("first");
  expect(db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(1000);
});

it("a new continuation has a bounded busy response and can be persisted after the lock clears", () => {
  const { db, other } = fixture();
  other.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  let failure: unknown;
  try { saveContinuationRecord(db, "fixture", "first"); } catch (error) { failure = error; }
  expect(performance.now() - started).toBeLessThan(750);
  expect(isDatabaseBusy(failure)).toBe(true);
  expect(readContinuationRecord(db, "fixture")).toBeUndefined();
  expect(db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(1000);
  other.exec("ROLLBACK");
  saveContinuationRecord(db, "fixture", "first");
  expect(readContinuationRecord(db, "fixture")).toBe("first");
});

it("a conflicting continuation stays a conflict under contention and preserves a stricter caller wait", () => {
  const { db, other } = fixture();
  saveContinuationRecord(db, "fixture", "first");
  db.exec("PRAGMA busy_timeout=10");
  other.exec("BEGIN IMMEDIATE");
  expect(() => saveContinuationRecord(db, "fixture", "second")).toThrow("continuation-conflict");
  expect(readContinuationRecord(db, "fixture")).toBe("first");
  expect(db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(10);
});

it("a competing first writer is rechecked before a continuation is accepted", () => {
  const { db, other } = fixture();
  const prepare = db.prepare.bind(db);
  let inserted = false;
  vi.spyOn(db, "prepare").mockImplementation(sql => {
    if (!inserted && sql.startsWith("INSERT INTO decision_continuations")) {
      inserted = true;
      other.prepare("INSERT INTO decision_continuations(key,value) VALUES(?,?)").run("fixture", "first");
    }
    return prepare(sql);
  });
  expect(() => saveContinuationRecord(db, "fixture", "second")).toThrow("continuation-conflict");
  expect(inserted).toBe(true);
  expect(readContinuationRecord(db, "fixture")).toBe("first");
  expect(db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(1000);
});
