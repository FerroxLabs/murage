// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The proof the write-time differential asks of a range-based withhold (testing/range-proof.ts): it must tell a PROVEN positional withhold from a
// counted over-withhold and from an unproven one, or "0 unproven at default scale" would only mean the proof says yes to everything.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { rangeProof } from "./testing/range-proof.ts";

/** A thread "t": o0 -> b1 -> o2 -> b3 -> o4 -> b5 (a chain), plus b9 a reply on a branch (its parent is o0). `at` = index * 10. Lines have
 * lsn = index, a reply's turn_lsn = the owner line before it. */
function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE messages(thread_id TEXT, id TEXT, at INTEGER, role TEXT, kind TEXT, text TEXT, json TEXT, PRIMARY KEY(thread_id,id));
    CREATE TABLE turn_first(thread_id TEXT, turn_id TEXT, first_rowid INTEGER);
    CREATE TABLE memory_thread_no(thread_id TEXT PRIMARY KEY, no INTEGER);
    CREATE TABLE memory_line_lineage(thread_no INTEGER, lsn INTEGER, message_id TEXT, turn_lsn INTEGER);
    CREATE TABLE memory_deny_range(thread_id TEXT, from_lsn INTEGER, until_turn_lsn INTEGER, revoke_id INTEGER, reason TEXT);
    CREATE TABLE memory_tombstones(target_id TEXT, created_at REAL);`);
  db.prepare("INSERT INTO memory_thread_no VALUES('t',1)").run();
  const lines: Array<[string, string, string | null, number | null]> = [["o0", "user", null, null], ["b1", "bot", "o0", 0], ["o2", "user", "b1", null], ["b3", "bot", "o2", 2], ["o4", "user", "b3", null], ["b5", "bot", "o4", 4], ["b9", "bot", "o0", 0]];
  lines.forEach(([id, role, parent, turn], index) => {
    const at = id === "b9" ? 60 : index * 10;
    const info = db.prepare("INSERT INTO messages VALUES('t',?,?,?,'text','',?)").run(id, at, role, JSON.stringify({ ...(parent ? { parentId: parent } : {}), ...(turn !== null ? { turnId: `turn${turn}` } : {}) }));
    if (role === "user") db.prepare("INSERT INTO turn_first VALUES('t',?,?)").run(`turn${index}`, Number(info.lastInsertRowid));
    db.prepare("INSERT INTO memory_line_lineage VALUES(1,?,?,?)").run(index, id, turn);
  });
  return db;
}
const range = (db: DatabaseSync, from: number, until: number, revoke = 1, reason = "forget") => db.prepare("INSERT INTO memory_deny_range VALUES('t',?,?,?,?)").run(from, until, revoke, reason);

describe("rangeProof", () => {
  it("a line below the forgotten one's descendants is positional: the forgotten line is on its chain", () => {
    const db = fixture();
    range(db, 1, 99); // forgotten b1
    expect(rangeProof(db).proveRange("t", "b3")).toBe("positional");
    expect(rangeProof(db).proveRange("t", "b5")).toBe("positional");
  });

  it("a reply on another branch is a counted over-withhold: the forgotten line is not on its chain", () => {
    const db = fixture();
    range(db, 1, 99);
    expect(rangeProof(db).proveRange("t", "b9")).toBe("positional-branch");
  });

  it("a range bounded by a forget's time proves a line only if its turn may have begun before the forget", () => {
    const db = fixture();
    range(db, 1, 99, 1, "forget:until");
    db.prepare("INSERT INTO memory_tombstones VALUES('message:t:b1',25)").run(); // b3 (at 30) answers o2 (at 20): begun before; b5 (at 50) answers o4 (at 40): after
    expect(rangeProof(db).proveRange("t", "b3")).toBe("positional");
    expect(rangeProof(db).proveRange("t", "b5")).toBeNull(); // a range that withholds it anyway is unproven, and blocks the gate
  });

  it("a coalesced row is counted; a range that starts at no row is counted only when the thread has a line without one", () => {
    const db = fixture();
    range(db, 1, 99, -1, "coalesced");
    expect(rangeProof(db).proveRange("t", "b5")).toBe("range-coalesced");
    const other = fixture();
    range(other, -9007199254740991, 99);
    expect(rangeProof(other).proveRange("t", "b5")).toBeNull(); // every line has its row: nothing explains a range with no origin
    other.prepare("INSERT INTO messages VALUES('t','ghost',70,'bot','text','','{}')").run();
    expect(rangeProof(other).proveRange("t", "b5")).toBe("range-unplaced");
  });

  it("a line no range covers has no proof", () => {
    const db = fixture();
    range(db, 3, 5); // only turns before lsn 5, after b3
    expect(rangeProof(db).proveRange("t", "b1")).toBeNull();
    expect(rangeProof(db).proveRange("t", "o4")).toBeNull();
  });
});
