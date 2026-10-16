// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { FORGOTTEN_PAGE_SQL, FORGOTTEN_PAGE_TOMBSTONES, forgottenMatcher, forgottenTextsAll, forgottenTextsReader } from "./event-log.ts";

function fixture(count: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE messages(thread_id TEXT, id TEXT, text TEXT, json TEXT, PRIMARY KEY(thread_id,id));
    CREATE TABLE memory_sources(id TEXT PRIMARY KEY, thread_id TEXT, message_id TEXT);
    CREATE TABLE memory_tombstones(id TEXT PRIMARY KEY, target_type TEXT, target_id TEXT, revision INTEGER, UNIQUE(target_type,target_id,revision));
    BEGIN`);
  const message = db.prepare("INSERT INTO messages VALUES(?,?,?,?)");
  const source = db.prepare("INSERT INTO memory_sources VALUES(?,?,?)");
  const tombstone = db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,1)");
  for (let i = 0; i < count; i++) {
    message.run("retained", `m${i}`, `forgotten text ${i}`, JSON.stringify({ turnId: `u${i}` }));
    source.run(`s${i}`, "former-thread", `m${i}`);
    tombstone.run(`t${i}`, `s${i}`);
  }
  db.exec("COMMIT");
  return db;
}

describe("forgotten lookup cost", () => {
  for (const count of [1000, 10000]) it(`${count} messages: each page reads at most 200 identities and 200 bodies, with no transcript index build`, () => {
    const db = fixture(count);
    try {
      const pageRows: number[][] = [];
      let current: number[] = [];
      const observed = { prepare(sql: string) {
        const statement = db.prepare(sql);
        return { all(...args: unknown[]) {
          const rows = statement.all(...args as Array<string | number>);
          current.push(rows.length);
          return rows;
        } };
      } };
      const next = forgottenTextsReader(observed);
      let found = 0;
      for (;;) {
        current = [];
        const page = next();
        found += page.items.length;
        pageRows.push(current);
        if (page.last === null) break;
      }
      expect(found).toBe(count);
      expect(Math.max(...pageRows.map(rows => rows.length))).toBe(2);
      expect(Math.max(...pageRows.flat())).toBe(FORGOTTEN_PAGE_TOMBSTONES);
      // One pass over tombstones, one over identities, one body read per matching message.
      expect(pageRows.flat().reduce((sum, rows) => sum + rows, 0)).toBe(3 * count);
      for (const [sql, args] of [
        [FORGOTTEN_PAGE_SQL.ids, [0, FORGOTTEN_PAGE_TOMBSTONES]],
        [FORGOTTEN_PAGE_SQL.messages, [0, FORGOTTEN_PAGE_TOMBSTONES]],
        [FORGOTTEN_PAGE_SQL.texts, ["[1,2,3]"]],
      ] as const) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => String(row.detail)).join(" | ");
        expect(plan).not.toMatch(/AUTOMATIC|SCAN (messages|memory_tombstones|s)\b/);
        expect(plan).toMatch(/INTEGER PRIMARY KEY/);
      }
    } finally { db.close(); }
  });

  it("preserves copied ids, missing source threads, repeated revisions, and compact matching of large escaped text", () => {
    const db = fixture(1);
    try {
      const text = "  \"quoted\"\n\\ " + "界".repeat(100_000) + "  ";
      db.prepare("UPDATE messages SET text=?, json=?").run(text, JSON.stringify({ turnId: "u0", extra: "x".repeat(1_000_000) }));
      db.exec("INSERT INTO messages SELECT 'copy',id,text,json FROM messages; INSERT INTO memory_tombstones VALUES('revision','source','s0',2)");
      const expected = forgottenTextsAll(db);
      const read = (compact: boolean) => {
        const next = forgottenTextsReader(db, compact), items = [];
        for (;;) { const page = next(); items.push(...page.items); if (page.last === null) return items; }
      };
      expect(read(false)).toEqual(expected);
      const compact = read(true);
      expect(compact).toHaveLength(2);
      expect(compact.every(item => !item.text && item.needle?.length === 160)).toBe(true);
      const oldMatch = forgottenMatcher(expected), newMatch = forgottenMatcher(compact);
      for (const line of [JSON.stringify({ turnId: "u0" }), JSON.stringify({ text }), JSON.stringify({ text: "keep this other text" })]) {
        expect(newMatch(line)).toBe(oldMatch(line));
      }
    } finally { db.close(); }
  });
});
