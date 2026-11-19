// SPDX-License-Identifier: AGPL-3.0-or-later
// The pack's snapshot (docs/designs/boot-tolerance/ACCEPTANCE.md) must fail when it cannot read a table: a hash of the error text would make two
// unreadable states equal and hide changed rows.
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { snapshot } from "./strict-fs.ts";

describe("the snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "murage-snapshot-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("is equal for equal data and differs when one row changes", () => {
    const dir = mkdtempSync(join(root, "ok-"));
    const db = new DatabaseSync(join(dir, "messages.db"));
    db.exec("CREATE TABLE a(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO a VALUES(1,'one'),(2,'two')"); db.close();
    const first = snapshot(dir);
    expect(snapshot(dir)).toEqual(first);
    const edit = new DatabaseSync(join(dir, "messages.db")); edit.exec("UPDATE a SET v='changed' WHERE id=2"); edit.close();
    expect(snapshot(dir)).not.toEqual(first);
  });

  it("hashes a 64-bit integer column, and sees it change", () => {
    const dir = mkdtempSync(join(root, "big-"));
    const db = new DatabaseSync(join(dir, "messages.db"));
    db.exec("CREATE TABLE h(id INTEGER PRIMARY KEY, hash INTEGER); INSERT INTO h VALUES(1, 7712357421526878255)"); db.close();
    const first = snapshot(dir);
    const edit = new DatabaseSync(join(dir, "messages.db")); edit.exec("UPDATE h SET hash=7712357421526878254"); edit.close();
    expect(snapshot(dir)).not.toEqual(first);
  });

  it("throws when a table's rows cannot be read", () => {
    const dir = mkdtempSync(join(root, "bad-"));
    const file = join(dir, "messages.db");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE a(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO a VALUES(1,'one'); CREATE TABLE b(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO b VALUES(1,'one')");
    const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
    const rootPage = Number((db.prepare("SELECT rootpage FROM sqlite_master WHERE name='b'").get() as { rootpage: number }).rootpage);
    db.close();
    // table b's only page overwritten: its rows are unreadable, the schema and table a are intact
    const fd = openSync(file, "r+"); try { writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, (rootPage - 1) * pageSize); } finally { closeSync(fd); }
    expect(() => snapshot(dir)).toThrow(/b/);
  });
});
